import { closeSync, mkdirSync, openSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Run fn while holding `<path>.lock`, created exclusively, so a read-decide-write
 * of a small JSON file is atomic across processes. A lock older than staleMs
 * was left by a process that died: it is renamed away (one waiter wins the
 * rename) and taken. Hold it for a file read and write, never across a network call.
 */
export function withFileLock<T>(path: string, fn: () => T, staleMs = 10_000): T {
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  const started = Date.now();
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx'));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        const seen = statSync(lock);
        if (Date.now() - seen.mtimeMs > staleMs) {
          const away = `${lock}.${process.pid}.${Math.random().toString(36).slice(2)}`;
          renameSync(lock, away);
          // Moved a fresh lock that replaced the stale one meanwhile: put it back.
          if (statSync(away).ino !== seen.ino) renameSync(away, lock);
          else rmSync(away, { force: true });
          continue;
        }
      } catch {
        /* moved or released meanwhile */
      }
      if (Date.now() - started > staleMs + 5_000) throw new Error(`${lock} is held by another process`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

/**
 * Hold `<path>.lock` across an async fn: the lock withFileLock is not, for a step that waits on the
 * network. On-chain writes from one key take it, so two processes never pick the same nonce. A lock
 * older than staleMs is taken over, as above.
 */
export async function withAsyncFileLock<T>(path: string, fn: () => Promise<T>, staleMs = 5 * 60_000): Promise<T> {
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  const started = Date.now();
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx'));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        const seen = statSync(lock);
        if (Date.now() - seen.mtimeMs > staleMs) {
          const away = `${lock}.${process.pid}.${Math.random().toString(36).slice(2)}`;
          renameSync(lock, away);
          if (statSync(away).ino !== seen.ino) renameSync(away, lock);
          else rmSync(away, { force: true });
          continue;
        }
      } catch {
        /* moved or released meanwhile */
      }
      if (Date.now() - started > staleMs + 60_000) throw new Error(`${lock} is held by another process`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { force: true });
  }
}
