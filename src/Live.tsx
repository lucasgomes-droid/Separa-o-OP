import { useCallback, useEffect, useRef, useState } from 'react';
import { call, ApiError } from './lib/api';
import { fmt, fmtDate } from './lib/timer';

interface LiveOp {
  id: string; numero: string; tipo: string; conferente: string; kg: number; ajudantes: number; operadores: number;
  status: 'Em andamento' | 'Pausada'; inicio: string; efetivo: number; pausado: number; rodando: boolean; ultima: string; parada: boolean;
}
interface LiveResp {
  geradoEm: number; serverNow: number; tipos: string[]; ativas: LiveOp[]; limiteHoras: number;
  hoje: { finalizadas: number; kg: number; porTipo: Record<string, { ops: number; kg: number }> };
}
const POLL_MS = 10000;
const num = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
const pad = (n: number) => String(n).padStart(2, '0');
const toLocalInput = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const ago = (ms: number) => { const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000); return h ? `${h} h ${m} min` : `${m} min`; };

interface Group { tipo: string; rodando: number; pausadas: number; conferentes: number; operadores: number; ajudantes: number; kg: number }

function group(tipo: string, ops: LiveOp[]): Group {
  const work = ops.filter(o => o.rodando && !o.parada);   // "atuando" = em andamento e com atividade recente
  return {
    tipo, rodando: work.length, pausadas: ops.filter(o => !o.rodando && !o.parada).length,
    conferentes: new Set(work.map(o => o.conferente.trim().toLowerCase())).size,
    operadores: work.reduce((a, o) => a + o.operadores, 0), ajudantes: work.reduce((a, o) => a + o.ajudantes, 0),
    kg: work.reduce((a, o) => a + o.kg, 0),
  };
}

