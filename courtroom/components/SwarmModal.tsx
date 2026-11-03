'use client';

import type { Exhibit } from '@trial/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { COLUMN_TITLES } from '@/lib/links';

const MAX_TEXT = 200_000;

type Loaded =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'json'; value: unknown; type: string; bytes: number }
  | { state: 'text'; text: string; type: string; bytes: number }
  | { state: 'image'; src: string; type: string; bytes: number }
  | { state: 'binary'; type: string; bytes: number };

async function load(url: string, signal: AbortSignal): Promise<Loaded> {
  const res = await fetch(url, { signal, cache: 'no-store' });
  if (!res.ok) return { state: 'error', message: `The gateway answered ${res.status} ${res.statusText}` };
  const type = (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim();
  const blob = await res.blob();
  const bytes = blob.size;
  if (type.startsWith('image/')) return { state: 'image', src: URL.createObjectURL(blob), type, bytes };
  const isTexty = type.startsWith('text/') || /json|xml|javascript/.test(type);
  if (!isTexty) return { state: 'binary', type, bytes };
  const text = await blob.text();
  // Some files are JSON served as text/plain; show them as JSON either way.
  try {
    return { state: 'json', value: JSON.parse(text), type, bytes };
  } catch {
    return { state: 'text', text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…[truncated]` : text, type, bytes };
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Pretty JSON with quiet syntax colours; long strings wrap instead of scrolling sideways. */
function JsonView({ value, depth = 0 }: { value: unknown; depth?: number }): ReactNode {
  const pad = '  '.repeat(depth + 1);
  const close = '  '.repeat(depth);
  if (value === null) return <span className="text-neutral-500">null</span>;
  if (typeof value === 'boolean') return <span className="text-amber-300">{String(value)}</span>;
  if (typeof value === 'number') return <span className="text-amber-300">{value}</span>;
  if (typeof value === 'string') {
    const isLink = /^(https?|bzz):\/\//.test(value);
    return <span className={isLink ? 'text-sky-300' : 'text-emerald-300'}>&quot;{value}&quot;</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-neutral-500">[]</span>;
    return (
      <>
        <span className="text-neutral-500">[</span>
        {'\n'}
        {value.map((v, i) => (
          <span key={i}>
            {pad}
            <JsonView value={v} depth={depth + 1} />
            {i < value.length - 1 && <span className="text-neutral-500">,</span>}
            {'\n'}
          </span>
        ))}
        {close}
        <span className="text-neutral-500">]</span>
      </>
    );
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return <span className="text-neutral-500">{'{}'}</span>;
  return (
    <>
      <span className="text-neutral-500">{'{'}</span>
      {'\n'}
      {entries.map(([k, v], i) => (
        <span key={k}>
          {pad}
          <span className="text-violet-300">&quot;{k}&quot;</span>
          <span className="text-neutral-500">: </span>
          <JsonView value={v} depth={depth + 1} />
          {i < entries.length - 1 && <span className="text-neutral-500">,</span>}
          {'\n'}
        </span>
      ))}
      {close}
      <span className="text-neutral-500">{'}'}</span>
    </>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="rounded border border-neutral-700 px-2 py-0.5 text-xs uppercase tracking-wide text-neutral-400 transition hover:border-neutral-500 hover:text-neutral-200"
    >
      {copied ? 'copied' : label}
    </button>
  );
}

function Body({ loaded }: { loaded: Loaded }) {
  if (loaded.state === 'loading') {
    return (
      <div className="space-y-3 p-6" aria-busy="true">
        {[90, 70, 80, 55, 65].map((w, i) => (
          <div key={i} className="h-4 animate-pulse rounded bg-neutral-800" style={{ width: `${w}%` }} />
        ))}
        <p className="pt-2 text-sm text-neutral-500">Fetching from the Swarm gateway…</p>
      </div>
    );
  }
  if (loaded.state === 'error') {
    return (
      <div className="m-6 rounded-lg border border-rose-500/50 bg-rose-950/30 p-4 text-rose-200">
        <p className="font-semibold">Could not load this file</p>
        <p className="mt-1 text-sm text-rose-300/80">{loaded.message}</p>
      </div>
    );
  }
  if (loaded.state === 'image') {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={loaded.src} alt="Swarm content" className="mx-auto max-h-[60vh] p-6" />;
  }
  if (loaded.state === 'binary') {
    return <p className="p-6 text-neutral-400">Binary file ({loaded.type}). Open it on the gateway to download it.</p>;
  }
  return (
    <pre className="whitespace-pre-wrap break-words p-6 font-mono text-[15px] leading-relaxed text-neutral-200">
      {loaded.state === 'json' ? <JsonView value={loaded.value} /> : loaded.text}
    </pre>
  );
}

export function SwarmModal({ exhibit, target, onClose }: { exhibit: Exhibit; target: { ref: string; url: string }; onClose: () => void }) {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });

  useEffect(() => {
    const ctrl = new AbortController();
    setLoaded({ state: 'loading' });
    load(target.url, ctrl.signal)
      .then(setLoaded)
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) setLoaded({ state: 'error', message: e instanceof Error ? e.message : 'fetch failed' });
      });
    return () => ctrl.abort();
  }, [target.url]);

  useEffect(() => {
    if (loaded.state !== 'image') return;
    return () => URL.revokeObjectURL(loaded.src);
  }, [loaded]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const meta = loaded.state !== 'loading' && loaded.state !== 'error' ? `${loaded.type} · ${formatBytes(loaded.bytes)}` : null;
  const column = COLUMN_TITLES[exhibit.id[0]] ?? '';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="swarm-modal-title"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-8 backdrop-blur-sm animate-[fade-in_120ms_ease-out]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-950 shadow-2xl shadow-black/60"
      >
        <header className="flex items-start gap-4 border-b border-neutral-800 px-6 py-5">
          <span className="mt-0.5 rounded-md bg-violet-500/15 px-2.5 py-1 font-mono text-lg font-bold text-violet-300">{exhibit.id}</span>
          <div className="min-w-0 flex-1">
            <p className="text-xs uppercase tracking-widest text-neutral-500">
              {column} · stored on Swarm
            </p>
            <h2 id="swarm-modal-title" className="mt-1 text-2xl font-semibold leading-tight text-neutral-100">
              {exhibit.title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-2 text-2xl leading-none text-neutral-500 transition hover:bg-neutral-800 hover:text-neutral-200"
          >
            ×
          </button>
        </header>

        <dl className="grid grid-cols-[auto_1fr_auto] items-center gap-x-4 gap-y-2 border-b border-neutral-800 bg-neutral-900/40 px-6 py-3 text-sm">
          <dt className="text-neutral-500">reference</dt>
          <dd className="truncate font-mono text-neutral-300" title={`bzz://${target.ref}`}>
            bzz://{target.ref}
          </dd>
          <dd>
            <CopyButton text={`bzz://${target.ref}`} label="copy" />
          </dd>
          {exhibit.hash && (
            <>
              <dt className="text-neutral-500">keccak256</dt>
              <dd className="truncate font-mono text-neutral-300" title={exhibit.hash}>
                {exhibit.hash}
              </dd>
              <dd>
                <CopyButton text={exhibit.hash} label="copy" />
              </dd>
            </>
          )}
        </dl>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <Body loaded={loaded} />
        </div>

        <footer className="flex items-center justify-between gap-4 border-t border-neutral-800 px-6 py-3 text-sm">
          <span className="font-mono text-neutral-500">{meta ?? ' '}</span>
          <a href={target.url} target="_blank" rel="noreferrer" className="text-sky-300 underline hover:text-sky-200">
            Open on the gateway ↗
          </a>
        </footer>
      </div>
    </div>
  );
}
