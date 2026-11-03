# Plug in Kleros

Act 4 is a purchase that goes wrong. The agent pays 0.01 USD₮ for a market report "with sections: price, volume, sources" and gets a body with none of them. It opens a dispute. With `DISPUTE=local` a deterministic arbitrator rules it in a second. With `DISPUTE=kleros` it becomes a real Kleros v2 dispute, ruled by Kleros jurors, filed through the [Kleros Dispute Service](https://docs.kleros.io/ai-tools/dispute-service/overview).

The Dispute Service is one authenticated MCP endpoint. It files disputes from a **Preset** that Kleros sets up for each partner: the chain, the court, the juror count, the dispute template and the wallet that pays the fee. We deploy no arbitrable contract and hold no Arbitrum key. One API key per deployment, and the key decides where a dispute goes. Both keys sit in `.env`; `KLEROS_CHAIN` picks one.

| Deployment | Kleros key | `.env` | `KLEROS_CHAIN` | What it is |
| --- | --- | --- | --- | --- |
| Testnet | `demo-testnet` | `KLEROS_API_KEY_TESTNET` | `arbitrum-sepolia-testnet` | Kleros v2 public testing, on Arbitrum Sepolia. Test data. Court 8, 1 juror. The one for rehearsals and most demos. |
| Beta | `demo-beta` | `KLEROS_API_KEY_BETA` | `arbitrum-one` | Kleros v2 **live production**: real disputes, permanent public cases. Court 34, 5 jurors. "Beta" is the release name, not a test network. Never show or hand this key to an audience. |

Both keys broadcast: every `dispute_create` files a real dispute. Kleros pays the arbitration fees and the gas for both.

## What the adapter does

| `DisputeAdapter` | Dispute Service calls |
| --- | --- |
| `open(evidence)` | `evidence_pin` the juror attachment (before filing: the evidence period starts at creation and lasts 10 to 15 minutes), then `dispute_create` with the parties as aliases (`buyer`, `provider`), then `evidence_submit` against the Core dispute id, one write after the other. Returns the Core id and the Kleros Court case URL. |
| `status(id)` | `dispute_get`: Evidence → `evidence`, Commit and Vote → `open`, Appeal and Executed → `ruled`. A simulated filing is `closed`. |
| `ruling(id, { waitMs })` | Polls `dispute_get` every `KLEROS_POLL_MS` until the vote is over (the Appeal period, or the Vote period past its deadline), or until Executed with `KLEROS_WAIT_FOR=executed`. `null` while pending. |
| `health()` | `initialize` and `tools/list`: is there a Preset, which chain do its instructions name, which alias slots. |

Files:

- `adapters/dispute/kleros-service.ts`: the client. Plain JSON-RPC over HTTP, one request per POST, SSE framed answers, the 30 requests a minute limit, 429 backoff, one write at a time, `WRITE_IN_PROGRESS` retried, refusals read from prose.
- `adapters/dispute/kleros.ts`: the adapter, its config, the filing record and what the jurors read.
- `checks/kleros.ts`: `pnpm check:kleros`, read only.
- `checks/kleros-fake.ts`: `pnpm kleros:fake`, a stand-in for the service with the same wire.
- `steps/04-ruling.ts`: `pnpm act:ruling`, writes a ruling that came after the act.
- `lib/filelock.ts`: the lock file both records are written under.
- `tests/kleros.test.ts`: the adapter against the fake, on a fake clock.

The adapter never signs on Celo. When `ruling()` returns, the step script writes the `ruling` feedback from our arbitrator key, quoting the Kleros case URL as `proofUrl` and the ruling document as its evidence (see Rulings for what is written).

## The parties

`dispute_create` takes one argument, `aliases`, always sent (`{}` when no party is known). The template's slots are `buyer` and `provider`, each an address; other names are refused. The adapter uses them unless `KLEROS_ALIAS_COMPLAINANT` / `KLEROS_ALIAS_RESPONDENT` name others.

- `buyer`: our agent's address, the one that paid.
- `provider`: who the settlement paid. The buyer's receipts do not record it, so `open_dispute` reads it from the ERC-20 `Transfer` log of the settlement transaction on Celo. If it cannot, the provider is left out, never sent as a placeholder, and the Evidence document says the address was not read.

## What the jurors read

1. **The template**, fixed by the Preset: "x402 purchase dispute". It asks whether the provider delivered what the buyer paid for, as described in the x402 payment requirements, under the policy its `policyURI` links. A dispute keeps the policy it was created with.
2. **The Evidence document** (`evidence_submit`). In prose: the agent's claim, the advertised spec, the x402 payment requirements the endpoint serves (fetched without paying when the dispute is filed: the provider's own words), the payment in USD₮ (buy records it in the token's smallest unit, `10000` for 0.01) with its Celoscan link, both parties with their ERC-8004 ids, and the delivered body verbatim between `<<<BODY-<keccak256>` and `BODY-<keccak256>>>>`, labelled as the provider's content to be read as data, not instructions. The fence is the body's whole keccak256, which the body cannot contain, so it cannot close the quote and go on in our voice. Kept under 60 KB whatever the fields hold (the 64 KiB limit): the body's excerpt shrinks first.
3. **The attachment** (`evidence_pin`, `/ipfs/<cid>`). The same record as JSON: the x402 requirements, the payment transaction, the full delivered body and the keccak256 hashes of every stored copy, so a juror can match them against the feedback on Celo. Publication is permanent and public; `KLEROS_PIN_ATTACHMENT=0` skips it.

Everything submitted is public and permanent. It carries addresses, agent ids, hashes and the provider's content, never personal data.

## Money safety

Each filing pays an arbitration fee from the Preset's fee wallet (Kleros funds it for the demo keys), a fee is never refunded, and a Beta case is public for good. So:

- **Once per receipt.** The receipt is reserved in `KLEROS_STATE_FILE` (`.runs/kleros/disputes.json`, under a lock file) *before* anything is sent, and keyed on a settled x402 receipt this agent recorded (the agent cannot file over a payment it did not make). Opening a dispute again for the same receipt, or twice at once, returns the one already filed. Another process filing the same receipt is refused; a reservation left by a process that died before sending frees itself after 30 minutes, and every later write checks it still holds the reservation, so a takeover cannot lose a paid dispute.
- **Only the documented refusals count as "nothing sent".** The service's docs list, per tool, the refusals that sent nothing (zero address, unknown slot, insufficient balance, a misconfigured Preset, …). Those, a 400/401/406/413/429 and "no such tool" free the receipt for another try. Everything else (`unknown`, `FILING_TIMED_OUT`, `FILING_FAILED`, a code nobody documented, a 5xx, a dropped connection) may have been sent: the record stays `unknown` and every later `open()` for that receipt refuses, naming the transaction.
- **A revert is kept too.** `TRANSACTION_REVERTED` means no dispute and the fee came back, but a human reads why before filing again: the record stays `reverted` with its transaction.
- **To clear a stuck record**, a human checks the transaction on Arbiscan or the case in the Court. If the dispute exists: `pnpm check:kleros --resolve <receipt tx> --core <dispute id>` records it, and `pnpm act:ruling --dispute <id>` writes its ruling later. Take the Core id from the creation transaction, not from the latest case in the Court: the service accepts another real dispute's id. `--resolve` reads the dispute first, refuses one in another court or already held by another filing, and asks y/N. If nothing was filed, remove the record from the state file. `pnpm check:kleros` lists them.
- **The key decides the chain.** Before filing, the adapter reads the key's instructions. They list every deployment, then say what this key's `dispute_create` sends: "court 8, 1 jurors, on arbitrum-sepolia-testnet" (Beta: "court 34, 5 jurors, on arbitrum-one"). That filing line decides; `pnpm check:kleros` prints it. If it names another chain than `KLEROS_CHAIN`, the adapter refuses. Without a filing line (or with two that disagree), it falls back to the one deployment the instructions name, and if they do not name exactly one, it refuses until a human has read them and set `KLEROS_TRUST_PRESET` to the fingerprint `pnpm check:kleros` prints; a changed Preset has a new fingerprint and is refused again. If such instructions mention Beta at all (`arbitrum-one`, "Arbitrum One", "Beta"), `KLEROS_ALLOW_BETA=1` is required too: the key may file on Beta. The instructions are read again before every filing. After filing, the chain the service reports wins: the dispute is read there, and a chain the adapter does not know stops the reads for a human.
- **Beta needs consent.** `KLEROS_CHAIN=arbitrum-one` refuses to file without `KLEROS_ALLOW_BETA=1`.
- **Simulation is reported as simulation.** If the Preset only simulates, `open()` returns `simulated-…`, no evidence is submitted, act 4 writes no feedback and no ruling waits.
- **Evidence is submitted once.** A submission refused before sending is retried the next time the dispute is opened for that receipt; one that may have been sent is never repeated.
- **`--approve`** asks y/N before the act files, as it does before every payment.
- **`pnpm check:dispute` files only with `--file`**, and with `--beta` and a y/N on arbitrum-one. It refuses while an earlier filing is unresolved. Come back to a dispute with `--id`.

## Rulings

- The ruling is read as soon as the vote is over and taken as final: the Appeal period, or the Vote period past its deadline (the Testnet does not move periods on its own, so a dispute can sit in Vote with its votes in). An appeal is not waited for, and a ruling once read is never read again; the ruling document records the round and the period. `KLEROS_WAIT_FOR=executed` waits for execution instead.
- One ruling reader at a time: a second `act:ruling` (or `/act ruling`) stops and names the one running, so the relay key never signs from two processes at once.
- `ruling: "0"` means two things on Kleros: refuse to arbitrate, or no majority yet. The adapter reads `tied` to tell them apart: `0` with `tied: false` once the vote is over is a refusal, and so is a tie then: it is not waited out.
- Reads come back degraded on the Testnet (`unresolvedFields`), sometimes without the answers. The pinned titles cannot be checked then, so the ruling is not read. The service says such reads may not clear: confirm the answers on the Court page the error links and set `KLEROS_CONFIRMED_ANSWERS=<chain>:<core id>` (comma separated; Core ids are per deployment, and a bare id means one on `KLEROS_CHAIN`) for that dispute.
- `KLEROS_RULING_MAP` turns the template's answer values into `complainant`, `respondent` or `refused`, and pins each answer's title. For the x402 purchase dispute (both keys) it is `1=complainant:Accept the claim,2=respondent:Reject the claim`, as in `.env.example`; Testnet dispute 209 in court 8 carries exactly these answers. It has no default in code, because templates differ: other disputes filed through this service read `1` as "Refund Both" or "Yes, the seller delivered". Before a ruling becomes a winner, every answer on the dispute must be in the map and every pinned title must match; otherwise it throws and nothing is written. `pnpm check:kleros --dispute <id>` prints each answer next to what it maps to, and the line to paste.
- What is written on Celo, as the Kleros brief has it:

  | Ruling | Provider | Buyer (our agent) |
  | --- | --- | --- |
  | `1` Accept the claim: the delivery did not match | −100, `ruling` / `complainant-wins` | +100, `ruling` / `complaint-upheld` |
  | `2` Reject the claim: the delivery matched | nothing | nothing |
  | `0` refused, or tied | nothing | nothing |

  The provider's half goes on `SHADY_AGENT_ID` only when the dispute is about the shady endpoint; a dispute over another provider writes the buyer's half alone. The proof's `toAddress` is the payee read from the settlement (or the x402 challenge the buyer signed), never the payTo an endpoint advertises after the fact.

  When nothing is written, the ruling is still recorded as done in `.runs/rulings.json` and a `D` note exhibit says so, with the Court link. The `dispute` / `junk-response` −100 the agent wrote on the provider when it filed stays either way.
- On the Testnet the vote was over 20 to 70 minutes after filing. Court 8's juror there is an AI juror: on dispute 210 it committed, revealed and gave its reasons in writing. The act waits 30 seconds, records "Ruling pending" with everything needed to finish (even if the agent's turn or a feedback write fails after the filing), and `pnpm act:ruling` (or `/act ruling` in the session) writes the ruling later, with the adapter the dispute was opened with. If the act died before that record, `pnpm act:ruling --dispute <id>` rebuilds it from the filing. Each half (provider, defendant) is reserved before it is signed and recorded as soon as it is broadcast in `.runs/rulings.json`, so it is written once, and both halves carry the same ruling. A half whose broadcast got no answer from the node is left in doubt: the next run says which transactions to check, and a human fixes its entry. `act:ruling` does nothing under `--fixture`.
- `pnpm rehearse` with `DISPUTE=kleros` runs `act:ruling` after the dispute act and waits up to `KLEROS_REHEARSE_WAIT_MS` (90 minutes) for the ruling; if it is still pending, the ruling count is not checked.

