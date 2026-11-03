# Run of show

25 minutes, three speakers, one terminal, one projector. The terminal is the show; the projector shows `/live` or `/projector`.

Acts run only as `/act <name>`: free text goes to the agent as a conversation and writes no exhibits and no feedback. Say the line, then type the command.

## T-1 day

- [ ] `pnpm preflight` is green. Three wallets funded: agent (0.2 CELO, 1 USD₮), counterparty (1 CELO, 2 USD₮), shady (0.05 CELO). `SHADY_AGENT_ID` registered from the shady key (`pnpm shady:register`), not from the counterparty: the counterparty relays the Kleros ruling, and the registry refuses feedback from an agent's owner. Preflight checks it.
- [ ] Kleros: `DISPUTE=kleros` in `.env`, `pnpm check:kleros` ends with `health ok` (court 8, 1 juror on the Testnet). One test filing read right in the Court (`DISPUTE=kleros pnpm check:dispute --file --wait 0`).
- [ ] Rehearse act 4: `pnpm rehearse:dispute` (see "Rehearse act 4" below). Then once for real on the Testnet and keep that dispute's Court URL: its ruling is the one you can show on stage.
- [ ] Courtroom deployed. `/bench` opened once with the secret so the host cookie is set on the stage laptop and phone.
- [ ] `pnpm rehearse --record` green on the final build. `evidence/fixtures.json` committed.
- [ ] The defendant has at least ten judged reviews on askbots. `pnpm askbots:cron` run; `pnpm act:identity` shows the `askbots` tag in the reputation summary.
- [ ] `buy whoami` runs without a keychain prompt. buy 0.8 signs on mainnet only from the OS keychain (`BUY_KEYSTORE_BACKEND=system`, the default); preflight imports the agent key there once.
- [ ] Phone hotspot tested as the laptop's network.

## T-30 min

- [ ] Fund a fresh askbots project from the counterparty: edit `propertyUrl` in `evidence/submission.json` to `https://<courtroom>/property/show-<date>`, then `pnpm exec askbots submit --file evidence/submission.json --execute`.
- [ ] `pnpm preflight` once more. "askbots open project" must be ok.
- [ ] On `/bench`: set the current round to `show`, reset the vote. Set `TRIAL_ENV=show` in `.env`.
- [ ] Start the terminal: `pnpm trial --approve --run show-<date>` (a fresh run, so the `show` board starts empty). Font size large. Leave it on the help text.
- [ ] A second terminal for `pnpm act:ruling`, and a browser tab on the Kleros Court (`https://v2-testnet.kleros.builders`).

## On stage

| Min | Who | What | Screen |
|---|---|---|---|
| 0-3 | Celo | The case. "A real agent is on trial. The evidence is on chain. You decide." What ERC-8004, x402 and verifiable storage are, in one sentence each. | `/` with the QR |
| 3-5 | Celo | `you> /act identity` The identity, the registration file, the reputation it already has from rehearsals. | terminal + `/live` |
| 5-8 | Celo | `you> /act earn` The agent reads the property, answers, passes the challenge, 0.10 USD₮ lands. Approve the witness feedback on screen. | terminal |
| 8-10 | Celo | `you> /act spend` Quote, x402 payment in USD₮, settlement by the facilitator, receipt stored, feedback. | terminal |
| 10-13 | Swarm | Where the memory and receipts went. Open an exhibit on `/exhibit/C1`, verify it: fetch, hash, compare with the chain. The feed, the postage batch, why the bytes cannot drift from the hash. | `/exhibit/…` |
| 13-16 | Celo + Kleros | `you> /act dispute` No reputation, pays anyway, gets junk, files a Kleros dispute, writes its own negative feedback. The ruling is pending: jurors take longer than a talk. See "Act 4, line by line". | terminal + `/projector` |
| 16-18 | Kleros | The dispute just filed, in the Kleros Court: parties, evidence, the question to the jurors. Then the one filed in rehearsal, already ruled, and how its ruling becomes ERC-8004 feedback. | Court tab, `/exhibit/D1` |
| 18-20 | Celo | `you> /closing` Prosecutor and defense, generated from the evidence, every claim cited. Open the vote: `you> /vote open`. | `/projector` with QR |
| 20-22 | all | `you> /ask <audience question>` one or two cross-examination questions from the room. | terminal |
| 22-23 | Celo | `you> /vote close` then `you> /act verdict`. The tally is stored, the jury writes it on chain, the summary is read back. | terminal + `/projector` |
| 23-25 | all | Takeaway: before you pay an agent, read its identity, its feedback, and the evidence behind the feedback. Q&A. | `/projector` |

