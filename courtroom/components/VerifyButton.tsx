'use client';

import { useState } from 'react';
import { Button } from './ui/Button';

interface VerifyResult {
  ok: boolean;
  computedHash?: string;
  expectedHash?: string;
  status?: string;
  note?: string;
  error?: string;
}

export function VerifyButton({ id, round }: { id: string; round: string }) {
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [busy, setBusy] = useState(false);

  async function verify() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch(`/api/verify/${encodeURIComponent(id)}?round=${encodeURIComponent(round)}`, { cache: 'no-store' });
      const body = (await res.json()) as VerifyResult;
      setResult(res.ok ? body : { ok: false, error: body.error ?? `HTTP ${res.status}` });
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : 'failed' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={() => void verify()} disabled={busy}>
          {busy ? 'Checking…' : 'Verify'}
        </Button>
        <span className="text-sm text-fg-3">Fetches the bytes, hashes them, compares with the chain.</span>
      </div>
      {result && (
        <div
          className={`rounded-2xl border p-4 ${
            result.ok ? 'border-mint/60 bg-mint/10 text-mint' : 'border-rose-400/60 bg-rose-500/10 text-rose-200'
          }`}
        >
          <p className="text-xl font-semibold">{result.ok ? 'Verified' : 'Does not match'}</p>
          {result.note && <p className="mt-1 text-sm">{result.note}</p>}
          {result.status && <p className="mt-1 text-sm">receipt status: {result.status}</p>}
          {result.error && <p className="mt-1 text-sm">{result.error}</p>}
          {result.computedHash && (
            <dl className="mt-3 text-xs break-all sm:text-sm">
              <dt className="eyebrow text-fg-3">computed</dt>
              <dd>{result.computedHash}</dd>
              <dt className="eyebrow mt-2 text-fg-3">expected</dt>
              <dd>{result.expectedHash}</dd>
            </dl>
          )}
        </div>
      )}
    </div>
  );
}
