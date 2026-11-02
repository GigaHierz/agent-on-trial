'use client';

import { useState } from 'react';
import { askStream, type AskRole } from '@/lib/ask-client';
import { Cited } from './Cited';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { Pill } from './ui/Pill';

interface Exchange {
  role: AskRole;
  question: string;
  answer: string;
  error?: string;
}

const KEEP = 5;

export function CrossClient({ round }: { round: string }) {
  const [role, setRole] = useState<AskRole>('defendant');
  const [question, setQuestion] = useState('');
  const [items, setItems] = useState<Exchange[]>([]);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (busy) return;
    const q = question.trim();
    const entry: Exchange = { role, question: q || '(closing statement)', answer: '' };
    setItems((prev) => [entry, ...prev].slice(0, KEEP));
    setBusy(true);
    setQuestion('');
    const update = (patch: Partial<Exchange>) =>
      setItems((prev) => prev.map((it) => (it === entry ? Object.assign(entry, patch) : it)).slice());
    try {
      await askStream({ round, role, question: q || undefined }, (text) => update({ answer: text }));
    } catch (e) {
      update({ error: e instanceof Error ? e.message : 'failed' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-10 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-bold sm:text-4xl">Cross-examination</h1>
        <Pill tone="mint">round {round}</Pill>
      </header>

      <Card>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-wrap gap-2">
            {(['defendant', 'prosecutor', 'defense'] as AskRole[]).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRole(r)}
                className={`rounded-full border px-4 py-1.5 text-sm capitalize transition-colors ${
                  role === r ? 'border-mint bg-mint text-ink' : 'border-line text-fg-2 hover:text-fg'
                }`}
              >
                {r}
              </button>
            ))}
          </div>
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={3}
            placeholder={role === 'defendant' ? 'Ask the defendant.' : 'Optional. Leave empty for the closing statement.'}
            className="rounded-xl border border-line bg-white/5 px-4 py-3 text-lg focus:border-mint focus:outline-none"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
            }}
          />
          <Button type="submit" variant="primary" className="self-start" disabled={busy}>
            {busy ? 'Answering…' : 'Ask'}
          </Button>
        </form>
      </Card>

      <section className="flex flex-col gap-4">
        {items.map((it, i) => (
          <Card key={i}>
            <p className="eyebrow text-fg-3">{it.role}</p>
            <p className="mt-1 text-base text-fg-2">{it.question}</p>
            <p className="mt-4 whitespace-pre-wrap text-xl leading-relaxed">
              {it.answer ? <Cited text={it.answer} round={round} /> : it.error ? '' : '…'}
            </p>
            {it.error && <p className="mt-2 text-rose-300">{it.error}</p>}
          </Card>
        ))}
      </section>
    </main>
  );
}
