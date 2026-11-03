import { Bee, BeeResponseError, PrivateKey, Topic } from '@ethersphere/bee-js';
import { hashBytes } from '@trial/shared';
import { NotImplemented, type PutOptions, type StorageAdapter, type StoredRef } from './types.js';

/**
 * Swarm storage through bee-js.
 *
 * - put: bee.file.upload, a /bzz manifest, so bzz://<reference> opens at
 *   <gateway>/bzz/<reference>/. The hash is keccak256 of our bytes, computed here.
 * - get: bee.file.download.
 * - feeds: the feed of `topic`, signed with SWARM_FEED_PRIVATE_KEY, points at
 *   the reference of `uri`. feedUri is the feed manifest as bzz://, so one
 *   stable link always opens the latest content. Without the key, feeds throw
 *   NotImplemented and memory falls back to a local pointer.
 *
 * Env: BEE_API_URL (default public gateway), SWARM_POSTAGE_BATCH_ID (unset: the
 * zero batch, which the public gateway accepts), SWARM_GATEWAY_URL (for browser
 * links), SWARM_FEED_PRIVATE_KEY.
 *
 * Verify: pnpm check:storage
 */
const ZERO_BATCH = '0'.repeat(64);

/** The parts of bee-js this adapter calls. Tests pass a stub. */
export type BeeLike = Pick<Bee, 'file' | 'feed' | 'status'>;

export class SwarmStorage implements StorageAdapter {
  readonly name = 'swarm' as const;
  private readonly api: string;
  private readonly gateway: string;
  private readonly batch?: string;
  private readonly signer?: PrivateKey;
  private readonly bee: BeeLike;
  private readonly manifests = new Map<string, string>();

  constructor(env: NodeJS.ProcessEnv = process.env, bee?: BeeLike) {
    this.api = (env.BEE_API_URL ?? 'https://api.gateway.ethswarm.org').replace(/\/$/, '');
    this.gateway = (env.SWARM_GATEWAY_URL ?? this.api).replace(/\/$/, '');
    this.batch = env.SWARM_POSTAGE_BATCH_ID || undefined;
    this.signer = env.SWARM_FEED_PRIVATE_KEY ? new PrivateKey(env.SWARM_FEED_PRIVATE_KEY) : undefined;
    this.bee = bee ?? new Bee(this.api);
  }

  async put(content: Uint8Array | string, opts: PutOptions = {}): Promise<StoredRef> {
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const { reference } = await this.bee.file.upload(this.batch ?? ZERO_BATCH, bytes, opts.name, {
      contentType: opts.contentType ?? 'application/json',
    });
    const ref = reference.toHex();
    return {
      uri: `bzz://${ref}`,
      hash: hashBytes(bytes),
      gatewayUrl: `${this.gateway}/bzz/${ref}/`,
      bytes: bytes.length,
    };
  }

  async get(uri: string): Promise<Uint8Array> {
    const file = await this.bee.file.download(refOf(uri));
    return file.data.toUint8Array();
  }

  async feedUpdate(topic: string, uri: string): Promise<{ feedUri: string; gatewayUrl?: string }> {
    const signer = this.feedSigner();
    const batch = this.batch ?? ZERO_BATCH;
    await this.bee.feed.makeWriter(Topic.fromString(topic), signer).uploadReference(batch, refOf(uri));
    let manifest = this.manifests.get(topic);
    if (!manifest) {
      manifest = (await this.bee.feed.createManifest(batch, Topic.fromString(topic), signer.publicKey().address())).toHex();
      this.manifests.set(topic, manifest);
    }
    return { feedUri: `bzz://${manifest}`, gatewayUrl: `${this.gateway}/bzz/${manifest}/` };
  }

  async feedRead(topic: string): Promise<string | null> {
    const owner = this.feedSigner().publicKey().address();
    try {
      const { reference } = await this.bee.feed.makeReader(Topic.fromString(topic), owner).downloadReference();
      return `bzz://${reference.toHex()}`;
    } catch (err) {
      if (err instanceof BeeResponseError && err.status === 404) return null;
      if (/404|not found/i.test(String(err))) return null;
      throw err;
    }
  }

  async health() {
    const missing = [this.batch ? '' : 'no postage batch set', this.signer ? '' : 'no feed key: feeds off'].filter(Boolean);
    const note = missing.length ? ` (${missing.join(', ')})` : '';
    try {
      const h = await this.bee.status.getHealth();
      return { ok: h.status === 'ok', detail: `${this.api} ${h.status} bee ${h.version}${note}` };
    } catch (err) {
      // The public gateway answers /health with a plain "OK", which bee-js cannot parse.
      if (!(err instanceof SyntaxError)) return { ok: false, detail: `${this.api}: ${String(err).split('\n')[0]}` };
      const res = await fetch(`${this.api}/health`).catch(() => null);
      return { ok: Boolean(res?.ok), detail: `${this.api} ${res?.status ?? 'unreachable'} (gateway)${note}` };
    }
  }

  private feedSigner(): PrivateKey {
    if (!this.signer) throw new NotImplemented('Swarm feeds without SWARM_FEED_PRIVATE_KEY');
    return this.signer;
  }
}

export function refOf(uri: string): string {
  const m = uri.match(/^bzz:\/\/([0-9a-f]{64})\/?$/i);
  if (!m) throw new Error(`not a bzz:// reference: ${uri.slice(0, 40)}`);
  return m[1].toLowerCase();
}
