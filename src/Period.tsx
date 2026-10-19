import { useEffect, useState } from 'react';
import { call, ApiError } from './lib/api';

export interface Row {
  id: string; numero: string; kg: number; ajudantes: number; operadores: number; inicio: string; fim: string;
  tipo: string; conferente: string;
  efetivo: number; pausado: number; pausas: number; impacto: string; motivos: string; descricao: string; status: string;
}
export interface Period { kind: 'week' | 'month' | 'custom'; a: string; b: string }
const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const defaultPeriod = (): Period => ({ kind: 'month', a: ymd(new Date()).slice(0, 7), b: ymd(new Date()) });

export function toRange(p: Period): { from: number; to: number } | null {
  let from: number, to: number;
  if (p.kind === 'month') {
    const [y, m] = p.a.split('-').map(Number);
    from = new Date(y, m - 1, 1).getTime(); to = new Date(y, m, 1).getTime() - 1;
  } else if (p.kind === 'week') {
    const d = new Date(p.a + 'T00:00:00'); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // segunda-feira
    const e = new Date(d); e.setDate(e.getDate() + 7);
    from = d.getTime(); to = e.getTime() - 1;
  } else { from = new Date(p.a + 'T00:00:00').getTime(); to = new Date(p.b + 'T23:59:59.999').getTime(); }
  return isNaN(from) || isNaN(to) || from > to ? null : { from, to };
}

const field = 'h-12 px-3 rounded-lg border border-slate-300 bg-white text-lg';
export function PeriodFilter({ p, onChange }: { p: Period; onChange: (p: Period) => void }) {
  const today = ymd(new Date());
  const setKind = (k: Period['kind']) => onChange({ kind: k, a: k === 'month' ? today.slice(0, 7) : today, b: today });
  return (
    <div className="flex flex-wrap gap-2 items-center">
      <select className={field} value={p.kind} onChange={e => setKind(e.target.value as Period['kind'])}>
        <option value="week">Semana</option><option value="month">Mês</option><option value="custom">Período personalizado</option>
      </select>
      {p.kind === 'month'
        ? <input type="month" className={field} value={p.a} onChange={e => onChange({ ...p, a: e.target.value })} />
        : <input type="date" className={field} value={p.a} onChange={e => onChange({ ...p, a: e.target.value })} />}
      {p.kind === 'custom' && <><span>até</span><input type="date" className={field} value={p.b} onChange={e => onChange({ ...p, b: e.target.value })} /></>}
      {p.kind === 'week' && <span className="text-sm text-slate-500">semana (seg–dom) que contém o dia escolhido</span>}
    </div>
  );
}

/** Busca no Google Sheets (via API) as OPs do período. */
export function useRows(p: Period) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const key = JSON.stringify(p);
  useEffect(() => {
    const r = toRange(p);
    if (!r) { setErr('Período inválido.'); setRows([]); return; }
    let off = false; setLoading(true); setErr('');
    call<{ items: Row[] }>('list', r)
      .then(j => { if (!off) setRows(j.items); })
      .catch(e => { if (!off) { setRows([]); setErr(e instanceof ApiError ? e.message : 'Sem conexão com o servidor. Tente novamente.'); } })
      .finally(() => { if (!off) setLoading(false); });
    return () => { off = true; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return { rows, loading, err };
}
