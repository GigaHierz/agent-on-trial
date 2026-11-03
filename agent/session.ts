import { createInterface } from 'node:readline/promises';
import type Anthropic from '@anthropic-ai/sdk';
import { celoscanTx } from '@trial/shared';
import { approveModeOn, setApproveMode, setPrompter } from '../lib/approve.js';
import { AskbotsClient, loadCreds } from '../lib/askbots.js';
import { env } from '../lib/env.js';
import { EvidenceStore, replayFixture } from '../lib/evidence.js';
import { flushLog, log, showUri } from '../lib/log.js';
import { publish } from '../lib/publish.js';
import { hasRecordedLog, replayLog } from '../lib/replay.js';
import { identityAct } from '../steps/01-identity.js';
import { earnAct } from '../steps/02-earn.js';
import { spendAct } from '../steps/03-spend.js';
import { disputeAct } from '../steps/04-dispute.js';
import { rulingAct, watchRuling, type RulingWatch } from '../steps/04-ruling.js';
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
  /act ruling [id]                           check the dispute's ruling now and write it if the vote is over
  /ruling [stop|watch]                       after /act dispute the ruling is watched in the background and
                                             written when it comes: last check, stop waiting, watch again
  /approve on|off                            ask y/N before paying or writing to chain (now: %APPROVE%)
  /ask <question>                            cross-examine the defendant from the evidence
  /closing                                   prosecutor and defense closing statements
  /exhibits                                  list the exhibits of this run
  /vote open|close                           open or close the audience vote
  /help  /quit
