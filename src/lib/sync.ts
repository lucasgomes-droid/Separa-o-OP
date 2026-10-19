import { dbp } from './store';
import { call, ApiError } from './api';

export type SyncState = 'synced' | 'pending' | 'offline' | 'error';
export interface SyncInfo { state: SyncState; pending: number; msg?: string }
let busy = false;
const TRANSITORIO = /lock|timeout|tempo esgotado|too many|temporari|try again|indispon/i;

/** Descarta o primeiro item da fila (o que o servidor recusou). Só para erros permanentes. */
export async function discardFirst() {
  const d = await dbp; const [first] = await d.getAll('outbox', undefined, 1);
  if (first) await d.delete('outbox', first.seq);
}

/** Envia a fila em ordem. O servidor é idempotente por ID_EVENTO, então reenviar é seguro. */
export async function flush(): Promise<SyncInfo> {
  const d = await dbp;
  const items = await d.getAll('outbox');
  if (!items.length) return { state: navigator.onLine ? 'synced' : 'offline', pending: 0 };
  if (!navigator.onLine) return { state: 'offline', pending: items.length };
  if (busy) return { state: 'pending', pending: items.length };
  busy = true;
  let done = 0;
  try {
    for (const it of items) {
      try { await call('sync', { op: it.op, event: it.event, final: it.final }); await d.delete('outbox', it.seq); done++; }
      catch (e) {
        // Erro passageiro do servidor (trava ocupada, limite de uso): tenta de novo depois, sem travar a fila.
        if (e instanceof ApiError && TRANSITORIO.test(e.message)) return { state: 'pending', pending: items.length - done };
        if (e instanceof ApiError) return { state: 'error', pending: items.length - done, msg: e.message };
        return { state: 'pending', pending: items.length - done };
      }
    }
    return { state: 'synced', pending: 0 };
  } finally { busy = false; }
}
