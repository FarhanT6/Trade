'use client';
import { useEffect, useState } from 'react';
import { API_URL, type Snapshot } from '@/lib/api';

let shared: Snapshot | null = null;
const listeners = new Set<(s: Snapshot | null, ok: boolean) => void>();
let source: EventSource | null = null;
let ok = false;

function ensure() {
  if (source || typeof window === 'undefined') return;
  source = new EventSource(`${API_URL}/api/stream`);
  source.addEventListener('snapshot', (e) => {
    shared = JSON.parse((e as MessageEvent).data);
    ok = true;
    for (const l of listeners) l(shared, ok);
  });
  source.onerror = () => {
    ok = false;
    for (const l of listeners) l(shared, ok);
  };
}

/** One shared SSE connection for every component (spec §14: WebSockets/SSE for live updates). */
export function useSnapshot() {
  const [state, setState] = useState<{ snap: Snapshot | null; connected: boolean }>({ snap: shared, connected: ok });
  useEffect(() => {
    ensure();
    const l = (s: Snapshot | null, c: boolean) => setState({ snap: s, connected: c });
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return state;
}
