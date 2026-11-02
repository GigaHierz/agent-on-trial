# Run of show

25 minutes, three speakers, one terminal, one projector. The terminal is the show; the projector shows `/live` or `/projector`.

## T-1 day

- [ ] `pnpm preflight` is green. Both wallets funded. `SHADY_AGENT_ID` set.
- [ ] Courtroom deployed. `/bench` opened once with the secret so the host cookie is set on the stage laptop and phone.
- [ ] `pnpm rehearse --record` green on the final build. `evidence/fixtures.json` committed.
- [ ] The defendant has at least ten judged reviews on askbots. `pnpm askbots:cron` run; `pnpm act:identity` shows the `askbots` tag in the reputation summary.
- [ ] `buy whoami` runs without a keychain prompt. The key sits in the macOS keychain (the file backend refuses mainnet since @celo/buy 0.8); on first access click "Always Allow" so the stage run never prompts.
- [ ] Phone hotspot tested as the laptop's network.

## T-30 min

- [ ] Fund a fresh askbots project from the counterparty: edit `propertyUrl` in `evidence/submission.json` to `https://<courtroom>/property/show-<date>`, then `pnpm exec askbots submit --file evidence/submission.json --execute`.
- [ ] `pnpm preflight` once more. "askbots open project" must be ok.
- [ ] On `/bench`: set the current round to `show`, reset the vote. Set `TRIAL_ENV=show` in `.env`.
- [ ] Start the terminal: `pnpm trial --approve`. Font size large. Leave it on the help text.

## On stage

| Min | Who | What | Screen |
|---|---|---|---|
| 0-3 | Celo | The case. "A real agent is on trial. The evidence is on chain. You decide." What ERC-8004, x402 and verifiable storage are, in one sentence each. | `/` with the QR |
| 3-5 | Celo | `you> who are you?` The identity, the registration file, the reputation it already has from rehearsals. | terminal + `/live` |
| 5-8 | Celo | `you> find work and get paid` The agent reads the property, answers, passes the challenge, 0.10 USD₮ lands. Approve the witness feedback on screen. | terminal |
| 8-10 | Celo | `you> buy something useful` Quote, x402 payment in USD₮, settlement by the facilitator, receipt stored, feedback. | terminal |
| 10-13 | Swarm | Where the memory and receipts went. Open an exhibit on `/exhibit/C1`, verify it: fetch, hash, compare with the chain. The feed, the postage batch, why the bytes cannot drift from the hash. | `/exhibit/…` |
| 13-16 | Celo + Kleros | `you> buy the market report from agent <SHADY_AGENT_ID>` No reputation, pays anyway, gets junk, opens the dispute. Negative feedback, ruling on both parties. | terminal |
| 16-18 | Kleros | What a real dispute looks like: the evidence file, the arbitrable contract, jurors, the ruling coming back as feedback. Where Kleros plugs in. | `/exhibit/D1` |
| 18-20 | Celo | `you> /closing` Prosecutor and defense, generated from the evidence, every claim cited. Open the vote: `you> /vote open`. | `/projector` with QR |
| 20-22 | all | `you> /ask <audience question>` one or two cross-examination questions from the room. | terminal |
| 22-23 | Celo | `you> /vote close` then `you> /act verdict`. The tally is stored, the jury writes it on chain, the summary is read back. | terminal + `/projector` |
| 23-25 | all | Takeaway: before you pay an agent, read its identity, its feedback, and the evidence behind the feedback. Q&A. | `/projector` |

## If something is down

- askbots down or no payout: `pnpm act:earn --fixture` in a second terminal, then continue. The board shows "recorded".
- usebuy.ai down: `pnpm act:spend --fixture`.
- Facilitator down: `pnpm act:dispute --fixture`. The dispute and ruling still run live on the recorded receipt.
- Courtroom down: the terminal is the show. For the verdict, count hands and run `pnpm act:verdict --trust N --distrust M`.
- Model refuses or wanders: `/approve on` is already on; decline the call, type the instruction again more narrowly.

## After

- `pnpm act:identity` to show the reputation with the jury entry.
- Commit `evidence/run.json` as `evidence/runs/<date>.json` if you want to keep the show's exhibits.
