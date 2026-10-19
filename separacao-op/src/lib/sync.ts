import { dbp } from './store';
import { call, ApiError } from './api';

export type SyncState = 'synced' | 'pending' | 'offline' | 'error';
export interface SyncInfo { state: SyncState; pending: number; msg?: string }
let busy = false;

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
        if (e instanceof ApiError) return { state: 'error', pending: items.length - done, msg: e.message };
        return { state: 'pending', pending: items.length - done };
      }
    }
    return { state: 'synced', pending: 0 };
  } finally { busy = false; }
}
