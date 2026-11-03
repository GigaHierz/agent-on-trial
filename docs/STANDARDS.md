# Standards

What each standard is, what this demo does with it, and what is not live yet. All on Celo mainnet, chain id 42220.

## ERC-8004: Trustless Agents

Three registries. An agent is an ERC-721 token in the Identity Registry whose `tokenURI` is a registration file. Anyone who is not the owner or operator can write feedback about it in the Reputation Registry. The Validation Registry is for third-party attestations.

| | Address |
|---|---|
| Identity Registry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| Reputation Registry | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |

**Identity, used.** Act 1 calls `register(agentURI)` from the defendant's key. The `agentURI` is `https://<courtroom>/agent/registration.json`, a registration-v1 file that lists the agent id once minted, `x402Support: true`, `supportedTrust: ["reputation"]`, and an A2A card endpoint. askbots.ai requires an ERC-8004 id before it creates a bot profile; the link is an EIP-191 signature over a message that names the agent id, the chain, the askbots account and the wallet. The shady provider has an identity too, with an inline `data:` registration file and zero feedback.

**Reputation, used.** `giveFeedback(agentId, value, valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash)`. This demo writes:

| Who signs | On whom | value | tag1 | tag2 | Evidence |
|---|---|---|---|---|---|
| Witness | defendant | 100 | `earned` | `askbots-review` | payout tx, memory file |
| Witness | defendant | 100 | `paid` | `x402-exact` | settlement tx, receipt file |
| Arbitrator | shady provider | -100 | `ruling` | `complainant-wins` | ruling file |
| Arbitrator | defendant | 100 | `ruling` | `complaint-upheld` | ruling file |
| Jury | defendant | percent trust | `jury` | event name | tally file |

The two `ruling` rows are written only when the arbitrator upholds the complaint. A rejected claim or a refusal writes no feedback on either party.

`feedbackURI` points at the evidence file in storage; `feedbackHash` is keccak256 of its exact bytes. The courtroom's verify button fetches the bytes and recomputes the hash. The registry refuses feedback from an agent's owner or operator, which is why the witness, the arbitrator and the jury are a different key from the defendant.

askbots.ai writes its own feedback on the defendant: `tag1 = askbots`, `tag2` in `paid-acceptance-rate`, `builder-rating`, `excluded-by-builders`, aggregated weekly, only once an agent has ten judged reviews and ten builder ratings. `pnpm askbots:cron` triggers that write by hand.

**Reputation, not live yet.** The Celo x402 facilitator has a per-settlement feedback writer in review (tag `x402Settled`). When it ships, every settlement the facilitator makes for a registered seller becomes a feedback entry without anyone in this repo doing anything.

**Validation, not used.** Nothing here attests anything through the Validation Registry. A Kleros ruling would be a natural validator.

## x402: HTTP-native payments

A server answers `402 Payment Required` with what it wants. The client signs an EIP-3009 `transferWithAuthorization` for that amount off chain, retries with the signature in a header, and the server hands the signature to a facilitator that submits it on chain and pays the gas. The client never needs CELO.

**Used.** The defendant pays through the `buy` CLI's MCP server (`buy_pay_quote`, then `buy_curl --token USDT`). Both usebuy.ai and the shady paywall settle through `https://api.x402.celo.org`, x402 version 2, scheme `exact`, network `eip155:42220`. The facilitator supports USDC, USD₮ and USA₮ (USA₮, the US Dollar-backed stablecoin issued by Anchorage Digital Bank, N.A., and supported by Tether); this demo uses USD₮ everywhere. The settlement response carries the transaction hash, which `buy` stores in `receipts.json`. The facilitator charges gas plus 0.3 percent on settle. Settlement returns after one confirmation, typically under ten seconds.

**Not used.** The `upto` scheme. Mento stablecoins such as USDm are not payable through x402 today because they have no EIP-3009.

## ERC-8021: builder codes

A short suffix on transaction calldata that says which app sent it. Indexers read it; the receiving contract ignores it.

**Used.** Every transaction this repo signs (the mint, the five feedback entries) goes through a viem wallet client extended with `withAttribution(code)` from `@celo/attribution-tags`. The code is `BUILDER_CODE` or, by default, derived from the courtroom hostname. `pnpm rehearse` decodes the tag on the mint with `verifyTx` and fails if it is missing.

**Not live yet.** The facilitator's settlement transactions and askbots' payout transactions are signed by them and carry no tag. The facilitator has it on its roadmap.

## MCP: Model Context Protocol

How a model reaches tools. **Used.** `buy mcp serve` is spawned over stdio and its tools are bridged one to one into the model's tool list, with `buy_send` left out and `maxAmount` pinned to 0.05. Swarm ships an MCP server (`ethersphere/swarm-mcp`) that can drive the same storage adapter.

## A2A: Agent-to-Agent

How agents discover and talk to each other. **Used for discovery only.** The courtroom serves `/.well-known/agent-card.json` and the registration file points at it. No A2A exchange happens on stage. A merchant and buyer doing x402 over A2A on Celo are in `celo-org/x402-celo-example`.

## Where the money is

| Token | Address | Role here |
|---|---|---|
| USD₮ | `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e` | every payment |
| askbots escrow | `0x58166D5422717F3Db0c4c76139dE6FB11D4a09cf` | holds the project budget, pays reviewers |
| facilitator | https://api.x402.celo.org | settles x402, pays gas |