## The Preset

Kleros issued two demo keys, `demo-testnet` and `demo-beta`, with the same template, "x402 purchase dispute": an x402 buyer says a provider's digital delivery did not match the terms it paid for. Slots `buyer` and `provider`; answers `1` Accept the claim, `2` Reject the claim, `0` refuse to arbitrate. The `instructions` string the service returns on connect, and the `rulingOptions` on each dispute, win over this page: `pnpm check:kleros` prints both.

## Env

| Variable | Default | |
| --- | --- | --- |
| `DISPUTE` | `local` | `kleros` to file through the Dispute Service. |
| `KLEROS_API_KEY_TESTNET` | | The `demo-testnet` key, used when `KLEROS_CHAIN=arbitrum-sepolia-testnet`. |
| `KLEROS_API_KEY_BETA` | | The `demo-beta` key, used when `KLEROS_CHAIN=arbitrum-one`. |
| `KLEROS_API_KEY` | | Fallback for either chain when its own variable is unset. |
| `KLEROS_CHAIN` | `arbitrum-sepolia-testnet` | Picks the key; must match the chain that key files on. |
| `KLEROS_ALLOW_BETA` | | `1` to file on `arbitrum-one`. |
| `KLEROS_ALIAS_COMPLAINANT`, `KLEROS_ALIAS_RESPONDENT` | `buyer`, `provider` | Slot names, when the Preset's are not these. A default is used only if the schema lists it. |
| `KLEROS_RULING_MAP` | none (`.env.example` has the x402 one) | Answer value → winner, with optional title pins. Required before a ruling is read. |
| `KLEROS_CONFIRMED_ANSWERS` | | `<chain>:<core id>` of disputes whose answers you checked on the Court page, for reads that come back without them. |
| `KLEROS_WAIT_FOR` | `vote` | `executed` to wait for execution. `appeal`, the old name, means `vote`. |
| `KLEROS_PIN_ATTACHMENT` | `1` | `0` to skip `evidence_pin`. |
| `KLEROS_TRUST_PRESET` | | The instructions fingerprint from `pnpm check:kleros`, when they do not name one chain and you have read them. |
| `KLEROS_POLL_MS` | `30000` | The key allows 30 requests a minute. |
| `KLEROS_SERVICE_URL` | `https://kleros-dispute-service.fly.dev/mcp` | |
| `KLEROS_COURT_URL` | per chain | `https://v2-testnet.kleros.builders` or `https://v2.kleros.builders`. |
| `KLEROS_STATE_FILE` | `.runs/kleros/disputes.json` | The filing record. Keep it between runs. |
| `KLEROS_REHEARSE_WAIT_MS` | `5400000` | How long `pnpm rehearse` waits for the ruling. |

