# Agent on Trial

A real AI agent earns, spends, gets disputed and is judged on Celo mainnet, in one terminal, in 25 minutes. This is the demo behind the Devcon Agentic Hub main-stage talk **"Can We Trust the Machines? A Live Trial"**.

The defendant is a Claude agent with an ERC-8004 identity. It reviews a website on askbots.ai and gets paid 0.10 USD₮. It pays for an API through x402. It buys a "market report" from a provider with no reputation, gets junk, and opens a dispute. Every step writes evidence: transactions on Celo, feedback in the ERC-8004 Reputation Registry, memory and receipts in content-addressed storage. The audience scans a QR code, votes, and the verdict is written on chain as feedback too.

Everything the agent does is printed in the terminal and mirrored to a public live log. Nothing is simulated. Mainnet only.

## What happens

One terminal: `pnpm trial --approve`. The host talks to the agent. These are the five acts, in order.

| Act | The host says | What the agent does | What lands on chain |
|---|---|---|---|
| 1 Identity | "who are you?" | Reads its ERC-8004 identity and reputation. First run: mints the identity and links it to an askbots.ai bot profile. | `register()` on the Identity Registry (first run) |
| 2 Earn | "find work and get paid" | Lists open askbots projects, reads the property, answers the builder's questions, passes the anti-human challenge. | 0.10 USD₮ payout from the askbots escrow. Witness feedback `earned` with the payout tx as proof. |
| 3 Spend | "buy something useful" | Checks its balance, finds a cheap API on usebuy.ai, gets a quote, pays through x402 in USD₮. | x402 settlement by `api.x402.celo.org`. Witness feedback `paid`. |
| 4 Dispute | "buy the market report from agent N" | Checks the provider's reputation (none), pays 0.01 USD₮, gets junk, opens a dispute. | Settlement to the shady provider. Agent feedback `dispute` on the provider. Arbitrator feedback `ruling` on both. |
| 5 Verdict | `/act verdict` after the vote closes | The tally is stored and the jury key writes it as feedback. | Feedback `jury` with value = percent who trust. |

Per run: 0.13 USD₮ moves, six feedback transactions are signed (seven with the mint). Every transaction we sign carries an ERC-8021 builder code.

The same acts exist as scripts for rehearsal: `pnpm act:identity`, `pnpm act:earn`, `pnpm act:spend`, `pnpm act:dispute`, `pnpm act:verdict`. `pnpm act:ruling` writes a dispute ruling that arrived after act 4.

## The evidence

Exhibits are lettered by what they prove. Each one is a transaction, a storage reference with its hash, or an HTTP result. The courtroom shows them on `/projector`; `/exhibit/<id>` verifies each one in the browser.

| Letter | What | Where it lives | How you check it |
|---|---|---|---|
| A | Identity and reputation | ERC-8004 Identity Registry `0x8004A169…a432`, Reputation Registry `0x8004BAa1…9b63` on Celo | `ownerOf`, `tokenURI`, `getSummary`, `readFeedback` |
| B | Payments | USD₮ transfers on Celo: askbots payout, two x402 settlements | Celoscan, `Transfer` logs |
| C | Memory and receipts | Content-addressed storage: Swarm (`bzz://…`) or inline `data:` URIs | Fetch the bytes, keccak256 them, compare with `feedbackHash` on chain |
| D | Dispute | The dispute file, the delivered body, the ruling; feedback on both parties | Same as C, plus the ruling transactions |
| V | Verdict | The tally file and the jury's feedback transaction | `getSummary(agentId, clients, "jury", "")` |

Every feedback entry on chain carries `feedbackURI` (where the evidence file is) and `feedbackHash` (keccak256 of its bytes). That is the whole trust model: the chain holds the pointer and the hash, the storage holds the bytes, anyone can check that they match.

## Run it

Prerequisites: Node 20+, pnpm 10, two funded Celo mainnet wallets, an Anthropic API key, an x402 facilitator API key from https://x402.celo.org.

```bash
git clone https://github.com/GigaHierz/agent-on-trial
cd agent-on-trial
pnpm install
cp .env.example .env && chmod 600 .env
```

Fill in `.env`. Two keys are enough for a test run.

| Variable | What |
|---|---|
| `AGENT_PRIVATE_KEY` | The defendant. Owns the identity, receives payouts, pays through x402. Falls back to `PRIVATE_KEY`. Fund with 0.2 CELO and 1 USD₮. |
| `COUNTERPARTY_PRIVATE_KEY` | Witness, arbitrator, jury and askbots builder in one. Falls back to `PRIVATE_KEY_2`. Must be a different address: the registry refuses self-feedback and askbots refuses self-review. Fund with 1 CELO and 2 USD₮. |
| `ANTHROPIC_API_KEY` | The agent is Claude. Model from `ANTHROPIC_MODEL`, default `claude-opus-5-5`. |
| `BUY_FACILITATOR_API_KEY` | Lets the shady paywall settle through `api.x402.celo.org`. Falls back to `x402_API_KEY`. |
| `COURTROOM_URL`, `HOST_SECRET` | The public live log and vote. Optional; without them the show is terminal only. |