anything else is said to the agent.
with --step: an empty line runs the next step of the show, and a step that fails offers the recorded rehearsal.
`;

/** The show, in order. With --step, Enter runs the next one. /ask and /act ruling stay manual. */
const STEPS = ['/act identity', '/act earn', '/act spend', '/act dispute', '/closing', '/vote open', '/vote close', '/act verdict'];
/** Acts that have a recorded rehearsal (exhibits in evidence/fixtures.json, lines in evidence/fixture-log.json). */
const REPLAYABLE = new Set(['identity', 'earn', 'spend', 'dispute']);

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
      `DRY RUN · run ${evidence.runId} · round ${env.round}: ${process.env.ANTHROPIC_API_KEY ? 'the model is real' : "no ANTHROPIC_API_KEY, so act dispute's turn is scripted"}; the shady seller is scripted (nothing is paid), Kleros is a stand-in in this process (ruling ${process.env.DRY_RUN_RULING || '1'} readable about a minute after filing, then written by the watch: /ruling), and feedback is checked but never signed`,
    );
  }
  if (env.scriptedAgent) log.warn('--scripted-agent: /act dispute is played by a script that calls its tools in order (no model)');
  if (!publish.enabled()) log.warn(env.dryRun && env.courtroomUrl ? `dry run: ${env.courtroomUrl} is not a local courtroom, so nothing is mirrored to it` : 'COURTROOM_URL or HOST_SECRET unset: the public live log is off');
  if (!askbots) log.warn('no askbots credentials yet; run /act identity first');
  console.log(HELP.replace('%APPROVE%', approveModeOn() ? 'on' : 'off'));

  // The ruling watch writes in the background, but never during a command: what it has to do runs at once
  // while the host sits at the prompt (aside, which the next command waits for), or else waits for the
  // command to end (queued).
  let atPrompt = false;
  // Set from the watch's timers, so TypeScript must not narrow them to their initial null.
  let queued = null as (() => Promise<void>) | null;
  let aside = null as Promise<void> | null;
  const runSafely = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      log.error((err as Error).message.split('\n')[0]);
    }
  };
  const startAside = (fn: () => Promise<void>) => {
    if (atPrompt && process.stdout.isTTY) process.stdout.write('\r\x1b[2K'); // the ruling prints over the empty prompt, not after it
    aside = runSafely(fn).finally(() => {
      aside = null;
      if (atPrompt) rl.prompt(true); // the prompt again, with whatever the host had typed
    });
  };
  const whenIdle = (fn: () => Promise<void>) => {
    if (!atPrompt || aside) queued = fn;
    else startAside(fn);
  };
  let watch = null as RulingWatch | null;
  const startWatch = (quiet: boolean) => {
    watch?.stop();
    try {
      watch = watchRuling(ctx, { whenIdle, approveOn: approveModeOn });
    } catch (err) {
      watch = null; // a broken ledger file must not stop the session; /act ruling says what is wrong
      log.opsWarn(`the ruling watch did not start: ${(err as Error).message.split('\n')[0]}`);
      return;
    }
    if (watch) log.ops(`watching dispute ${watch.disputeId} for its ruling, every ${Math.round(env.rulingPollMs / 1000)} s; the show goes on. /ruling for the last check, /ruling stop to stop waiting`);
    else if (!quiet) log.ops('no pending ruling in this run');
  };
  startWatch(true); // a session restarted mid-show picks the pending ruling up again

  // --step: Enter runs the next step; the prompt says which one.
  let stepIndex = 0;
  const nextStep = () => (env.step && stepIndex < STEPS.length ? STEPS[stepIndex] : null);
  if (env.step) log.ops(`step mode: press Enter to run each step in order (${STEPS.join(' → ')}); type any command to do something else`);

  /** A live act, and when it fails and a rehearsal was recorded, the offer to replay that instead. */
  const runLiveOrReplay = async (name: string, live: () => Promise<unknown>) => {
    const errorsBefore = log.errorCount();
    try {
      await live();
    } catch (err) {
      log.error((err as Error).message.split('\n')[0]);
    }
    if (log.errorCount() === errorsBefore || !REPLAYABLE.has(name) || !hasRecordedLog(name)) return;
    const answer = (await rl.question(`${name} hit an error. Replay the recorded rehearsal instead? [Y/n] `)).trim().toLowerCase();
    if (answer && answer !== 'y' && answer !== 'yes') return;
    log.ops(`replaying the recorded ${name} act`);
    try {
      replayFixture(evidence, name as 'identity');
    } catch (err) {
      log.ops(`no recorded exhibits for ${name}: ${(err as Error).message.split('\n')[0]}`);
    }
    await replayLog(name);
  };

  for (;;) {
    // Work that waited for the last command runs beside the prompt, so a line typed meanwhile is kept.
    if (queued && !aside) {
      const fn = queued;
      queued = null;
      startAside(fn);
    }
    atPrompt = true;
    const hint = nextStep();
    let line = (await rl.question(hint ? `[Enter → ${hint}] you> ` : 'you> ')).trim();
    atPrompt = false;
    if (!line) {
      if (!hint) continue;
      line = hint;
      stepIndex++;
      console.log(`you> ${line}`);
    }
    if (aside) {
      log.ops('the ruling is being written; your command runs right after');
      await aside;
    }
    try {
      if (line === '/quit' || line === '/exit') break;
      if (line === '/help') {
        console.log(HELP.replace('%APPROVE%', approveModeOn() ? 'on' : 'off'));
        continue;
      }
      if (line === '/ruling' || line.startsWith('/ruling ')) {
        const what = line.slice(7).trim();
        if (what === 'watch') startWatch(false);
        else if (!watch) log.ops('not watching a ruling; /ruling watch watches the latest pending one');
        else if (what === 'stop') {
          watch.stop();
          log.ops(`stopped watching dispute ${watch.disputeId}. It stays pending: /act ruling here, or pnpm act:ruling in any terminal, writes it once the jurors have voted`);
          watch = null;
        } else log.ops(`dispute ${watch.disputeId}: ${watch.status()}`);
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
        const [name, arg] = line.slice(5).trim().split(/\s+/);
        // The chat shows the act as the host's turn, in plain words.
        log.prompt(ACT_PROMPTS[name] ?? `/act ${name}`);
        if (env.dryRun && name !== 'dispute' && name !== 'ruling') {
          log.warn(`dry run: only /act dispute and /act ruling are rehearsed; /act ${name} would move money or sign on Celo`);
          continue;
        }
        if (name === 'identity') {
          await runLiveOrReplay('identity', () => identityAct(ctx));
          continue;
        }
        if (name === 'earn') await runLiveOrReplay('earn', async () => earnAct(ctx, await askbotsFromCreds()));
        else if (name === 'spend') await runLiveOrReplay('spend', () => spendAct(ctx));
        else if (name === 'dispute') {
          try {
            await runLiveOrReplay('dispute', () => disputeAct(ctx));
          } finally {
            startWatch(true); // filed and not ruled yet: the show goes on, the ruling comes when it comes
          }
        }
        else if (name === 'ruling') await rulingAct(ctx, { disputeId: arg });
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

  watch?.stop();
  if (aside) await aside; // a ruling being written finishes before the session ends
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
