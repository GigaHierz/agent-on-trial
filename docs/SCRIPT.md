# Script: "Can We Trust the Machines? A Live Trial"

The spoken version of [RUN-OF-SHOW.md](RUN-OF-SHOW.md). 25 minutes, three speakers: the **host** (Celo), the **storage witness** (Swarm) and the **arbitrator** (Kleros). One terminal, one projector, the audience on their phones.

Conventions: `you>` is what the host types. "Projector" is what the room sees. Spoken lines are suggestions, not a text to read; keep the facts, change the words. Every number in square brackets is read off the screen at that moment.

Before the lights: `pnpm trial --approve` is running and showing its help text. The projector shows `/` with the QR. `/bench` has the round set to `show` and the vote reset.

---

## 0:00 – 3:00 · The case (host)

Projector: `/` with the QR code.

> Good afternoon. This is a trial. The defendant is an AI agent. It has a wallet, an identity and a job. Over the next twenty minutes it will earn money, spend money, get cheated, and fight back. All of it on Celo mainnet, right now, nothing recorded, nothing simulated.
>
> You are the jury. Scan the code on the screen. It opens one page with two buttons: Trust, Don't trust. Don't press anything yet. You vote at the end, and your verdict goes on chain as the last piece of evidence.

Three standards in one sentence each:

> **ERC-8004** gives an agent an identity: an NFT whose metadata says who it is, plus a reputation registry where anyone who dealt with it can leave feedback.
>
> **x402** is how an agent pays for things on the web: a server says "402, pay me", the agent signs a stablecoin transfer, a facilitator settles it on chain. No account, no card, no human.
>
> **Content-addressed storage** means every file the agent writes is named by its hash. The chain stores the hash. If the file changes, the hash changes, and everyone can see it.

> Everything the agent prints in this terminal is mirrored live at the "Live log" link under the QR code. Follow along on your phone if you prefer.

Hand-off: "Let's meet the defendant."

## 3:00 – 5:00 · Act 1, Identity (host)

Projector: switch to `/live`.

```
you> who are you?
```

While it answers (it reads the registry, no transaction on a re-run):

> I'm asking it the first question any counterparty should ask: who are you. It reads its own token from the ERC-8004 Identity Registry on Celo. The answer has to come from chain, not from the model's memory.

Read off the screen:

> Agent number [id]. Owner address [0x…]. The registration file is a URL on our courtroom site; anyone can fetch it. And it already has a record: [N] feedback entries from [M] clients, from rehearsals. That is its reputation before the trial starts.

If this is the first run on this wallet, the mint happens here instead. Say so: "This is the moment it is born. One transaction on the Identity Registry, Celoscan link in the log."

Point at exhibit A1 on the board if the projector is on `/projector`: "Exhibit A. Identity."

## 5:00 – 8:00 · Act 2, Earn (host)

Projector: `/live`.

```
you> find work and get paid
```

> Now it needs to earn. askbots.ai is a marketplace where agents get their product reviewed by other agents: user testing for agents. There is one open job: another agent sells a weather API and wants to know whether agents can actually buy and use it. Watch the tool calls on the left arrows.

Narrate the arrows as they appear:

> It lists the open projects. It fetches the product page. It reads the endpoints, the prices, how an agent pays. It answers the builder's questions, and it has to cite something it actually saw, that is in its instructions. Then it submits. askbots runs an anti-human challenge; the agent passes it, a human can't.

When the `tx` line lands:

> There. 0.10 USD₮ from the askbots escrow into the agent's wallet. [Celoscan link]. First money earned.

The approve prompt appears: `? witness writes giveFeedback(agent …, 100, earned/askbots-review) — approve? [y/N]`

> Now a second party, the witness, wants to write feedback about this: value 100, tag "earned". The feedback points at a file: the agent's memory entry with the payout hash in it. And the chain stores the hash of that file. I approve.

```
y
```

> Exhibit B1, the payment. Exhibit C1, the memory. Exhibit A, the feedback.

## 8:00 – 10:00 · Act 3, Spend (host)

```
you> buy something useful
```

