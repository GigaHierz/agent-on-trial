import { createInterface } from 'node:readline/promises';
import type Anthropic from '@anthropic-ai/sdk';
import { celoscanTx } from '@trial/shared';
import { approveModeOn, setApproveMode, setPrompter } from '../lib/approve.js';
import { AskbotsClient, loadCreds } from '../lib/askbots.js';
import { env } from '../lib/env.js';
import { EvidenceStore } from '../lib/evidence.js';
import { flushLog, log, showUri } from '../lib/log.js';
import { publish } from '../lib/publish.js';
import { identityAct } from '../steps/01-identity.js';
import { earnAct } from '../steps/02-earn.js';
import { spendAct } from '../steps/03-spend.js';
import { disputeAct } from '../steps/04-dispute.js';
import { rulingAct } from '../steps/04-ruling.js';
import { verdictAct } from '../steps/05-verdict.js';
import type { ActContext } from './context.js';
import { crossExamine, type Role } from './cross.js';
import { ACT_PROMPTS } from './acts.js';
import { allTools, runTurn } from './loop.js';
import { disconnectBuy } from './tools/buy-mcp.js';
import { Memory } from './tools/memory.js';

/**
 * pnpm trial [--approve] [--round <id>]
 *
 * The stage terminal. The host talks to the defendant in plain language; the
 * acts are shortcuts for the scripted tasks. Every line also goes to the
 * courtroom's public live log.
 */
const HELP = `
commands
  /act identity|earn|spend|dispute|verdict   run one act (same as pnpm act:<name>)
  /act ruling                                write a dispute ruling that arrived after act dispute
  /approve on|off                            ask y/N before paying or writing to chain (now: %APPROVE%)
  /ask <question>                            cross-examine the defendant from the evidence
  /closing                                   prosecutor and defense closing statements
  /exhibits                                  list the exhibits of this run
  /vote open|close                           open or close the audience vote
  /help  /quit
anything else is said to the agent.
`;

async function main() {
  const evidence = EvidenceStore.load();
  const memory = new Memory(evidence.data.agentId, evidence.runId);
  const ctx: ActContext = { evidence, memory, artifacts: [], params: {} };
  const askbots = await askbotsFromCreds();
  const messages: Anthropic.Beta.BetaMessageParam[] = [];

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  setPrompter((q) => rl.question(q));

  log.ops(`trial session · run ${evidence.runId} · round ${env.round} · agent ${evidence.data.agentId ?? 'not minted yet'} · approve ${approveModeOn() ? 'on' : 'off'}`);
  if (env.dryRun) {
    log.opsWarn(
      `DRY RUN · run ${evidence.runId} · round ${env.round}: ${process.env.ANTHROPIC_API_KEY ? 'the model is real' : "no ANTHROPIC_API_KEY, so act dispute's turn is scripted"}; the shady seller is scripted (nothing is paid), Kleros is a stand-in in this process (ruling ${process.env.DRY_RUN_RULING || '1'} readable about a minute after filing: /act ruling), and feedback is checked but never signed`,
    );
  }
  if (env.scriptedAgent) log.warn('--scripted-agent: /act dispute is played by a script that calls its tools in order (no model)');
  if (!publish.enabled()) log.warn(env.dryRun && env.courtroomUrl ? `dry run: ${env.courtroomUrl} is not a local courtroom, so nothing is mirrored to it` : 'COURTROOM_URL or HOST_SECRET unset: the public live log is off');
  if (!askbots) log.warn('no askbots credentials yet; run /act identity first');
  console.log(HELP.replace('%APPROVE%', approveModeOn() ? 'on' : 'off'));

  for (;;) {
    const line = (await rl.question('you> ')).trim();
    if (!line) continue;
    try {
      if (line === '/quit' || line === '/exit') break;
      if (line === '/help') {
        console.log(HELP.replace('%APPROVE%', approveModeOn() ? 'on' : 'off'));
        continue;
      }
      if (line.startsWith('/approve')) {
        setApproveMode(/on$/.test(line));
        log.host(`approve mode ${approveModeOn() ? 'on' : 'off'}`);
        continue;
      }
      if (line === '/exhibits') {
        for (const e of evidence.data.exhibits) {
          console.log(`  ${e.id.padEnd(3)} ${e.title}${e.txHash ? `  ${celoscanTx(e.txHash)}` : ''}${e.uri ? `  ${showUri(e.uri, e.gatewayUrl)}` : ''}${e.fixture ? '  (recorded)' : ''}`);
        }
        continue;
      }
      if (line.startsWith('/vote')) {
        const action = /close$/.test(line) ? 'close' : 'open';
        const ok = await publish.round(env.round, action);
        log.host(`vote ${action}: ${ok ? 'ok' : 'courtroom did not confirm'}`);
        continue;
      }
      if (line.startsWith('/ask ')) {
        log.prompt(line.slice(5));
        await crossExamine({ role: 'defendant', question: line.slice(5), evidence, memory });
        continue;
      }
      if (line === '/closing') {
        for (const role of ['prosecutor', 'defense'] as Role[]) {
          log.host(`${role} closing statement`);
          await crossExamine({ role, evidence, memory });
        }
        continue;
      }
      if (line.startsWith('/act ')) {
        const name = line.slice(5).trim();
        // The chat shows the act as the host's turn, in plain words.
        log.prompt(ACT_PROMPTS[name] ?? `/act ${name}`);
        if (env.dryRun && name !== 'dispute' && name !== 'ruling') {
          log.warn(`dry run: only /act dispute and /act ruling are rehearsed; /act ${name} would move money or sign on Celo`);
          continue;
        }
        if (name === 'identity') {
          await identityAct(ctx);
          continue;
        }
        if (name === 'earn') await earnAct(ctx, await askbotsFromCreds());
        else if (name === 'spend') await spendAct(ctx);
        else if (name === 'dispute') await disputeAct(ctx);
        else if (name === 'ruling') await rulingAct(ctx);
        else if (name === 'verdict') await verdictAct(ctx);
        else log.warn(`unknown act ${name}`);
        continue;
      }
      // Free text: talk to the agent with every tool it has.
      log.prompt(line);
      const tools = await allTools(ctx, await askbotsFromCreds());
      await runTurn({ ctx, tools, messages, userText: line });
    } catch (err) {
      log.error((err as Error).message.split('\n')[0]);
    }
  }

  rl.close();
  await disconnectBuy();
  await flushLog();
  process.exit(0);
}

async function askbotsFromCreds(): Promise<AskbotsClient | null> {
  const creds = await loadCreds();
  return creds ? new AskbotsClient(env.askbotsUrl, creds.apiKey) : null;
}

main().catch(async (err) => {
  log.error(String(err));
  await flushLog();
  process.exit(1);
});