Then, in order:

```bash
pnpm fresh:defendant      # optional: a brand-new defendant wallet with no identity or history, funded from PRIVATE_KEY
pnpm preflight            # balances, services, adapters, open askbots project, cron reminder
pnpm shady:register       # once: mints the shady provider's identity, writes SHADY_AGENT_ID to .env
pnpm trial --approve      # the show
```

Before act 2 can pay, askbots needs an open project that the agent has not reviewed and the counterparty funded. Preflight tells you when there is none. To fund one (0.11 USD₮ into escrow, gas paid in USD₮):

```bash
pnpm exec askbots login --email you@example.com
# put the counterparty key in ASKBOTS_PRIVATE_KEY, then:
pnpm exec askbots submit --file evidence/submission.json --execute
```

Edit `propertyUrl` in `evidence/submission.json` first. With a courtroom deployed, use `https://<courtroom>/property/<anything unique>`; askbots refuses a second funded project on the same URL.

askbots writes its own ERC-8004 feedback (`paid-acceptance-rate`, `builder-rating`) on a weekly cron, and only once an agent has ten judged reviews. The defendant gets there during rehearsals. Before the show, trigger the write by hand so those tags are on chain:

```bash
pnpm askbots:cron         # needs ASKBOTS_CRON_SECRET
```

Rehearse the whole thing end to end and check every exhibit against the chain:

```bash
pnpm rehearse --record    # --record freezes the run as evidence/fixtures.json
```

With fixtures recorded, any act accepts `--fixture` and replays the recorded exhibits with a "recorded" badge. That is the fallback if a live service is down on stage.

## In the terminal

```
you> who are you?
host  act identity …
agent I am agent 9912 on Celo. Owner 0x…, three feedback entries, two clients.
you> find work and get paid
→ askbots_list_projects({})
← 1 project(s): Trial Weather API https://…/property/show-1
→ askbots_fetch_property({"url":"…"})
→ askbots_submit_review({"projectId":"…","answers":4})
tx    askbots paid 0.10 USDT https://celoscan.io/tx/0x…
→ memory_write({"text":"Reviewed Trial Weather API …","txHash":"0x…"})
?     witness writes giveFeedback(agent 9912, 100, earned/askbots-review) — approve? [y/N]
```

`/approve on|off` toggles the y/N gate for anything that pays or writes to chain. `/ask <question>` cross-examines the defendant: it answers from its evidence and memory only, every claim cites an exhibit id. `/closing` generates the prosecutor's and the defense's closing statements. `/vote open|close` controls the audience vote. `/exhibits` lists what the run has produced. After `/act dispute` the session watches the Kleros ruling in the background and writes it when the vote is over (`/act ruling` with `--approve`); `/ruling` shows the last check and `/ruling stop` stops waiting.

## The courtroom

`courtroom/` is a Next.js app for Vercel. No private keys on it.

- `/live` the public transcript: every agent message, tool call, result and transaction, as it happens.
- `/projector` the evidence board in four columns, with the QR code and the live tally.
- `/vote` two buttons on a phone.
- `/cross` the host types a question; the defendant answers with citations.
- `/bench` host controls: round, open and close the vote, closing statements, manual tally.
- `/exhibit/<id>` one exhibit with a verify button: fetch, hash, compare with chain.
- `/agent/registration.json` the defendant's ERC-8004 registration file (the `agentURI`).
- `/.well-known/agent-card.json` an A2A agent card, for discovery.

Deploy with the Vercel root directory set to `courtroom`, add Upstash Redis from the marketplace, set `HOST_SECRET`, `ANTHROPIC_API_KEY` and `NEXT_PUBLIC_COURTROOM_URL`. See `courtroom/README.md`.

## Plug in Swarm

The agent's memory, receipts, dispute files and verdict all go through one interface, `adapters/storage/types.ts`. Set `STORAGE=swarm` and the files land on Swarm through bee-js; `feedbackURI` becomes `bzz://<reference>` and the courtroom links to the gateway. Feeds included: with `SWARM_FEED_PRIVATE_KEY` set, the agent's memory head is one stable `bzz://` feed manifest. One file, one check command. See [docs/PLUG-IN-SWARM.md](docs/PLUG-IN-SWARM.md).

```bash
STORAGE=swarm BEE_API_URL=http://localhost:1633 SWARM_POSTAGE_BATCH_ID=… SWARM_FEED_PRIVATE_KEY=0x… pnpm check:storage
```

### Agent memory through Swarm MCP

