import { celoscanTx } from '@trial/shared';
import type { Exhibit } from '@trial/shared';

export const DEFAULT_GATEWAY_PUBLIC = 'https://api.gateway.ethswarm.org';

export function bzzUrl(ref: string, gateway: string): string {
  return `${gateway}/bzz/${ref}/`;
}

/** The one link that best lets a person check an exhibit. */
export function exhibitHref(ex: Exhibit, gateway: string): { href: string; label: string } | null {
  if (ex.txHash) return { href: celoscanTx(ex.txHash), label: 'celoscan' };
  if (ex.gatewayUrl) return { href: ex.gatewayUrl, label: 'open' };
  if (ex.uri?.startsWith('bzz://')) return { href: bzzUrl(ex.uri.slice('bzz://'.length), gateway), label: 'swarm' };
  if (ex.uri && /^https?:\/\//.test(ex.uri)) return { href: ex.uri, label: 'open' };
  if (ex.url) return { href: ex.url, label: 'open' };
  return null;
}

/** The Swarm reference behind an exhibit and its gateway URL, when it has one. */
export function swarmTarget(ex: Exhibit, gateway: string): { ref: string; url: string } | null {
  const fromUri = ex.uri?.startsWith('bzz://') ? ex.uri.slice('bzz://'.length) : null;
  const fromGateway = ex.gatewayUrl?.match(/\/bzz\/([0-9a-fA-F]{64})/)?.[1] ?? null;
  const ref = fromUri ?? fromGateway;
  if (!ref) return null;
  return { ref, url: ex.gatewayUrl ?? bzzUrl(ref, gateway) };
}

export const COLUMN_TITLES: Record<string, string> = {
  A: 'Identity',
  B: 'Payments',
  C: 'Memory',
  D: 'Dispute',
  V: 'Verdict',
};
