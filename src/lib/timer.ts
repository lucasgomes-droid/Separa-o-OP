export type EvType = 'INICIO' | 'PAUSA' | 'RETOMADA' | 'FINALIZACAO';
export type Status = 'Em andamento' | 'Pausada' | 'Finalizada';
export interface OpEvent { id: string; type: EvType; at: number }
export interface Final { impacto: boolean; motivos: string[]; descricao: string }
export interface Op {
  id: string; numero: string; kg: number; ajudantes: number; operadores: number;
  tipo?: string; conferente?: string;
  status: Status; events: OpEvent[]; final?: Final;
}

/** Tempo efetivo/pausado calculado SOMENTE a partir dos timestamps dos eventos. */
export function calc(events: OpEvent[], now: number) {
  let work = 0, paused = 0, pauses = 0;
  let run: number | null = null, pause: number | null = null;
  for (const e of events) {
    if (e.type === 'INICIO' || e.type === 'RETOMADA') {
      if (pause !== null) { paused += e.at - pause; pause = null; }
      run = e.at;
    } else {
      if (run !== null) { work += e.at - run; run = null; }
      if (e.type === 'PAUSA') { pause = e.at; pauses++; }
      else if (pause !== null) { paused += e.at - pause; pause = null; }
    }
  }
  if (!events.some(e => e.type === 'FINALIZACAO')) {
    if (run !== null) work += Math.max(0, now - run);
    if (pause !== null) paused += Math.max(0, now - pause);
  }
  return { efetivo: Math.floor(work / 1000), pausado: Math.floor(paused / 1000), pausas: pauses };
}

export const fmt = (s: number) =>
  [Math.floor(s / 3600), Math.floor(s / 60) % 60, Math.floor(s) % 60].map(v => String(v).padStart(2, '0')).join(':');
export const fmtDate = (ms: number) => new Date(ms).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
