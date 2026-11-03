import 'dotenv/config';
import { hashBytes } from '@trial/shared';
import { getStorage, NotImplemented } from '../adapters/storage/index.js';

/**
 * pnpm check:storage          (STORAGE=local|swarm)
 *
 * Proves a storage adapter does what the chain needs: content-addressed
 * bytes that hash back to feedbackHash, readable through a gateway, and an
 * optional mutable head pointer.
 */
async function main() {
  const storage = getStorage();
  const rows: Array<[string, string]> = [['adapter', storage.name]];
  const fail = (what: string, detail: string) => {
    rows.push([what, `FAIL ${detail}`]);
    print(rows);
    process.exit(1);
  };

  const health = await storage.health();
  rows.push(['health', `${health.ok ? 'ok' : 'FAIL'} ${health.detail ?? ''}`]);
  if (!health.ok) fail('health', health.detail ?? '');

  const payload = JSON.stringify({ type: 'agent-on-trial/check', nonce: Math.random().toString(36).slice(2), at: new Date().toISOString() });
  const expected = hashBytes(payload);
  const ref = await storage.put(payload, { contentType: 'application/json', name: 'check.json' });
  rows.push(['put', `${ref.uri.slice(0, 48)}… (${ref.bytes} bytes)`]);
  if (ref.hash !== expected) fail('hash', `adapter says ${ref.hash}, keccak256 of the bytes is ${expected}`);
  rows.push(['hash', `ok ${ref.hash}`]);

  const back = new TextDecoder().decode(await storage.get(ref.uri));
  if (back !== payload) fail('get', 'bytes differ from what was put');
  rows.push(['get', 'ok, bytes identical']);

  if (ref.gatewayUrl) {
    const res = await fetch(ref.gatewayUrl);
    const text = await res.text();
    if (!res.ok || hashBytes(text) !== expected) fail('gateway', `${ref.gatewayUrl} → ${res.status}, hash ${hashBytes(text)}`);
    rows.push(['gateway', `ok ${ref.gatewayUrl}`]);
  } else {
    rows.push(['gateway', 'none (data: URI resolves in the browser)']);
  }

  try {
    const topic = `check-${Date.now()}`;
    const feed = await storage.feedUpdate(topic, ref.uri);
    const head = await storage.feedRead(topic);
    if (head !== ref.uri) fail('feed', `read back ${head}, expected ${ref.uri.slice(0, 32)}…`);
    rows.push(['feed', `ok ${feed.feedUri.slice(0, 64)}`]);
  } catch (err) {
    if (err instanceof NotImplemented) rows.push(['feed', 'not implemented (optional; the flow falls back to a local pointer)']);
    else fail('feed', String(err));
  }

  print(rows);
}

function print(rows: Array<[string, string]>) {
  const w = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) console.log(`${k.padEnd(w)}  ${v}`);
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