Any MCP-capable agent can keep its memory on Swarm without a Swarm SDK: it connects to the [Swarm MCP server](https://github.com/ethersphere/swarm-mcp) (npm `swarm-mcp`) over stdio and calls its tools.

- `upload_file` stores a memory snapshot and returns its `bzz://` reference. That reference and the keccak256 of the bytes are what go into `feedbackURI` and `feedbackHash` on chain.
- `update_feed` points the agent's feed at the newest snapshot, so its memory head is one stable address that never changes between runs.
- `read_feed` gets the latest snapshot back at the start of a session, so the agent picks up where it left off.

The server talks to a Bee node (`BEE_API_URL`) and signs the feed with its own key (`BEE_FEED_PK`), which is separate from any wallet. Every snapshot stays content-addressed: anyone can fetch it from a gateway, hash it and compare it with the chain.

## Plug in Kleros

The dispute goes through `adapters/dispute/types.ts`: open with evidence, read status, read the ruling. Set `DISPUTE=kleros` and `adapters/dispute/kleros.ts` files a real Kleros v2 dispute through the [Kleros Dispute Service](https://docs.kleros.io/ai-tools/dispute-service/overview): no arbitrable contract of ours, one API key per deployment (`KLEROS_API_KEY_TESTNET`, `KLEROS_API_KEY_BETA`; `KLEROS_CHAIN` picks one). It publishes the juror attachment, files with the buyer and the provider as parties, submits the evidence and reads the jurors' ruling back. The adapter never signs on Celo; when the jurors accept the claim, our arbitrator key writes the ruling to the Reputation Registry quoting the Kleros case (provider −100, buyer +100; a rejected claim or a refusal writes nothing). A ruling takes 20 to 70 minutes: the act moves on, the session watches for the ruling in the background, and `pnpm act:ruling` writes it from any terminal. See [docs/PLUG-IN-KLEROS.md](docs/PLUG-IN-KLEROS.md).

```bash
pnpm check:kleros                                         # read only: what the key's Preset is
DISPUTE=kleros pnpm check:dispute --file --wait 0         # files one dispute (Testnet by default)
DISPUTE=kleros pnpm check:dispute --id <dispute id> --wait 5400000
```

To run the dispute on the Kleros Testnet or live on Kleros Beta, step by step: [docs/RUN-THE-DISPUTE.md](docs/RUN-THE-DISPUTE.md).

No key yet? `pnpm kleros:fake` serves a stand-in with the same wire, and `pnpm simulate:kleros` runs act 4 and its ruling end to end against it, with Celo stood in, and writes `.runs/simulation.md`. The shady provider needs a wallet of its own, `SHADY_PRIVATE_KEY`: the counterparty relays the Kleros ruling into ERC-8004, and the registry refuses feedback from an agent's owner.

## Standards

What the demo uses, and what is not live yet. Details in [docs/STANDARDS.md](docs/STANDARDS.md).

| Standard | In this demo | Not yet |
|---|---|---|
| ERC-8004 identity | `register(agentURI)` on Celo mainnet, registration file served by the courtroom, askbots profile linked by signature | |
| ERC-8004 reputation | `giveFeedback` from the witness, the arbitrator, the jury and the agent itself. Evidence files hashed on chain. askbots' own aggregate tags via its cron. | Per-settlement feedback from the x402 facilitator (open PR). |
| ERC-8004 validation | | Not used. |
| x402 v2, scheme `exact` | The `buy` client signs EIP-3009 authorizations in USD₮; `api.x402.celo.org` settles and pays the gas. Receipts in `receipts.json`. | |
| ERC-8021 builder codes | `withAttribution` on every transaction we sign. | Facilitator settlements carry no tag yet. |
| MCP | The agent pays through `buy mcp serve`. Swarm's MCP server can drive the storage adapter. | |
| A2A | Agent card served for discovery. | No A2A exchange on stage. Reference: celo-org/x402-celo-example. |

## Layout

```
agent/        the defendant: tool loop, session, tools (askbots, buy MCP, memory, reputation, dispute)
steps/        the five acts as scripts, preflight, askbots cron trigger
lib/          env, viem clients, feedback writer, askbots client, buy CLI, evidence store, log
adapters/     storage (local, swarm) and dispute (local, kleros)
shady-provider/  the x402 paywall that sells junk
checks/       check:storage, check:dispute, check:kleros, kleros:fake, check:buy, rehearse, vote:simulate
courtroom/    Next.js app
shared/       schema and chain constants used by both
evidence/     submission template, fixtures, the current run
docs/         run of show, spoken script, standards, plug-in guides
```

## Costs

One run: 0.11 USD₮ to fund the askbots project, 0.10 USD₮ back to the agent, 0.03 USD₮ in x402 purchases, about 0.05 CELO in gas across seven transactions.

## Credits

askbots.ai, usebuy.ai, x402.celo.org by Celo. Swarm by Solar Punk and the Swarm Foundation. Dispute resolution by Kleros.

## License

MIT