export function LiveView({ onBack }: { onBack: () => void }) {
  const [data, setData] = useState<LiveResp | null>(null);
  const [recvAt, setRecvAt] = useState(0);
  const [err, setErr] = useState('');
  const [now, setNow] = useState(Date.now());
  const [closing, setClosing] = useState<{ op: LiveOp; fim: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const j = await call<LiveResp>('live');
      if (!alive.current) return;
      setData(j); setRecvAt(Date.now()); setErr('');
    } catch (e) {
      if (alive.current) setErr(e instanceof ApiError ? e.message : 'Sem conexão com o servidor. Mostrando o último dado recebido.');
    }
  }, []);

  useEffect(() => {
    alive.current = true; load();
    const poll = setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const vis = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', vis);
    return () => { alive.current = false; clearInterval(poll); clearInterval(tick); document.removeEventListener('visibilitychange', vis); };
  }, [load]);

  // tempo efetivo "ao vivo": valor do servidor + o que passou desde que a resposta foi gerada (só para OPs rodando)
  const efetivo = (o: LiveOp) => {
    if (!data || !o.rodando) return o.efetivo;
    return o.efetivo + Math.max(0, Math.floor((data.serverNow - data.geradoEm) / 1000 + (now - recvAt) / 1000));
  };

  async function encerrar() {
    if (!closing) return;
    const fim = new Date(closing.fim).getTime();
    if (!isFinite(fim)) { setErr('Informe a data e a hora reais do fim.'); return; }
    setBusy(true);
    try { await call('forceClose', { id: closing.op.id, fim }); setClosing(null); await load(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Não foi possível encerrar. Tente novamente.'); }
    finally { setBusy(false); }
  }

  const ops = data?.ativas ?? [];
  const tipos = [...(data?.tipos ?? [])];
  ops.forEach(o => { if (!tipos.includes(o.tipo)) tipos.push(o.tipo); });
  const groups = tipos.map(t => group(t, ops.filter(o => o.tipo === t)));
  const total = group('Total', ops);
  const paradas = ops.filter(o => o.parada);
  const stale = now - recvAt > 3 * POLL_MS;
  const cards: [string, number, string][] = [
    ['Separações em andamento', total.rodando, 'border-[#16a34a]'], ['Pausadas', total.pausadas, 'border-amber-500'],
    ['Conferentes atuando', total.conferentes, 'border-[#0f2a4a]'], ['Operadores atuando', total.operadores, 'border-[#0f2a4a]'],
    ['Ajudantes atuando', total.ajudantes, 'border-[#0f2a4a]'], ['Finalizadas hoje', data?.hoje.finalizadas ?? 0, 'border-slate-400'],
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-2xl font-bold flex items-center gap-2"><span className="inline-block size-3 rounded-full bg-[#16a34a] animate-pulse" />Tempo real</h2>
        <button className="h-10 px-4 rounded-lg border-2 border-[#0f2a4a] text-[#0f2a4a] font-semibold" onClick={load}>Atualizar</button>
      </div>
      {err && <p className="bg-red-100 text-red-800 rounded-lg p-3">{err}</p>}
      {!data && !err && <p className="text-slate-500">Carregando…</p>}

      {data && (<>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {cards.map(([t, v, c]) => <div key={t} className={`bg-white rounded-xl p-4 border-t-4 ${c}`}>
            <p className="text-sm text-slate-500">{t}</p><p className="text-3xl font-bold tnum">{v}</p></div>)}
        </div>

        <section className="bg-white rounded-xl overflow-x-auto">
          <h3 className="font-semibold p-4 pb-2">Por tipo de OP</h3>
          <table className="w-full text-left whitespace-nowrap">
            <thead className="bg-slate-50 text-sm text-slate-600"><tr>
              {['Tipo', 'Em andamento', 'Pausadas', 'Conferentes', 'Operadores', 'Ajudantes', 'Kg em curso', 'Finalizadas hoje'].map(h => <th key={h} className="p-3">{h}</th>)}</tr></thead>
            <tbody>
              {groups.map(g => <tr key={g.tipo} className="border-t">
                <td className="p-3 font-semibold">{g.tipo}</td><td className="p-3 tnum">{g.rodando}</td><td className="p-3 tnum">{g.pausadas}</td>
                <td className="p-3 tnum">{g.conferentes}</td><td className="p-3 tnum">{g.operadores}</td><td className="p-3 tnum">{g.ajudantes}</td>
                <td className="p-3 tnum">{num(g.kg)}</td><td className="p-3 tnum">{data.hoje.porTipo[g.tipo]?.ops ?? 0}</td></tr>)}
              <tr className="border-t-2 bg-slate-50 font-bold"><td className="p-3">Total</td><td className="p-3 tnum">{total.rodando}</td><td className="p-3 tnum">{total.pausadas}</td>
                <td className="p-3 tnum">{total.conferentes}</td><td className="p-3 tnum">{total.operadores}</td><td className="p-3 tnum">{total.ajudantes}</td>
                <td className="p-3 tnum">{num(total.kg)}</td><td className="p-3 tnum">{data.hoje.finalizadas}</td></tr>
            </tbody>
          </table>
          <p className="text-sm text-slate-500 p-3">“Atuando” conta só OPs em andamento (pausadas e paradas ficam de fora). Hoje: {num(data.hoje.kg)} kg finalizados.</p>
        </section>

        {paradas.length > 0 && <p className="bg-red-50 text-red-800 rounded-lg p-3">
          {paradas.length} OP(s) sem nenhuma atividade há mais de {data.limiteHoras} h. Provavelmente o conferente finalizou e não sincronizou: confira abaixo e encerre.</p>}

        <h3 className="font-semibold pt-1">OPs abertas ({ops.length})</h3>
        {!ops.length && <p className="bg-white rounded-xl p-5 text-slate-600">Nenhuma separação aberta neste momento.</p>}
        {ops.map(o => {
          const idle = recvAt && data ? data.serverNow - new Date(o.ultima).getTime() : 0;
          return (
            <div key={o.id} className={`bg-white rounded-xl p-4 border-l-8 ${o.parada ? 'border-red-500' : o.rodando ? 'border-[#16a34a]' : 'border-amber-500'}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-xl font-bold">OP {o.numero} <span className="text-base font-normal text-slate-500">· {o.tipo}</span></p>
                <p className={`tnum text-3xl font-bold ${o.rodando ? 'text-[#0f2a4a]' : 'text-amber-600'}`}>{fmt(efetivo(o))}</p>
              </div>
              <p className="text-slate-700">{o.conferente} · {num(o.kg)} kg · {o.operadores} oper. · {o.ajudantes} ajud.</p>
              <p className="text-sm text-slate-500">
                {o.parada ? `PARADA: sem atividade há ${ago(idle)}` : o.rodando ? 'Em andamento' : 'Pausada'} · início {fmtDate(new Date(o.inicio).getTime())}</p>
              {o.parada && (closing?.op.id === o.id
                ? <div className="mt-3 space-y-2">
                    <label className="block text-sm">Hora real em que a separação terminou
                      <input type="datetime-local" className="w-full h-12 px-3 rounded-lg border border-slate-300 text-lg bg-white"
                        value={closing.fim} min={toLocalInput(new Date(o.inicio).getTime())} onChange={e => setClosing({ op: o, fim: e.target.value })} /></label>
                    <div className="grid grid-cols-2 gap-2">
                      <button disabled={busy} className="h-12 rounded-lg bg-red-600 text-white font-semibold disabled:opacity-50" onClick={encerrar}>{busy ? 'Encerrando…' : 'Confirmar encerramento'}</button>
                      <button className="h-12 rounded-lg border border-slate-300" onClick={() => setClosing(null)}>Cancelar</button></div>
                  </div>
                : <button className="mt-3 h-11 px-4 rounded-lg border-2 border-red-600 text-red-700 font-semibold"
                    onClick={() => setClosing({ op: o, fim: toLocalInput(new Date(o.ultima).getTime()) })}>Encerrar esta OP</button>)}
            </div>);
        })}
        <p className={`text-sm text-center ${stale ? 'text-red-700 font-semibold' : 'text-slate-500'}`}>
          {stale ? 'Sem atualizar há mais de 30 s — verifique a internet. ' : ''}Atualizado às {hhmm(recvAt)} · renova sozinho a cada {POLL_MS / 1000} s</p>
      </>)}
      <button className="w-full text-slate-500 underline" onClick={onBack}>Voltar ao início</button>
    </div>
  );
}
