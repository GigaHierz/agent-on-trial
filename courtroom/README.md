# courtroom

The audience-facing web app for the talk "Can We Trust the Machines? A Live Trial".
A real agent runs in a terminal on stage. The terminal pushes evidence and a live log here.
The audience scans a QR, votes, and the verdict goes on chain as ERC-8004 feedback.

No private keys live in this app. It reads Celo, it never signs.

## Pages

| Path | Who | What |
| --- | --- | --- |
| `/` | public | Title, QR to the vote, links |
| `/live` | public | Live transcript of the run, tally bar |
| `/projector` | public | 1920x1080 evidence board: Identity, Payments, Memory, Dispute, verdict |
| `/vote` | public | Trust / Don't trust, one vote per device |
| `/exhibit/[id]` | public | One exhibit as JSON, with a Verify button |
| `/property/[runId]` | public | The page the agent reviews (Trial Weather, an x402 API for agents) |
| `/cross` | host | Ask the defendant, prosecutor or defense; answers cite exhibits |
| `/bench` | host | Round, vote open/close/reset, manual tally, closing statements |

Host pages take the secret from the `host` cookie. Visit `/bench?key=<HOST_SECRET>` once to set it, or use the form.

## Env

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | yes | | Injected by "Upstash for Redis" from the Vercel Marketplace |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | alternative | | A database made on upstash.com; either pair works |
| `HOST_SECRET` | yes | | Header `x-host-secret` (terminal) or cookie `host` (browser) |
| `ANTHROPIC_API_KEY` | for `/cross` | | |
| `ANTHROPIC_MODEL` | no | `claude-opus-5-5` | |
| `CELO_RPC_URL` | no | `https://forno.celo.org` | |
| `NEXT_PUBLIC_COURTROOM_URL` | yes | request origin | Public origin, used in the QR |
| `SWARM_GATEWAY_URL` | no | `https://api.gateway.ethswarm.org` | Resolves `bzz://` exhibits |
| `AGENT_ID` | no | | Fallback agentId for `/agent/registration.json` |

Without Redis the API returns `500 {"error":"redis not configured"}` and pages show a notice.

## Deploy

```sh
vercel link            # pick the project
vercel --prod          # root directory: courtroom
```

In the Vercel project set **Root Directory** to `courtroom`. Add Upstash Redis from the Marketplace; it injects the two `UPSTASH_*` vars. Set the rest by hand.

Local:

```sh
pnpm --filter courtroom dev
pnpm --filter courtroom typecheck
```

## How the terminal talks to it

All host calls send `x-host-secret: <HOST_SECRET>`.

```
POST /api/evidence            body: Evidence (zod, @trial/shared)  -> stores evidence:<round>, sets agent:id
POST /api/log                 body: { round, lines: LogLine[] }    -> RPUSH log:<round>
POST /api/vote/round          body: { round, action: open|close|reset|set|current, trust?, distrust? }
POST /api/ask                 body: { round, role: defendant|prosecutor|defense, question? }  -> text/plain stream
```

Public reads:

```
GET /api/round                                -> { round }
GET /api/evidence?round=                      -> Evidence | null
GET /api/log?round=&after=<int>               -> { lines, next }   poll with after=next
GET /api/vote/tally?round=                    -> VoteTally
POST /api/vote                                body: { round, choice: trust|distrust }  409 on closed or repeat
GET /api/chain/agent/<id>                     -> owner, wallet, tokenURI, registration, per-tag summary, last feedback
GET /api/verify/<exhibitId>?round=            -> { ok, computedHash, expectedHash } | { ok, status } | { ok, note }
GET /agent/registration.json                  -> EIP-8004 registration file
GET /.well-known/agent-card.json              -> A2A card
```

Redis keys: `round:current`, `evidence:<round>`, `log:<round>` (list, capped at 5000), `tally:<round>` (hash),
`voters:<round>` (set), `vote:<round>:open`, `vote:<round>:closedAt`, `agent:id`, `statements:<round>` (hash).