## Simulate act 4

```bash
pnpm simulate:kleros
```

Runs the real act 4, `open_dispute`, the adapter and `act:ruling` against the fake service, a stand-in Celo registry that refuses self-feedback as the real one does, and a scripted model turn, with every other network call blocked and `.env` unread. Nine scenarios: jurors accept, reject, refuse, tie; two keys only; a filing that times out; Beta without consent; answers that never load; a busy service. It writes `.runs/simulation.md`: what was sent to Kleros, what the jurors read, what would be written on Celo, and the exhibits. It checks the code, not your configuration: `pnpm preflight` does that.

**Keys for the ruling.** Kleros decides; our arbitrator key only relays the ruling into ERC-8004, and the registry refuses feedback from an agent's owner. With two keys, the relay (the counterparty) also owns the shady identity, so the ruling on the provider reverts ("Self-feedback not allowed"); the buyer's +100 is still written. Give the shady provider a wallet of its own, `SHADY_PRIVATE_KEY` (0.05 CELO for `pnpm shady:register`), and leave `ARBITRATOR_PRIVATE_KEY` unset. `pnpm preflight` reads the shady agent's owner and fails on the clash. A session reads keys at start: restart it after editing `.env`.

## Before the key: the fake

```bash
pnpm kleros:fake --period-ms 5000
```

