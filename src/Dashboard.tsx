import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmt } from './lib/timer';
import { exportarOps, kgPorHora } from './lib/csv';
import { Row, defaultPeriod, PeriodFilter, useRows, Period } from './Period';

const Box = ({ t, children }: { t: string; children: React.ReactNode }) =>
  <section className="bg-white rounded-xl p-4"><h3 className="font-semibold mb-2">{t}</h3><div className="h-56">{children}</div></section>;
const grid = <CartesianGrid strokeDasharray="3 3" />;
const HBar = ({ data, color }: { data: { m: string; q: number }[]; color: string }) =>
  <ResponsiveContainer><BarChart data={data} layout="vertical">{grid}<XAxis type="number" allowDecimals={false} /><YAxis type="category" dataKey="m" width={130} /><Tooltip /><Bar dataKey="q" name="OPs" fill={color} /></BarChart></ResponsiveContainer>;
const num = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 1 });

export function DashboardView({ onBack }: { onBack: () => void }) {
  const [p, setP] = useState<Period>(defaultPeriod());
  const { rows, loading, err } = useRows(p);
  const fin = rows.filter(r => r.status === 'Finalizada');   // só finalizadas entram nos indicadores
  const n = fin.length;

  let body: React.ReactNode = null;
  if (n) {
    const pick = (f: (r: Row) => number, max: boolean) => fin.reduce((m, r) => ((max ? f(r) > f(m) : f(r) < f(m)) ? r : m), fin[0]);
    const kgOf = (r: Row) => r.kg, tOf = (r: Row) => r.efetivo;
    const totalKg = fin.reduce((a, r) => a + r.kg, 0), totalT = fin.reduce((a, r) => a + r.efetivo, 0);
    const comImpacto = fin.filter(r => r.impacto === 'SIM').length;
    const cards: [string, string, string][] = [
      ['Tempo médio de separação', fmt(Math.round(totalT / n)), ''],
      ['Quantidade média por OP', `${num(totalKg / n)} kg`, ''],
      ['Maior OP em kg', `${num(pick(kgOf, true).kg)} kg`, `OP ${pick(kgOf, true).numero}`],
      ['Menor OP em kg', `${num(pick(kgOf, false).kg)} kg`, `OP ${pick(kgOf, false).numero}`],
      ['Maior tempo de separação', fmt(pick(tOf, true).efetivo), `OP ${pick(tOf, true).numero}`],
      ['Menor tempo de separação', fmt(pick(tOf, false).efetivo), `OP ${pick(tOf, false).numero}`],
      ['OPs finalizadas', String(n), ''],
      ['Total de kg separados', `${num(totalKg)} kg`, ''],
      ['Produtividade média', `${num(kgPorHora(totalKg, totalT))} kg/h`, 'kg ÷ horas de tempo efetivo'],
      ['Tempo total pausado', fmt(fin.reduce((a, r) => a + r.pausado, 0)), `${num(fin.reduce((a, r) => a + r.pausas, 0) / n)} pausa(s) por OP`],
      ['OPs com impacto', `${num((comImpacto / n) * 100)}%`, `${comImpacto} de ${n}`],
    ];
    const byDay = new Map<string, { ops: number; kg: number; t: number }>();
    fin.forEach(r => { const d = (r.fim || r.inicio).slice(0, 10); const x = byDay.get(d) ?? { ops: 0, kg: 0, t: 0 };
      byDay.set(d, { ops: x.ops + 1, kg: x.kg + r.kg, t: x.t + r.efetivo }); });
    const days = [...byDay.entries()].sort().map(([d, x]) => ({ dia: d.slice(8) + '/' + d.slice(5, 7), ops: x.ops, kg: Math.round(x.kg * 10) / 10, min: Math.round(x.t / x.ops / 60), kgh: Math.round(kgPorHora(x.kg, x.t) * 10) / 10 }));
    const mot = new Map<string, number>();
    fin.forEach(r => r.motivos.split(';').map(s => s.trim()).filter(Boolean).forEach(m => mot.set(m, (mot.get(m) ?? 0) + 1)));
    const motivos = [...mot.entries()].map(([m, q]) => ({ m, q })).sort((a, b) => b.q - a.q);
    const agrupa = (f: (r: Row) => string) => { const mp = new Map<string, number>();
      fin.forEach(r => { const k = f(r) || 'Não informado'; mp.set(k, (mp.get(k) ?? 0) + 1); });
      return [...mp.entries()].map(([m, q]) => ({ m, q })).sort((a, b) => b.q - a.q); };
    const porTipo = agrupa(r => r.tipo), porConf = agrupa(r => r.conferente);
    body = (<>
      <div className="grid grid-cols-2 gap-3">{cards.map(([t, v, s]) => <div key={t} className="bg-white rounded-xl p-4 border-t-4 border-[#0f2a4a]">
        <p className="text-sm text-slate-500">{t}</p><p className="text-2xl font-bold tnum">{v}</p>{s && <p className="text-sm text-slate-600">{s}</p>}</div>)}</div>
      <Box t="OPs finalizadas por dia"><ResponsiveContainer><BarChart data={days}>{grid}<XAxis dataKey="dia" /><YAxis allowDecimals={false} /><Tooltip /><Bar dataKey="ops" name="OPs" fill="#0f2a4a" /></BarChart></ResponsiveContainer></Box>
      <Box t="Kg separados por dia"><ResponsiveContainer><BarChart data={days}>{grid}<XAxis dataKey="dia" /><YAxis /><Tooltip /><Bar dataKey="kg" name="kg" fill="#16a34a" /></BarChart></ResponsiveContainer></Box>
      <Box t="Tempo médio de separação por dia (min)"><ResponsiveContainer><LineChart data={days}>{grid}<XAxis dataKey="dia" /><YAxis /><Tooltip /><Line dataKey="min" name="min" stroke="#0f2a4a" strokeWidth={3} /></LineChart></ResponsiveContainer></Box>
      <Box t="Produtividade por dia (kg por hora efetiva)"><ResponsiveContainer><LineChart data={days}>{grid}<XAxis dataKey="dia" /><YAxis /><Tooltip /><Line dataKey="kgh" name="kg/h" stroke="#16a34a" strokeWidth={3} /></LineChart></ResponsiveContainer></Box>
      <Box t="OPs por tipo"><HBar data={porTipo} color="#0f2a4a" /></Box>
      <Box t="OPs por conferente"><HBar data={porConf} color="#16a34a" /></Box>
      <Box t="Principais motivos de impacto">{motivos.length
        ? <ResponsiveContainer><BarChart data={motivos} layout="vertical">{grid}<XAxis type="number" allowDecimals={false} /><YAxis type="category" dataKey="m" width={130} /><Tooltip /><Bar dataKey="q" name="OPs" fill="#d97706" /></BarChart></ResponsiveContainer>
        : <p className="text-slate-500">Nenhum impacto registrado no período.</p>}</Box>
    </>);
  }
  return (
    <div className="space-y-3">
      <h2 className="text-2xl font-bold">Indicadores</h2>
      <PeriodFilter p={p} onChange={setP} />
      {loading && <p className="text-slate-500">Carregando…</p>}
      {err && <p className="bg-red-100 text-red-800 rounded-lg p-3">{err}</p>}
      {!loading && !err && !n && <p className="bg-white rounded-xl p-5 text-slate-600">Nenhuma OP finalizada neste período.</p>}
      {body}
      {!!n && <button className="w-full h-12 rounded-lg border-2 border-[#0f2a4a] text-[#0f2a4a] font-semibold bg-white"
        onClick={() => exportarOps(fin, 'indicadores_ops.csv')}>⬇ Exportar as {n} OPs finalizadas (CSV)</button>}
      <button className="w-full text-slate-500 underline" onClick={onBack}>Voltar ao início</button>
    </div>
  );
}