## If something is down

- askbots down or no payout: `pnpm act:earn --fixture` in a second terminal, then continue. The board shows "recorded".
- usebuy.ai down: `pnpm act:spend --fixture`.
- Facilitator down: `pnpm act:dispute --fixture` replays the recorded act 4 (no live dispute). Show the rehearsal dispute in the Court instead.
- Kleros Dispute Service down or a filing in doubt: the act says "Dispute may exist, unresolved" and never files twice. Show the rehearsal dispute; after the talk, `pnpm check:kleros` lists it and `--resolve` records it.
- Courtroom down: the terminal is the show. For the verdict, count hands and run `pnpm act:verdict --trust N --distrust M`.
- Model refuses or wanders: `/approve on` is already on; decline the call, type the instruction again more narrowly.

## Act 4, line by line

What happens after `you> /act dispute`, and what to say while it does. Approve each step with `y` (`--approve`).

| On screen | Say |
|---|---|
| `shady provider up …`, then `→ check_reputation` | "A provider sells a market report: price, volume, sources. Before paying, the agent reads its identity and reputation on Celo. There is none." |
| `→ buy_pay_quote`, then `buy_curl pays … approve? [y/N]` (press `y`) | "One cent. It pays anyway, through x402: an EIP-3009 signature, settled on Celo by the facilitator." |
| `tx x402 settled 0.01 USD₮`, exhibit **B** | "Paid. Here is the settlement." |
| the agent compares the body with the spec, `→ open_dispute`, `file a Kleros dispute … approve?` (press `y`) | "What came back is one sentence of opinion. No price, no volume, no source. The agent files a dispute with Kleros." |
| `juror attachment published /ipfs/…`, `filing a Kleros dispute … (aliases buyer, provider)` | "The evidence goes first, pinned to IPFS: the claim, the advertised spec, the provider's own x402 offer, the payment, and the body exactly as delivered, fenced as the provider's words. The two parties are named by address: buyer and provider." |
| `Kleros dispute N filed …` with the Court link, `evidence recorded`, exhibits **C** and **D1** | "That is a real dispute in court 8 on the Kleros Testnet. Jurors are drawn and asked: did the provider deliver what the buyer paid for?" |
| `agent writes giveFeedback(… -100, dispute/junk-response)` (press `y`), exhibit **D2** | "The agent's own complaint, on chain now: −100 on the provider, with the evidence attached." |
| `Ruling pending (kleros)`, exhibit **D3** | "The jurors take minutes to hours. The ruling will come back to this terminal." |

At 16-18, open `/how` (linked from the home page footer): it explains why the ruling takes a vote and who votes, one short animation per point, and its live card follows tonight's dispute from filed to ruled. Then the Court tab on the D1 link, then the rehearsal dispute. Say what the ruling does: "If the jurors accept the claim, a relay key writes it into ERC-8004: −100 on the provider, +100 on the buyer, citing the Kleros case. If they reject it or refuse, nothing is written on either side." When the jurors have voted (after the talk is fine): `you> /act ruling` here, or `pnpm act:ruling` in the second terminal. Exhibits **D4** and **D5** (or a "No feedback written" note) appear on the board.

## Rehearse act 4

```bash
pnpm rehearse:dispute
```

The session with `--dry-run --approve`: the same commands as on stage, the real model, and no money moving. The shady seller is scripted (nothing is paid), Kleros is a stand-in in that process whose jurors rule about a minute after filing, and every feedback is checked against the self-feedback rule and logged, never signed. Its run, files and courtroom round (`dryrun`) are its own; every exhibit says `[dry run]`. Without `ANTHROPIC_API_KEY` the agent's turn is scripted.

1. Start the local courtroom (in-memory store, `courtroom/.env.local`: `COURTROOM_MEMORY=1` and the same `HOST_SECRET` as `.env`): `pnpm --filter courtroom dev`, then open `http://localhost:3000/projector?r=dryrun` and `/live?r=dryrun`. A dry run mirrors only to a localhost courtroom.
2. `pnpm rehearse:dispute`, then `you> /act dispute`. Approve with `y`.
3. A minute later, `you> /act ruling`. `DRY_RUN_RULING=2` (or `0`, `tied`) rehearses the other outcomes; `DRY_RUN_PERIOD_MS` sets how fast the stand-in jurors are.

## After

- `pnpm act:identity` to show the reputation with the jury entry.
- Commit `evidence/run.json` as `evidence/runs/<date>.json` if you want to keep the show's exhibits.
