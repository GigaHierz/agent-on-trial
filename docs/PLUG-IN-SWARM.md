# Plug in Swarm

Everything the agent needs to remember or prove goes through one interface. Swarm is one implementation of it; the default is a local one that produces the same hashes.

## What goes through it

| File | Written by | Ends up as |
|---|---|---|
| `memory.json` | the agent, after every step | `C` exhibits, referenced from feedback files |
| `feedback-*.json` | the witness, arbitrator, jury | `feedbackURI` + `feedbackHash` on chain |
| `receipt.json` | act 3 | `C` exhibit, referenced from `paid` feedback |
| `delivered.txt`, `dispute.json`, `ruling.json` | act 4 | `C` and `D` exhibits, referenced from `dispute` and `ruling` feedback |
| `verdict.json` | act 5 | `V` exhibit, referenced from `jury` feedback |

The chain holds the pointer and keccak256 of the bytes. Swarm holds the bytes. The courtroom's `/exhibit/<id>` fetches the bytes from the gateway, hashes them in the browser, and compares.

## The interface

`adapters/storage/types.ts`:

```ts
interface StoredRef { uri: string; hash: Hex; gatewayUrl?: string; bytes: number }

interface StorageAdapter {
  readonly name: 'local' | 'swarm';
  put(content: Uint8Array | string, opts?: { contentType?: string; name?: string }): Promise<StoredRef>;
  get(uri: string): Promise<Uint8Array>;      // must hash back to StoredRef.hash
  feedUpdate(topic: string, uri: string): Promise<{ feedUri: string; gatewayUrl?: string }>;
  feedRead(topic: string): Promise<string | null>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}
```

Rules:
- `put` is content addressed. `hash` is keccak256 of the exact bytes stored, which is what goes on chain.
- `uri` is what goes on chain as `feedbackURI`. For Swarm that is `bzz://<reference>`.
- `gatewayUrl` is what a browser opens.
- The adapter never signs anything on Celo. `lib/feedback.ts` does, with what you return.
- Feeds are optional. When `feedUpdate` throws `NotImplemented`, memory falls back to a local pointer file and the flow continues.

## What is there

`adapters/storage/swarm.ts` does it all with bee-js (`@ethersphere/bee-js`):
- `put`: `bee.file.upload` with the postage batch and `content-type`, a `/bzz` manifest. Returns `bzz://<reference>` and `$SWARM_GATEWAY_URL/bzz/<reference>/`. The hash is keccak256 of our bytes, computed locally.
- `get`: `bee.file.download`.
- `feedUpdate`: topic from `Topic.fromString(topic)`, signed with `SWARM_FEED_PRIVATE_KEY`; the feed update is the reference of `uri`. Returns the feed manifest as `bzz://` and its gateway URL, which always opens the latest content: the agent's memory head is one stable link per agent.
- `feedRead`: the latest reference as `bzz://`, or `null` for a feed never written.
- `health`: `bee.status.getHealth()`; the public gateway answers with a plain `OK`, which is accepted too.
- No `SWARM_POSTAGE_BATCH_ID`: uploads use the zero batch, which the public gateway accepts. No `SWARM_FEED_PRIVATE_KEY`: feeds throw `NotImplemented` and memory keeps a local pointer.

## What is open for you

1. **"Latest memory" in the courtroom.** The memory feed (`agent-memory-<agentId>`) has a stable `bzz://` manifest. Show it on `/projector` so the audience can open the agent's current memory without knowing the run.
2. **Swarm tools in the model's hands.** Storage calls bee-js from code, so the hashes stay right. If you want the audience to see the agent call Swarm, add a read-only tool (say, read its own memory feed) in `agent/tools/` and add its name to the acts in `agent/acts.ts`.
3. **What the audience sees.** The `/projector` board shows `C` exhibits with their gateway link. Add what makes Swarm legible: the postage batch, the node, the feed, how long the data lives.
4. **Identity on Swarm.** The registration file is served by the courtroom today. It could be a feed: `agentURI = bzz://<feed manifest>`, updated when the agent id is minted.

## Env

```
STORAGE=swarm
BEE_API_URL=http://localhost:1633          # or the public gateway
SWARM_POSTAGE_BATCH_ID=<batch id>          # required to upload on a node you run
SWARM_GATEWAY_URL=https://api.gateway.ethswarm.org
SWARM_FEED_PRIVATE_KEY=0x…                 # for feeds; any key, it never touches Celo
```

## Verify

```bash
STORAGE=swarm pnpm check:storage
```

It puts a random JSON file, asserts the returned hash equals keccak256 of the bytes, reads the bytes back, re-fetches through `gatewayUrl` and re-hashes, then updates and reads a feed. Exit 0 or a named failure. Then run a rehearsal: `pnpm rehearse` asserts every `feedbackURI` on chain fetches and hashes to its `feedbackHash`.
