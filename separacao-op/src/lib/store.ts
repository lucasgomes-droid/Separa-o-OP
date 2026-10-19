import { openDB } from 'idb';
import { Op, OpEvent, Final, EvType, Status } from './timer';

export const dbp = openDB('separacao-op', 1, {
  upgrade(d) {
    d.createObjectStore('ops', { keyPath: 'id' });
    d.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true }); // ordem de inserção = ordem dos eventos
    d.createObjectStore('kv');
  },
});

const statusOf = (t: EvType): Status => (t === 'PAUSA' ? 'Pausada' : t === 'FINALIZACAO' ? 'Finalizada' : 'Em andamento');

export async function getCurrent(): Promise<Op | undefined> {
  const d = await dbp; const id = await d.get('kv', 'current');
  return id ? d.get('ops', id) : undefined;
}
export async function pendingCount() { return (await dbp).count('outbox'); }

/** Grava evento + estado local + fila de sincronização na MESMA transação. */
export async function record(op: Op, ev: OpEvent, final?: Final): Promise<Op> {
  const next: Op = { ...op, events: [...op.events, ev], status: statusOf(ev.type), final: final ?? op.final };
  const d = await dbp;
  const tx = d.transaction(['ops', 'outbox', 'kv'], 'readwrite');
  tx.objectStore('ops').put(next);
  const meta = { id: op.id, tipo: op.tipo, conferente: op.conferente, numero: op.numero, kg: op.kg, ajudantes: op.ajudantes, operadores: op.operadores };
  tx.objectStore('outbox').add({ op: meta, event: ev, final });
  if (ev.type === 'INICIO') tx.objectStore('kv').put(op.id, 'current');
  if (ev.type === 'FINALIZACAO') tx.objectStore('kv').delete('current');
  await tx.done;
  return next;
}

export interface Cfg { tipos: string[]; conferentes: string[]; motivos: string[] }
export async function getCfg(): Promise<Cfg | undefined> { return (await dbp).get('kv', 'cfg'); }
export async function setCfg(c: Cfg) { await (await dbp).put('kv', c, 'cfg'); }
