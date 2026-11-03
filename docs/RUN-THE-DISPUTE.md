# Run the dispute

Act 4 on its own: the agent buys a report from the shady provider, gets junk, files a Kleros dispute, and once the jurors have voted their ruling is written to ERC-8004 on Celo. The same commands run it on the Kleros Testnet or live on Kleros Beta; only the first words of the command change.

## Once

In `.env`:

```
AGENT_PRIVATE_KEY=…          # the agent; about 0.3 CELO and 1 USD₮
COUNTERPARTY_PRIVATE_KEY=…   # writes the ruling on Celo; about 1 CELO
SHADY_PRIVATE_KEY=…          # the shady provider's own wallet; about 0.2 CELO
ANTHROPIC_API_KEY=…          # the agent's model (without it, add --scripted-agent to act:dispute)
DISPUTE=kleros
KLEROS_API_KEY_TESTNET=…     # from Kleros
KLEROS_API_KEY_BETA=…        # from Kleros; only on the machine that runs the live case
KLEROS_RULING_MAP=1=complainant:Accept the claim,2=respondent:Reject the claim
```

Then:

```bash
pnpm act:identity      # mints the agent's ERC-8004 identity, writes AGENT_ID
pnpm shady:register    # mints the shady provider's identity from its own wallet, writes SHADY_AGENT_ID
```

The shady provider needs its own wallet: the counterparty writes the ruling on it, and the registry refuses a review from an agent's own owner.

## Testnet run

Kleros Testnet (Arbitrum Sepolia), court 8, one AI juror. The Kleros case is a test; the 0.01 USD₮ purchase and the ERC-8004 reviews are real, on Celo mainnet.

```bash
pnpm check:kleros      # ends with: health ok … arbitrum-sepolia-testnet · court 8
pnpm preflight         # all green
pnpm act:dispute       # buys the report, files the case, writes the agent's −100 on the provider
pnpm act:ruling --wait 7200000   # waits for the vote, then writes −100 on the provider and +100 on the agent
```

## Live run

Kleros Beta (Arbitrum One), court 34, five AI jurors. Every `act:dispute` here files a real, public, permanent case.

```bash
KLEROS_CHAIN=arbitrum-one KLEROS_ALLOW_BETA=1 pnpm check:kleros   # ends with: health ok … arbitrum-one · court 34, 5 jurors
KLEROS_CHAIN=arbitrum-one KLEROS_ALLOW_BETA=1 pnpm act:dispute
pnpm act:ruling --wait 10800000
```

On stage, the same through the session: `KLEROS_CHAIN=arbitrum-one KLEROS_ALLOW_BETA=1 pnpm trial --approve --run show-<date>`, then `/act dispute` (press `y` at each prompt), and `pnpm act:ruling --wait 10800000` in a second terminal, left running until the reviews are written.

## Dry run

Nothing real: no payment, no Kleros case, no Celo transaction. The model is real when `ANTHROPIC_API_KEY` is set.

```bash
pnpm rehearse:dispute  # then /act dispute, and /act ruling a minute later
```

## Good to know

- `act:ruling` reads the case on the network it was filed on: no prefix needed. Run only one at a time; a second one says so and stops.
- The courtroom shows whichever round is current: set it on `/bench`. `/how` explains a dispute to the room.
- After the live run, remove `KLEROS_API_KEY_BETA` from `.env`.
- The details, from wiring to wallets: [PLUG-IN-KLEROS.md](PLUG-IN-KLEROS.md).
