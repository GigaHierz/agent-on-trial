'use client';

import { useEffect, useRef, useState } from 'react';
import type { LogLine, VoteTally } from '@trial/shared';
import { Linkify } from './Linkify';
import { TallyBar } from './TallyBar';
import { Pill, type PillTone } from './ui/Pill';
import { usePoll } from '@/lib/use-poll';

const POLL_MS = 2000;

function time(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-GB', { hour12: false });
}

function compact(v: unknown): string {
  if (v === undefined) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

function toolCallLabel(line: LogLine): string {
  const name = line.data?.name;
  if (typeof name === 'string') return `${name}(${compact(line.data?.args ?? line.data?.input)})`;
  return line.text;
}

/** How each kind of line is labelled and coloured. */
const KINDS: Record<string, { label: string; tone: PillTone; text: string }> = {
  host: { label: 'host', tone: 'mint', text: 'text-lg font-bold text-fg' },
  tool_call: { label: 'call', tone: 'neutral', text: 'text-sm text-sky-300' },
  tool_result: { label: 'result', tone: 'neutral', text: 'text-sm text-fg-3' },
  tx: { label: 'tx', tone: 'mint', text: 'text-base text-mint' },
  warn: { label: 'warn', tone: 'amber', text: 'text-base text-amber-200' },
  error: { label: 'error', tone: 'rose', text: 'text-base text-rose-300' },
  approve: { label: 'approve', tone: 'violet', text: 'text-base text-violet-200' },
  info: { label: 'info', tone: 'neutral', text: 'text-sm text-fg-2' },
  agent: { label: 'agent', tone: 'neutral', text: 'text-base text-fg' },
};

function Line({ line, gateway }: { line: LogLine; gateway: string }) {
  const kind = KINDS[line.kind] ?? { label: line.kind, tone: 'neutral' as PillTone, text: 'text-base text-fg' };
  const body =
    line.kind === 'tool_call' ? (
      <>→ {toolCallLabel(line)}</>
    ) : line.kind === 'tool_result' ? (
      <>
        ← <Linkify text={line.text} gateway={gateway} />
      </>
    ) : line.kind === 'warn' || line.kind === 'error' || line.kind === 'approve' ? (
      line.text
    ) : (
      <Linkify text={line.text} gateway={gateway} />
    );
  return (
    <div className="grid grid-cols-[auto_auto_1fr] items-baseline gap-x-3 gap-y-1 border-b border-line/60 py-2 last:border-0">
      <span className="text-xs tabular-nums text-fg-3">{time(line.at)}</span>
      <Pill tone={kind.tone} className="py-0 text-[10px]">
        {kind.label}
      </Pill>
      <span className={`min-w-0 break-words ${kind.text}`}>{body}</span>
    </div>
  );
}

export function LiveClient({ round, voteRound, gateway }: { round: string; voteRound?: string; gateway: string }) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const nextRef = useRef(0);
  const boxRef = useRef<HTMLDivElement>(null);
  // The tally is always the live vote, whatever round the log shows.
  const { data: tally } = usePoll<VoteTally>(`/api/vote/tally?round=${encodeURIComponent(voteRound ?? round)}`, POLL_MS);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch(`/api/log?round=${encodeURIComponent(round)}&after=${nextRef.current}`, {
          cache: 'no-store',
        });
        const body = (await res.json()) as { lines?: LogLine[]; next?: number; error?: string };
        if (!alive) return;
        if (!res.ok) {
          setError(body.error ?? `HTTP ${res.status}`);
          return;
        }
        setError(null);
        if (body.lines && body.lines.length > 0) {
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

  // Follow the tail unless the reader scrolled up to look at something.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 240;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  return (
    <main className="mx-auto flex h-[calc(100vh-57px)] max-w-4xl flex-col gap-4 px-4 py-4 sm:px-6 sm:py-6">
      <header className="rounded-2xl border border-line bg-white/[0.03] p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-bold sm:text-2xl">Live transcript</h1>
          <Pill tone="neutral">round {round}</Pill>
        </div>
        <div className="mt-3">
          <TallyBar tally={tally} />
        </div>
      </header>
      <div ref={boxRef} className="min-h-0 flex-1 overflow-y-auto rounded-2xl border border-line bg-ink-2/60 px-4 py-2 sm:px-5">
        {lines.length === 0 && !error && <p className="py-4 text-fg-3">Waiting for the agent.</p>}
        {lines.map((line, i) => (
          <Line key={i} line={line} gateway={gateway} />
        ))}
        {error && <p className="py-2 text-rose-300">{error}</p>}
      </div>
    </main>
  );
}