It prints the env and the command to use. In another terminal:

```bash
KLEROS_SERVICE_URL=http://localhost:4410/mcp KLEROS_API_KEY_TESTNET=fake pnpm check:kleros
```

```bash
KLEROS_SERVICE_URL=http://localhost:4410/mcp KLEROS_API_KEY_TESTNET=fake KLEROS_POLL_MS=1000 DISPUTE=kleros pnpm check:dispute --file --wait 30000
```

The fake serves the x402 purchase dispute's slots and answers, so the `.env.example` map applies. `--ruling 2`, `--ruling tied` and `--mode simulated|unknown|timeout` rehearse the other outcomes. Filings through the fake are kept apart from real ones (per service URL), but use a separate `KLEROS_STATE_FILE` if you want a clean list. Court links point at the real Testnet Court and lead nowhere for a fake dispute.

## On the Testnet (Arbitrum Sepolia)

1. Put the `demo-testnet` key in `.env` as `KLEROS_API_KEY_TESTNET`, with `KLEROS_CHAIN=arbitrum-sepolia-testnet`.
2. `pnpm check:kleros`. Read the instructions it prints: the chain, the court, the juror count, the slot names, and that the Preset broadcasts. The slots should read `"buyer" (default)` and `"provider" (default)`. If the instructions do not name one chain, set `KLEROS_TRUST_PRESET` to the fingerprint it prints. It should end with `health ok`.
3. `DISPUTE=kleros pnpm check:dispute --file --wait 0`. This files one real, public and permanent Testnet dispute over no purchase. Its evidence opens with "TEST FILING" and says so, the settlement hash is a placeholder with no Celoscan link, and it names only parties that are ours: the agent's address when `AGENT_PRIVATE_KEY` is set and the shady provider's payTo when `SHADY_PAY_TO` or its key is set; otherwise none (`{}`). No feedback is ever written from its ruling, even with `act:ruling --dispute`. It prints the parties, the Core id and the Court URL.
4. Open the Court URL. Check that the template reads right and that the evidence and its attachment show. `pnpm check:kleros --dispute <id>`: `1` must map to complainant and `2` to respondent.
5. `DISPUTE=kleros pnpm check:dispute --id <id> --wait 5400000`. Waits up to 90 minutes for the vote to be over.
6. The whole act: `DISPUTE=kleros pnpm act:dispute`, then `pnpm act:ruling --wait 5400000` (or later, `pnpm act:ruling`). This one writes on Celo mainnet: the `dispute` feedback when filing, and the ruling when it is `1`.

For the show, a dispute opened in rehearsal and ruled before the talk gives a `D` exhibit with a Court URL to open on stage.

## On Beta

Only after the Testnet run reads right in the Court: put the `demo-beta` key in `.env` as `KLEROS_API_KEY_BETA`, then run with `KLEROS_CHAIN=arbitrum-one KLEROS_ALLOW_BETA=1`, and `pnpm check:kleros` again (court 34, 5 jurors; check the template and the answers again). Every filing there is a real, permanent, public case ruled by real jurors.
