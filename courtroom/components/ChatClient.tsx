'use client';

import { useEffect, useRef, useState } from 'react';
import type { LogLine, VoteTally } from '@trial/shared';
import { Linkify } from './Linkify';
import { TallyBar } from './TallyBar';
import { LogoMark } from './ui/Logo';
import { Pill } from './ui/Pill';
import { usePoll } from '@/lib/use-poll';

const POLL_MS = 2000;

function time(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

function compact(v: unknown, max = 160): string {
  if (v === undefined) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function toolName(line: LogLine): string {
  const name = line.data?.name;
  return typeof name === 'string' ? name : line.text.split('(')[0];
}

function toolArgs(line: LogLine): string {
  const s = compact(line.data?.args ?? line.data?.input);
  return s === '{}' ? '' : s;
}

/** The host's turn: right side, mint outline. */
function HostBubble({ line }: { line: LogLine }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-2xl rounded-br-md border border-mint/60 bg-mint/10 px-4 py-3">
        <div className="eyebrow mb-1 text-mint/80">host · {time(line.at)}</div>
        <p className="text-lg leading-snug text-fg">{line.text}</p>
      </div>
    </div>
  );
}

/** The defendant's turn: left side, with the mark as its avatar. */
function AgentBubble({ line, gateway }: { line: LogLine; gateway: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/5 ring-1 ring-line">
        <LogoMark size={18} />
      </span>
      <div className="max-w-[80%] rounded-2xl rounded-bl-md border border-line bg-white/[0.04] px-4 py-3">
        <div className="eyebrow mb-1 text-fg-3">defendant · {time(line.at)}</div>
        <p className="whitespace-pre-wrap text-lg leading-snug text-fg">
          <Linkify text={line.text} gateway={gateway} />
        </p>
      </div>
    </div>
  );
}

/** A tool call and, when it has arrived, its result, as one small card. */
function ToolCard({ call, result, gateway }: { call: LogLine; result?: LogLine; gateway: string }) {
  const args = toolArgs(call);
  return (
    <details className="ml-11 max-w-[80%] rounded-xl border border-line/70 bg-ink-2/60 text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-fg-2 marker:hidden">
        <span className="text-mint">→</span>
        <span className="font-semibold text-fg">{toolName(call)}</span>
        {args && <span className="min-w-0 truncate text-fg-3">{args}</span>}
        {result && <span className="ml-auto shrink-0 text-mint">←</span>}
      </summary>
      <div className="border-t border-line/60 px-3 py-2 text-fg-2">
        {args && <p className="break-all text-fg-3">{args}</p>}
        {result ? (
          <p className="mt-1 break-words whitespace-pre-wrap">
            <Linkify text={compact(result.text, 800)} gateway={gateway} />
          </p>
        ) : (
          <p className="mt-1 text-fg-3">working…</p>
        )}
      </div>
    </details>
  );
}

function TxLine({ line, gateway }: { line: LogLine; gateway: string }) {
  return (
    <div className="ml-11 flex max-w-[80%] items-start gap-2 rounded-xl border border-mint/50 bg-mint/10 px-3 py-2 text-sm text-mint">
      <Pill tone="mint" className="shrink-0 py-0 text-[10px]">
        tx
      </Pill>
      <span className="min-w-0 break-all">
        <Linkify text={line.text} gateway={gateway} />
      </span>
    </div>
  );
}

/** The short, human part of an error: the reason if the chain gave one, else the first sentence. */
function errorSummary(text: string): string {
  const reason = /reverted with the following reason:\s*\|?\s*([^|]+?)\s*\|/i.exec(text)?.[1];
  if (reason) return `The contract refused: ${reason.trim()}.`;
  if (/exceeds the balance of the account|insufficient funds/i.test(text)) return 'Not enough CELO in the wallet to pay for gas.';
  const first = text.split(/(?<=[.!?])\s|\s\|\s/)[0] ?? text;
  return first.length > 140 ? `${first.slice(0, 140)}…` : first;
}

function SystemLine({ line }: { line: LogLine }) {
  if (line.kind === 'error') {
    return (
      <details className="mx-auto max-w-[80%] rounded-xl border border-rose-400/50 bg-rose-500/10 text-sm text-rose-200">
        <summary className="cursor-pointer list-none px-3 py-2 marker:hidden">
          <span className="eyebrow mr-2 text-[10px] text-rose-300">error</span>
          {errorSummary(line.text)}
        </summary>
        <p className="border-t border-rose-400/30 px-3 py-2 text-xs break-all text-rose-200/80">{line.text}</p>
      </details>
    );
  }
  const tone = line.kind === 'warn' ? 'text-amber-200' : line.kind === 'approve' ? 'text-violet-200' : 'text-fg-3';
  return <p className={`text-center text-xs ${tone}`}>{line.text}</p>;
}

type Item = { kind: 'host' | 'agent' | 'tx' | 'system'; line: LogLine } | { kind: 'tool'; call: LogLine; result?: LogLine };

/**
 * Pair each tool call with the result that follows it, merge consecutive
 * agent lines into one bubble, and show only typed prompts as host bubbles
 * (the terminal marks those with data.prompt; other host lines are narration).
 */
function toItems(lines: LogLine[]): Item[] {
  const items: Item[] = [];
  for (const line of lines) {
    switch (line.kind) {
      case 'host':
        items.push(line.data?.prompt ? { kind: 'host', line } : { kind: 'system', line });
        break;
      case 'agent': {
        const last = items[items.length - 1];
        if (last && last.kind === 'agent') {
          last.line = { ...last.line, text: `${last.line.text}\n${line.text}` };
        } else {
          items.push({ kind: 'agent', line });
        }
        break;
      }
      case 'tx':
        items.push({ kind: line.kind, line });
        break;
      case 'tool_call':
        items.push({ kind: 'tool', call: line });
        break;
      case 'tool_result': {
        // Several calls can run in parallel, so match the result to the
        // oldest unanswered call with the same tool name, else any open call.
        const openCalls = items.filter((it): it is Extract<Item, { kind: 'tool' }> => it.kind === 'tool' && !it.result);
        const name = line.data?.name;
        const open = openCalls.find((it) => it.call.data?.name === name) ?? openCalls[0];
        if (open) open.result = line;
        else items.push({ kind: 'system', line });
        break;
      }
      default:
        items.push({ kind: 'system', line });
    }
  }
  return items;
}

export function ChatClient({ round, voteRound, gateway }: { round: string; voteRound?: string; gateway: string }) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const nextRef = useRef(0);
  const boxRef = useRef<HTMLDivElement>(null);
  // The tally is always the live vote, whatever round the conversation shows.
  const { data: tally } = usePoll<VoteTally>(`/api/vote/tally?round=${encodeURIComponent(voteRound ?? round)}`, POLL_MS);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch(`/api/log?round=${encodeURIComponent(round)}&after=${nextRef.current}`, { cache: 'no-store' });
        const body = (await res.json()) as { lines?: LogLine[]; next?: number; reset?: boolean; error?: string };
        if (!alive) return;
        if (!res.ok) {
          setError(body.error ?? `HTTP ${res.status}`);
          return;
        }
        setError(null);
        if (body.reset) {
          // The log was cleared on the bench: start over instead of waiting past the old end.
          nextRef.current = body.next ?? 0;
          setLines(body.lines ?? []);
        } else if (body.lines && body.lines.length > 0) {
          nextRef.current = body.next ?? nextRef.current + body.lines.length;
          setLines((prev) => [...prev, ...(body.lines as LogLine[])]);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'fetch failed');
      }
    };
    void tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [round]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 240;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  // Setup chatter (info, warnings, approvals) is hidden unless the viewer asks for it.
  const [details, setDetails] = useState(false);
  const quiet = (l: LogLine) => l.kind !== 'info' && l.kind !== 'warn' && l.kind !== 'approve' && (l.kind !== 'host' || Boolean(l.data?.prompt));
  const items = toItems(details ? lines : lines.filter(quiet));

  return (
    <main className="mx-auto flex h-full max-w-4xl flex-col gap-4 px-4 py-4 sm:px-6 sm:py-6">
      <header className="rounded-2xl border border-line bg-white/[0.03] p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-bold sm:text-2xl">The trial, as a conversation</h1>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setDetails((d) => !d)}
              aria-pressed={details}
              className="eyebrow rounded-full border border-line px-3 py-1 text-fg-3 hover:text-fg"
            >
              {details ? 'hide details' : 'show details'}
            </button>
            <Pill tone="neutral">round {round}</Pill>
          </div>
        </div>
        <div className="mt-3">
          <TallyBar tally={tally} />
        </div>
      </header>
      <div ref={boxRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto rounded-2xl border border-line bg-ink-2/40 px-4 py-4 sm:px-5">
        {items.length === 0 && !error && (
          <div className="py-10 text-center text-fg-3">
            <p>Waiting for the agent.</p>
            <p className="mt-2 text-xs">The host talks to the defendant from the stage terminal. The conversation appears here as it happens.</p>
          </div>
        )}
        {items.map((it, i) => {
          switch (it.kind) {
            case 'host':
              return <HostBubble key={i} line={it.line} />;
            case 'agent':
              return <AgentBubble key={i} line={it.line} gateway={gateway} />;
            case 'tool':
              return <ToolCard key={i} call={it.call} result={it.result} gateway={gateway} />;
            case 'tx':
              return <TxLine key={i} line={it.line} gateway={gateway} />;
            default:
              return <SystemLine key={i} line={it.line} />;
          }
        })}
        {error && <p className="py-2 text-center text-rose-300">{error}</p>}
      </div>
    </main>
  );
}
