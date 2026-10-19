import { useEffect, useState } from 'react';
import { call } from './lib/api';
import { fmt, fmtDate } from './lib/timer';
import { Row, defaultPeriod, PeriodFilter, useRows, Period } from './Period';

const when = (s: string) => (s ? fmtDate(new Date(s).getTime()) : '—');
const day = (s: string) => new Date(s).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const sel = 'h-12 px-3 rounded-lg border border-slate-300 bg-white text-lg';

function Detail({ row, onClose }: { row: Row; onClose: () => void }) {
  const [ev, setEv] = useState<{ id: string; tipo: string; quando: string; acumulado: number }[]>([]);
  const [err, setErr] = useState('');
  useEffect(() => { call('detail', { id: row.id }).then(j => setEv(j.eventos)).catch(() => setErr('Não foi possível carregar os eventos.')); }, [row.id]);
  return (
    <div className="bg-white rounded-xl p-5 space-y-2">
      <h2 className="text-2xl font-bold">OP {row.numero} · {row.status}</h2>
      <p>{row.tipo} · Conferente: {row.conferente}</p>
      <p>{row.kg} kg · {row.ajudantes} ajudantes · {row.operadores} operadores</p>
      <p>Início: {when(row.inicio)}<br />Fim: {when(row.fim)}</p>
      <p>Tempo efetivo: <b className="tnum">{fmt(row.efetivo)}</b> · Pausado: <b className="tnum">{fmt(row.pausado)}</b> · Pausas: {row.pausas}</p>
      <p>Impacto: <b>{row.impacto || '—'}</b>{row.motivos && <> · {row.motivos}</>}</p>
      {row.descricao && <p className="bg-slate-100 rounded p-3">{row.descricao}</p>}
      <h3 className="font-semibold pt-2">Eventos</h3>
      {err && <p className="text-red-700">{err}</p>}
      <ul className="divide-y">{ev.map(e => <li key={e.id} className="py-2 flex justify-between gap-2">
        <span>{e.tipo}</span><span>{when(e.quando)}</span><span className="tnum">{fmt(Number(e.acumulado))}</span></li>)}</ul>
      <button className="w-full h-14 rounded-xl bg-[#0f2a4a] text-white text-lg font-semibold" onClick={onClose}>Fechar</button>
    </div>
  );
}

export function HistoryView({ onBack }: { onBack: () => void }) {
  const [p, setP] = useState<Period>(defaultPeriod());
  const [num, setNum] = useState('');
  const [st, setSt] = useState('');
  const [open, setOpen] = useState<Row | null>(null);
  const { rows, loading, err } = useRows(p);
  const shown = rows.filter(r => (!num || r.numero.includes(num)) && (!st || r.status === st))
    .sort((a, b) => Number(b.status === 'Finalizada') - Number(a.status === 'Finalizada')); // finalizadas primeiro
  if (open) return <Detail row={open} onClose={() => setOpen(null)} />;
  return (
    <div className="space-y-3">
      <h2 className="text-2xl font-bold">Histórico</h2>
      <PeriodFilter p={p} onChange={setP} />
      <div className="flex flex-wrap gap-2">
        <input className={sel} placeholder="Número da OP" inputMode="numeric" value={num} onChange={e => setNum(e.target.value)} />
        <select className={sel} value={st} onChange={e => setSt(e.target.value)}>
          <option value="">Todos os status</option><option>Finalizada</option><option>Em andamento</option><option>Pausada</option></select>
      </div>
      {loading && <p className="text-slate-500">Carregando…</p>}
      {err && <p className="bg-red-100 text-red-800 rounded-lg p-3">{err}</p>}
      {!loading && !err && !shown.length && <p className="text-slate-500">Nenhuma OP encontrada neste período.</p>}
      {!!shown.length && <div className="bg-white rounded-xl overflow-x-auto"><table className="w-full text-left whitespace-nowrap">
        <thead className="bg-slate-50 text-sm text-slate-600"><tr>{['OP', 'Tipo', 'Conferente', 'Data', 'Kg', 'Ajud.', 'Oper.', 'Efetivo', 'Pausado', 'Impacto', 'Status'].map(h => <th key={h} className="p-3">{h}</th>)}</tr></thead>
        <tbody>{shown.map(r => <tr key={r.id} onClick={() => setOpen(r)} className="border-t cursor-pointer hover:bg-slate-50">
          <td className="p-3 font-semibold">{r.numero}</td><td className="p-3">{r.tipo}</td><td className="p-3">{r.conferente}</td><td className="p-3">{day(r.inicio)}</td><td className="p-3">{r.kg}</td>
          <td className="p-3">{r.ajudantes}</td><td className="p-3">{r.operadores}</td>
          <td className="p-3 tnum">{fmt(r.efetivo)}</td><td className="p-3 tnum">{fmt(r.pausado)}</td>
          <td className="p-3">{r.impacto || '—'}</td><td className="p-3">{r.status}</td></tr>)}</tbody></table></div>}
      <button className="w-full text-slate-500 underline" onClick={onBack}>Voltar ao início</button>
    </div>
  );
}
