'use client';

import { useEffect, useState } from 'react';

interface PollState<T> {
  data: T | null;
  error: string | null;
  /** An answer came back: tells an empty answer (null) apart from none yet. */
  loaded: boolean;
}

/** Fetches JSON from url every intervalMs. Pass null to pause. */
export function usePoll<T>(url: string | null, intervalMs: number): PollState<T> {
  const [state, setState] = useState<PollState<T>>({ data: null, error: null, loaded: false });

  useEffect(() => {
    if (!url) return;
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        const body = (await res.json()) as T | { error?: string };
        if (!alive) return;
        if (!res.ok) {
          const err = (body as { error?: string }).error ?? `HTTP ${res.status}`;
          setState((s) => ({ ...s, error: err }));
          return;
        }
        setState({ data: body as T, error: null, loaded: true });
      } catch (e) {
        if (alive) setState((s) => ({ ...s, error: e instanceof Error ? e.message : 'fetch failed' }));
      }
    };
    void tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [url, intervalMs]);

  return state;
}