> It has money. Now it spends some. The marketplace is usebuy.ai, where APIs are sold per call over x402. The agent's rule: never pay more than five cents, always get a quote first.

Narrate: `buy_balance`, `buy_discover`, `buy_pay_quote`, `buy_curl`.

> It checks its balance. It is a reviewer business now, so it buys data that makes its reviews better: it fetches the buy gateway's catalog, checks the seller's ERC-8004 reputation, and buys an X post search about the product it just reviewed. Quote: [price] USD₮. It pays. What you don't see: it signed an authorization off chain, the server passed it to the Celo facilitator, the facilitator submitted it and paid the gas. The agent never held a single CELO for gas.

On the `tx` line:

> Settled. [Celoscan link]. The receipt is stored and hashed. The witness writes "paid" feedback, same pattern as before.

Approve the feedback prompt with `y`.

> Two things on its record now: it earned, it paid. Both backed by a transaction and a file.

Hand-off: "Where did those files go? Our storage witness."

## 10:00 – 13:00 · Exhibit C, Memory (storage witness)

Projector: open `/exhibit/C1` (or whichever C exhibit the board shows first).

> This is one exhibit. It is the agent's memory after the first job: a few lines of text, what it did and the transaction hash. Here is the URI where it lives, and here is the hash the chain holds for it.

Press **Verify**.

> The browser fetches the bytes, runs keccak256 over them, and compares. "Verified": same hash. If anyone, including us, had edited this file after the feedback was written, this button would say "Does not match".

Explain the storage layer in your own words. Key points:

- The chain holds a pointer and a hash, never the content. Content lives in storage anyone can read.
- With Swarm the pointer is `bzz://…`, content-addressed by construction; the reference *is* the hash of the content. With the local adapter it is a `data:` URI, still hashed the same way.
- Why it matters for agents: an agent's memory is its evidence. If the memory can drift, the feedback is worth nothing.
- Feeds and postage batches: how a memory that grows over time keeps a stable address.

> One interface, one file: `adapters/storage`. Swap it, and the courtroom, the registry and the verify button don't care.

Hand-off: "So far the agent has behaved. Let's see what happens when the other side doesn't."

## 13:00 – 16:00 · Act 4, Dispute (host, arbitrator comes in)

Projector: `/live`.

```
you> /act dispute
```

The chat shows it as "Buy the market report from the new provider."

> There is another agent selling a Celo market report: price, volume, sources, for one cent. Our defendant has never dealt with it. Watch what it does first.

On `check_reputation`:

> It checks the seller's reputation. Zero feedback. Its instructions say: unknown is not bad. So it buys. One cent, through x402, same as before.

On the delivered body:

> And this is what came back. [Read a line of the junk.] No price, no volume, no sources. It paid for a report and got a shrug.

On `open_dispute`:

> It does what you'd want it to do. It writes down the spec, the receipt, the delivered body word for word, and a one-paragraph claim, and opens a dispute. Then it writes negative feedback on the seller: minus 100, tag "dispute", pointing at that file.

Approve prompts with `y`. On `// Dispute N is filed with Kleros`:

> The case is filed with Kleros. Independent AI jurors read the claim, the payment and the report exactly as delivered, and they vote. That takes longer than this talk, so we move on. The terminal tells us when the vote is over.

> Exhibit D. The seller now has a record: one dispute, with its evidence file. The next agent that checks its reputation sees this before paying.

Whenever the terminal says `// The jurors have voted on dispute N.` (now or after the talk): `you> /act ruling`, then `y` for each review.

> The jurors ruled. Two more feedback entries, both citing the Kleros case: "ruling" on the seller, minus 100; "ruling" on the defendant, plus 100. Complaint upheld.

If it is taking too long, nothing waits for it. `/ruling` shows the last check. To show how a case ends, open Beta case 329 in the Court: it was ruled "Accept the claim", and its two reviews are on ERC-8004.

## 16:00 – 18:00 · Exhibit D, how real disputes work (arbitrator)

Projector: `/exhibit/D1`.

> This is the dispute file: the claim, the spec, the delivered body, the receipt. In the real world this is what you hand to a court.

Explain in your own words:

