import type { Row } from '../Period';
import { fmt } from './timer';

/** Quilos por hora de trabalho efetivo (pausas não contam). */
export const kgPorHora = (kg: number, efetivoSeg: number) => (efetivoSeg > 0 ? kg / (efetivoSeg / 3600) : 0);

const dec = (n: number, casas = 1) => String(Math.round(n * 10 ** casas) / 10 ** casas).replace('.', ',');
const esc = (v: unknown) => { const s = String(v ?? ''); return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

/** CSV com ponto e vírgula e BOM: abre direto no Excel em português. */
export function downloadCsv(nome: string, cab: string[], linhas: unknown[][]) {
  const txt = [cab, ...linhas].map(l => l.map(esc).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['\uFEFF' + txt], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = nome;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportarOps(rows: Row[], nome: string) {
  downloadCsv(nome, ['OP', 'Tipo', 'Conferente', 'Início', 'Fim', 'Kg', 'Ajudantes', 'Operadores', 'Tempo efetivo', 'Tempo pausado', 'Pausas', 'Kg/hora', 'Impacto', 'Motivos', 'Descrição do impacto', 'Status'],
    rows.map(r => [r.numero, r.tipo, r.conferente, r.inicio, r.fim, dec(r.kg, 2), r.ajudantes, r.operadores, fmt(r.efetivo), fmt(r.pausado), r.pausas,
      dec(kgPorHora(r.kg, r.efetivo)), r.impacto, r.motivos, r.descricao, r.status]));
}
