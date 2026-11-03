import { createInterface } from 'node:readline/promises';
import { env } from './env.js';
import { log } from './log.js';

type Prompter = (question: string) => Promise<string>;

let prompter: Prompter | null = null;
let approveMode = env.approve;

/** The session REPL owns stdin; it hands its readline in so prompts do not fight. */
export function setPrompter(p: Prompter | null) {
  prompter = p;
}

export function setApproveMode(on: boolean) {
  approveMode = on;
}

export function approveModeOn() {
  return approveMode;
}

/** y/N from a person at a terminal, for the checks. No terminal, or input that ends unanswered, is a no. */
export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const closed = new Promise<string>((res) => rl.once('close', () => res('')));
  const answer = (await Promise.race([rl.question(question), closed])).trim().toLowerCase();
  rl.close();
  return answer === 'y' || answer === 'yes';
}

/**
 * Gate for anything that pays or writes to chain. Logs the intent either way;
 * asks y/N only in --approve mode. Returns false when the host declines.
 */
export async function approve(what: string): Promise<boolean> {
  if (!approveMode) {
    log.ops(`auto-approved: ${what}`);
    return true;
  }
  log.approve(`${what} — approve? [y/N]`);
  const ask: Prompter =
    prompter ??
    (async (q) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(q);
      } finally {
        rl.close();
      }
    });
  const answer = (await ask('> ')).trim().toLowerCase();
  const ok = answer === 'y' || answer === 'yes';
  log.approve(ok ? `approved: ${what}` : `declined: ${what}`);
  return ok;
}