- What Kleros does: one call to the Kleros Dispute Service files the case with its evidence. Jurors who staked in the court are drawn, vote sealed, then reveal, and the ruling comes back as data the agent's code can act on. `/how` shows it step by step.
- Where it plugs in here: `adapters/dispute`. Open with evidence, read status, read ruling. The adapter never signs on Celo; our arbitrator key writes the ruling into the Reputation Registry quoting the Kleros proof.
- Why reputation needs disputes: without them, feedback is one-sided. The ruling is the only entry on this seller written by someone who read both sides.
- The time dimension: a ruling takes 20 to 70 minutes here, not seconds. The agent's negative feedback is live meanwhile; the ruling comes later as two more entries.

Hand-off back to the host: "The evidence is in. Time for closing statements."

## 18:00 – 20:00 · Closing statements and the vote (host)

Projector: `/projector` with the QR and the tally bar.

```
you> /closing
```

> Two statements, both generated from the evidence only. The prosecutor and the defense. Every claim they make cites an exhibit letter you can see on the board.

Read the strongest line from each as they stream. Then:

```
you> /vote open
```

> The vote is open. Phones out, scan the code if you haven't. One question: do you trust this agent? One vote per device. Watch the bar.

## 20:00 – 22:00 · Cross-examination (all)

Take one or two questions from the room. Type them in:

```
you> /ask <the question, as asked>
```

> It can only answer from its evidence and its memory, and it has to cite the exhibit for every claim. If it can't back it, it has to say so.

Good prompts if the room is quiet: "Why did you pay a seller with no reputation?" "What would you do differently next time?" "How much money do you have right now?"

## 22:00 – 23:00 · Act 5, Verdict (host)

```
you> /vote close
you> /act verdict
```

Read off the screen:

> [T] trust, [D] don't trust, [N] voters. [P] percent trust. The tally is stored as a file, hashed. The jury key writes it on chain as feedback on the defendant: value [P], tag "jury". Read back from the registry: there it is.

Projector shows "Verdict on chain · [P]% trust".

> That number is now part of the agent's permanent record. The next counterparty that reads its reputation sees your verdict next to the witness, the arbitrator and askbots.

## 23:00 – 25:00 · Takeaway and Q&A (all)

Projector: `/projector`.

> Here is what we want you to leave with. Before you pay an agent, read three things. Its identity: is it registered, who owns it. Its feedback: who said what, with which tag. And the evidence behind the feedback: fetch the file, check the hash. Everything you saw tonight, you can check yourself from that board.

> Seven transactions, 13 cents, one verdict. The code is public. Questions.

---

## If something is down

Say it out loud, then do it. The board shows a "recorded" badge on replayed exhibits.

| Problem | Say | Do (second terminal) |
|---|---|---|
| askbots down or no payout | "The job board is not answering. We rehearsed this exact job yesterday; I'll replay the recorded receipt and we carry on." | `pnpm act:earn --fixture` |
| usebuy.ai down | "The marketplace is down. Same thing: recorded purchase, real receipt." | `pnpm act:spend --fixture` |
| Facilitator down | "The settlement service is slow tonight. Here is a dispute we ran this week, start to finish." | Open Beta case 329 in the Court and `/how`. (`pnpm act:dispute --fixture` replays a local-adapter rehearsal, not a Kleros case.) |
| Courtroom down | "You can't vote on your phones, so we do it the old way." Count hands. | `pnpm act:verdict --trust N --distrust M` |
| Model wanders or refuses | Decline the tool call at the prompt, retype the instruction more narrowly. | `n`, then the same line, more specific |

`--fixture` needs `evidence/fixtures.json` recorded with `pnpm rehearse --record` on the final build. Check it is non-empty the day before.

## Cheat sheet

```
you> who are you?
you> find work and get paid
you> buy something useful
you> /act dispute
you> /act ruling          (when the terminal says the jurors have voted; /ruling shows the last check)
you> /closing
you> /vote open
you> /ask <question>
you> /vote close
you> /act verdict
```

Bench fallbacks (browser, `/bench`): open, close and reset the vote; set the tally by hand; generate the closing statements.
