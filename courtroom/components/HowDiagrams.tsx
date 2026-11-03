import type { CSSProperties } from 'react';
import { Reveal } from './Reveal';

/** One small diagram per point of the page. Beats are ordered by --i; see globals.css. */
const beat = (i: number, extra: Record<string, string | number> = {}) => ({ '--i': i, ...extra }) as CSSProperties;

/** Machine native: the agent pays, files and gets its ruling back as data, each a call. */
export function CallDiagram() {
  const calls = [
    { call: 'agent.pay(x402)', out: 'settled on Celo' },
    { call: 'court.file(case, evidence)', out: 'dispute filed' },
    { call: 'jurors.vote()', out: 'sealed, then revealed' },
    { call: 'ruling', out: '“Accept the claim”' },
    { call: 'reputation.write(ERC-8004)', out: '−100 provider · +100 buyer' },
  ];
  return (
    <Reveal label="The agent pays, files the case, the jurors vote, the ruling comes back and is written into reputation, each step a call">
      <div className="space-y-2 font-mono text-base">
        {calls.map((c, i) => (
          <div key={c.call} className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="text-neutral-200" data-beat style={beat(i * 4)}>
              {c.call}
            </span>
            <span className="text-emerald-300" data-beat style={beat(i * 4 + 2)}>
              → {c.out}
            </span>
          </div>
        ))}
      </div>
    </Reveal>
  );
}

/** A pool of stakers; the draw picks a few, the bigger stakes more often. */
export function DrawDiagram() {
  const stakes = [3, 1, 2, 1, 4, 1, 2, 1, 1, 3, 1, 2, 1, 1, 2, 4, 1, 1, 2, 1, 3, 1];
  const drawn = new Map([
    [4, 0],
    [9, 1],
    [15, 2],
  ]);
  return (
    <Reveal label="A pool of jurors with different stakes; three are drawn at random, the bigger stakes more often">
      <div className="flex flex-wrap items-center gap-3">
        {stakes.map((s, i) => {
          const pick = drawn.get(i);
          return (
            <span
              key={i}
              className={`juror ${pick === undefined ? 'is-pool' : 'is-drawn'}`}
              data-beat={pick === undefined ? 'pool' : 'drawn'}
              style={beat(i * 0.25, { '--s': `${10 + s * 6}px`, '--p': pick ?? 0 })}
            />
          );
        })}
      </div>
      <p className="mt-3 font-mono text-sm text-neutral-500" data-beat style={beat(24)}>
        size = stake · three drawn
      </p>
    </Reveal>
  );
}

/** Sealed, then revealed: the majority is the Schelling point, and it pays to be on it. */
export function VoteDiagram() {
  const votes = [
    { answer: 'Accept', coherent: true },
    { answer: 'Accept', coherent: true },
    { answer: 'Reject', coherent: false },
  ];
  return (
    <Reveal label="Three sealed votes are revealed; two agree and share the fees, the third loses part of its stake">
      <div className="grid grid-cols-3 gap-3">
        {votes.map((v, i) => (
          <div key={i} className="vote" data-beat style={beat(i)}>
            <span className="vote-face is-sealed" data-beat="unseal" style={beat(6 + i * 2)}>
              ● ● ●
            </span>
            <span className={`vote-face is-open ${v.coherent ? 'text-emerald-300' : 'text-neutral-300'}`} data-beat="open" style={beat(6 + i * 2)}>
              {v.answer}
            </span>
            <span className={`chip ${v.coherent ? 'text-emerald-300' : 'text-rose-300'}`} data-beat style={beat(14 + i)}>
              {v.coherent ? '+ fees' : '− stake'}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-3 font-mono text-sm text-neutral-500" data-beat style={beat(4)}>
        sealed first
      </p>
    </Reveal>
  );
}

/** Wrong, appealed, up to humans, and the open question: would you overturn? */
export function AppealDiagram() {
  const rows = [
    { dots: 3, wrong: 1, human: false, label: 'a panel can be wrong' },
    { dots: 7, wrong: 0, human: false, label: 'appeal · a bigger panel' },
    { dots: 7, wrong: 0, human: true, label: 'human jurors · being built' },
  ];
  return (
    <Reveal label="A first panel can be wrong; an appeal draws a bigger panel; above it sit human jurors; and the question: would you overturn seven of seven?">
      <div className="space-y-3">
        {rows.map((r, ri) => (
          <div key={ri} className="flex flex-wrap items-center gap-2">
            {Array.from({ length: r.dots }, (_, i) => (
              <span key={i} className={`dot ${r.human ? 'is-human' : ''} ${i < r.wrong ? 'is-wrong' : ''}`} data-beat="pop" style={beat(ri * 6 + i * 0.3)} />
            ))}
            <span className="ml-2 font-mono text-sm text-neutral-500" data-beat style={beat(ri * 6 + 2)}>
              {r.label}
            </span>
          </div>
        ))}
        <p className="pt-1 font-mono text-base text-neutral-200" data-beat style={beat(20)}>
          7 of 7 agree. Would you overturn them?
        </p>
      </div>
    </Reveal>
  );
}
