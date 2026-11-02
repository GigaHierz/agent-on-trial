import type { LogLine } from '@trial/shared';
import { celoscanTx } from '@trial/shared';
import { env } from './env.js';
import { publish } from './publish.js';

/**
 * One structured line per event. Printed to the terminal and mirrored to the
 * courtroom's public live log. Secrets are redacted by key name before anything
 * leaves the process.
 */
const C = {
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  reset: '\x1b[0m',
};

/**
 * A stored reference for display: the gateway link when there is one, a
 * bzz:// reference in full, and only data: URIs (whole files inline) cut short.
 */
export function showUri(uri: string, gatewayUrl?: string): string {
  if (gatewayUrl) return gatewayUrl;
  if (uri.startsWith('data:')) return `${uri.slice(0, 48)}…`;
  return uri;
}

const SECRET_KEY =/(private|secret|api[_-]?key|authorization|token|password|mnemonic)/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1),
      ]),
    );
  }
  if (typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value) && depth === 0) return value;
  return value;
}

let queue: LogLine[] = [];
let timer: NodeJS.Timeout | null = null;
let round = env.round;

export function setLogRound(r: string) {
  round = r;
}

function enqueue(line: LogLine) {
  if (!publish.enabled()) return;
  queue.push(line);
  if (!timer) {
    timer = setTimeout(async () => {
      const batch = queue;
      queue = [];
      timer = null;
      await publish.log(round, batch);
    }, 400);
  }
}

/** Wait for the mirror to drain; call before a process exits. */
export async function flushLog() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (queue.length) {
    const batch = queue;
    queue = [];
    await publish.log(round, batch);
  }
}

function emit(kind: LogLine['kind'], text: string, data?: Record<string, unknown>) {
  const line: LogLine = { at: new Date().toISOString(), kind, text, ...(data ? { data: redact(data) as Record<string, unknown> } : {}) };
  const t = line.at.slice(11, 19);
  const prefix = `${C.dim}${t}${C.reset}`;
  switch (kind) {
    case 'host':
      console.log(`${prefix} ${C.bold}host${C.reset}  ${text}`);
      break;
    case 'agent':
      console.log(`${prefix} ${C.magenta}agent${C.reset} ${text}`);
      break;
    case 'tool_call':
      console.log(`${prefix} ${C.cyan}→ ${text}${C.reset}`);
      break;
    case 'tool_result':
      console.log(`${prefix} ${C.dim}← ${text}${C.reset}`);
      break;
    case 'tx':
      console.log(`${prefix} ${C.green}tx${C.reset}    ${text}`);
      break;
    case 'approve':
      console.log(`${prefix} ${C.yellow}?${C.reset}     ${text}`);
      break;
    case 'warn':
      console.log(`${prefix} ${C.yellow}warn${C.reset}  ${text}`);
      break;
    case 'error':
      console.log(`${prefix} ${C.red}error${C.reset} ${text}`);
      break;
    default:
      console.log(`${prefix} ${C.dim}info${C.reset}  ${text}`);
  }
  enqueue(line);
}

export const log = {
  host: (text: string) => emit('host', text),
  agent: (text: string) => emit('agent', text),
  toolCall: (name: string, args: unknown) => emit('tool_call', `${name}(${short(JSON.stringify(redact(args)))})`, { name, args }),
  toolResult: (name: string, result: unknown) => emit('tool_result', `${name}: ${short(typeof result === 'string' ? result : JSON.stringify(redact(result)))}`, { name }),
  tx: (label: string, hash: string, extra?: Record<string, unknown>) => emit('tx', `${label} ${celoscanTx(hash)}`, { hash, ...extra }),
  info: (text: string, data?: Record<string, unknown>) => emit('info', text, data),
  warn: (text: string, data?: Record<string, unknown>) => emit('warn', text, data),
  error: (text: string, data?: Record<string, unknown>) => emit('error', text, data),
  approve: (text: string) => emit('approve', text),
};

function short(s: string | undefined, max = 240): string {
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}… (${s.length} chars)` : s;
}
