import { useCallback, useEffect, useRef, useState } from 'react';
import { Play, Pause, Square, Wifi, WifiOff, CloudUpload, AlertTriangle, CheckCircle2, ClipboardList, History as HistIcon, BarChart3 } from 'lucide-react';
import { Op, EvType, Final, calc, fmt, fmtDate } from './lib/timer';
import { getCurrent, record, getCfg, setCfg, Cfg } from './lib/store';
import { call, getConn, saveConn, clearConn, ApiError, DEFAULT_URL } from './lib/api';
import { flush, SyncInfo } from './lib/sync';
import { HistoryView } from './History';
import { DashboardView } from './Dashboard';

type Screen = 'home' | 'form' | 'run' | 'finish' | 'done' | 'history' | 'dash';
const MOTIVOS = ['Fumigação', 'Operador', 'Ajudante', 'Endereçamento divergente'];
const TIPOS = ['Ribbon', 'Fábrica', 'Líquida'];
const btn = 'w-full h-16 rounded-xl text-xl font-semibold flex items-center justify-center gap-3 disabled:opacity-50 active:scale-[.99]';
const inp = 'w-full h-14 px-4 rounded-lg border border-slate-300 text-xl bg-white focus:outline-2 focus:outline-[#16a34a]';

function Badge({ s }: { s: SyncInfo }) {
  const m = {
    synced: ['Sincronizado', CheckCircle2, 'text-green-300'],
    pending: [`Sincronização pendente (${s.pending})`, CloudUpload, 'text-amber-300'],
    offline: [`Sem conexão${s.pending ? ` (${s.pending} pendentes)` : ''}`, WifiOff, 'text-slate-300'],
    error: [`Erro de sincronização: ${s.msg ?? ''}`, AlertTriangle, 'text-red-300'],
  } as const;
  const [label, Icon, color] = m[s.state];
  return <span className={`flex items-center gap-2 text-sm ${color}`}><Icon size={18} />{label}</span>;
}

export default function App() {
  const [op, setOp] = useState<Op>();
  const [screen, setScreen] = useState<Screen>('home');
  const [sync, setSync] = useState<SyncInfo>({ state: 'synced', pending: 0 });
  const [now, setNow] = useState(Date.now());
  const [err, setErr] = useState('');
  const busy = useRef(false);
  const [conn, setConn] = useState(!!getConn());
  const [cfg, setCfgState] = useState<Cfg>({ tipos: TIPOS, conferentes: [], motivos: MOTIVOS });
  const loadCfg = useCallback(async () => {   // listas vêm da aba CONFIGURACOES; cache local para uso offline
    const c = await getCfg(); if (c) setCfgState(c);
    try {
      const j = await call('config');
      const n: Cfg = { tipos: j.tipos?.length ? j.tipos : TIPOS, conferentes: j.conferentes || [], motivos: j.motivos?.length ? j.motivos : MOTIVOS };
      await setCfg(n); setCfgState(n);
    } catch { /* sem conexão: usa o cache */ }
  }, []);
  useEffect(() => { if (conn) loadCfg(); }, [conn, loadCfg, screen]);

  const doFlush = useCallback(async () => setSync(await flush()), []);
  useEffect(() => {
    getCurrent().then(o => o && setOp(o));
    doFlush();
    const t = setInterval(doFlush, 15000);
    const on = () => doFlush();
    window.addEventListener('online', on); window.addEventListener('offline', on);
    return () => { clearInterval(t); window.removeEventListener('online', on); window.removeEventListener('offline', on); };
  }, [doFlush]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(t); }, []); // só visual

  async function act(type: EvType, base: Op | undefined, final?: Final) {
    if (busy.current || !base) return false;           // trava duplo clique
    busy.current = true; setErr('');
    try {
      const n = await record(base, { id: crypto.randomUUID(), type, at: Date.now() }, final);
      setOp(n); doFlush(); return true;
    } catch (e) { setErr(String(e)); return false; }
    finally { busy.current = false; }
  }

  const active = op && op.status !== 'Finalizada' ? op : undefined;
  const t = op ? calc(op.events, now) : { efetivo: 0, pausado: 0, pausas: 0 };

  if (!conn) return <Connect onDone={() => setConn(true)} />;
  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      <header className="bg-[#0f2a4a] text-white px-5 py-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">Separação Ordem de Produção</h1><div className="flex items-center gap-4"><Badge s={sync} />
          <button className="text-sm underline text-slate-300" onClick={() => { if (confirm('Trocar a conexão com a planilha?')) { clearConn(); setConn(false); } }}>Configurar</button></div>
      </header>
      <main className="max-w-3xl mx-auto p-5 space-y-4">
        {err && <p className="bg-red-100 text-red-800 rounded-lg p-3">{err}</p>}

        {screen === 'home' && (<>
          {active && <div className="bg-white rounded-xl p-4 border-l-8 border-[#16a34a]">
            <p className="text-sm text-slate-500">OP em andamento neste dispositivo</p>
            <p className="text-2xl font-bold">OP {active.numero} · {active.status}</p>
            <p className="tnum text-3xl mt-1">{fmt(t.efetivo)}</p></div>}
          {active
            ? <button className={`${btn} bg-[#16a34a] text-white`} onClick={() => setScreen('run')}><Play />Continuar OP</button>
            : <button className={`${btn} bg-[#16a34a] text-white`} onClick={() => setScreen('form')}><ClipboardList />Iniciar OP</button>}
          <div className="grid grid-cols-2 gap-3">
            <button className={`${btn} bg-white text-[#0f2a4a] border-2 border-[#0f2a4a]`} onClick={() => setScreen('history')}><HistIcon />Histórico</button>
            <button className={`${btn} bg-white text-[#0f2a4a] border-2 border-[#0f2a4a]`} onClick={() => setScreen('dash')}><BarChart3 />Indicadores</button>
          </div>
        </>)}

        {screen === 'form' && <StartForm cfg={cfg} onCancel={() => setScreen('home')}
          onStart={async v => { const base: Op = { id: crypto.randomUUID(), ...v, status: 'Em andamento', events: [] };
            if (await act('INICIO', base)) setScreen('run'); }} />}

        {screen === 'run' && op && (<>
          <div className="bg-white rounded-xl p-5 text-center">
            <p className="text-slate-500">OP {op.numero} · <b>{op.status}</b></p>
            <p className={`tnum text-6xl sm:text-7xl font-bold my-4 ${op.status === 'Pausada' ? 'text-amber-600' : 'text-[#0f2a4a]'}`}>{fmt(t.efetivo)}</p>
            <p className="text-slate-500 text-sm">Tempo efetivo (pausas não contam)</p>
          </div>
          <dl className="bg-white rounded-xl p-4 grid grid-cols-2 gap-3 text-lg">
            <div><dt className="text-sm text-slate-500">Tipo</dt><dd>{op.tipo}</dd></div>
            <div><dt className="text-sm text-slate-500">Conferente</dt><dd>{op.conferente}</dd></div>
            <div><dt className="text-sm text-slate-500">Quantidade</dt><dd>{op.kg} kg</dd></div>
            <div><dt className="text-sm text-slate-500">Início</dt><dd>{fmtDate(op.events[0].at)}</dd></div>
            <div><dt className="text-sm text-slate-500">Ajudantes</dt><dd>{op.ajudantes}</dd></div>
            <div><dt className="text-sm text-slate-500">Operadores</dt><dd>{op.operadores}</dd></div>
          </dl>
          {op.status === 'Pausada'
            ? <button className={`${btn} bg-[#16a34a] text-white`} onClick={() => act('RETOMADA', op)}><Play />Retomar</button>
            : <button className={`${btn} bg-amber-500 text-white`} onClick={() => act('PAUSA', op)}><Pause />Pausar</button>}
          <button className={`${btn} bg-[#0f2a4a] text-white`} onClick={() => setScreen('finish')}><Square />Finalizar</button>
          <button className="w-full text-slate-500 underline" onClick={() => setScreen('home')}>Voltar ao início</button>
        </>)}

        {screen === 'finish' && op && <FinishForm op={op} motivos={cfg.motivos} efetivo={t.efetivo} pausado={t.pausado} now={now}
          onBack={() => setScreen('run')}
          onConfirm={async f => { if (await act('FINALIZACAO', op, f)) setScreen('done'); }} />}

        {screen === 'done' && op && (<div className="bg-white rounded-xl p-5 space-y-3">
          <h2 className="text-2xl font-bold">OP {op.numero} finalizada</h2>
          <p className="tnum text-3xl">{fmt(t.efetivo)}</p>
          {sync.state === 'synced'
            ? <p className="text-green-700 font-semibold">Confirmado no Google Sheets.</p>
            : <p className="text-amber-700 font-semibold">Finalizada neste dispositivo. Sincronização pendente — não feche os dados do navegador.</p>}
          <button className={`${btn} bg-[#0f2a4a] text-white`} onClick={() => { setOp(undefined); setScreen('home'); }}>Voltar ao início</button>
        </div>)}
        {screen === 'history' && <HistoryView onBack={() => setScreen('home')} />}
        {screen === 'dash' && <DashboardView onBack={() => setScreen('home')} />}
      </main>
    </div>
  );
}

function StartForm({ cfg, onStart, onCancel }: { cfg: Cfg; onStart: (v: { tipo: string; conferente: string; numero: string; kg: number; ajudantes: number; operadores: number }) => void; onCancel: () => void }) {
  const [f, setF] = useState({ tipo: '', conferente: '', numero: '', kg: '', ajudantes: '', operadores: '' });
  const [sent, setSent] = useState(false);
  const kg = Number(f.kg.replace(',', '.')), aj = Number(f.ajudantes), opr = Number(f.operadores);
  const errors = [
    !f.tipo && 'Escolha o tipo da OP.',
    !f.conferente.trim() && 'Informe o conferente.',
    !/^\d+$/.test(f.numero) && 'Informe o número da OP (somente dígitos).',
    !(kg > 0) && 'A quantidade em kg deve ser maior que zero.',
    !(f.ajudantes !== '' && Number.isInteger(aj) && aj >= 0) && 'Ajudantes: número inteiro, 0 ou mais.',
    !(f.operadores !== '' && Number.isInteger(opr) && opr >= 0) && 'Operadores: número inteiro, 0 ou mais.',
    aj + opr < 1 && 'Informe pelo menos um colaborador.',
  ].filter(Boolean) as string[];
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="bg-white rounded-xl p-5 space-y-4">
      <label className="block">Tipo da OP
        <select className={inp} value={f.tipo} onChange={e => setF({ ...f, tipo: e.target.value })}>
          <option value="">Selecione…</option>{cfg.tipos.map(t => <option key={t}>{t}</option>)}</select></label>
      <label className="block">Número da OP<input className={inp} inputMode="numeric" value={f.numero} onChange={set('numero')} /></label>
      <label className="block">Conferente
        {cfg.conferentes.length
          ? <select className={inp} value={f.conferente} onChange={e => setF({ ...f, conferente: e.target.value })}>
              <option value="">Selecione…</option>{cfg.conferentes.map(c => <option key={c}>{c}</option>)}</select>
          : <input className={inp} value={f.conferente} onChange={e => setF({ ...f, conferente: e.target.value })} />}</label>
      <label className="block">Quantidade (kg)<input className={inp} inputMode="decimal" value={f.kg} onChange={set('kg')} /></label>
      <label className="block">Ajudantes<input className={inp} inputMode="numeric" value={f.ajudantes} onChange={set('ajudantes')} /></label>
      <label className="block">Operadores<input className={inp} inputMode="numeric" value={f.operadores} onChange={set('operadores')} /></label>
      {sent && errors.map(e => <p key={e} className="text-red-700">{e}</p>)}
      <button className={`${btn} bg-[#16a34a] text-white`}
        onClick={() => { setSent(true); if (!errors.length) onStart({ tipo: f.tipo, conferente: f.conferente.trim(), numero: f.numero, kg, ajudantes: aj, operadores: opr }); }}>
        <Play />Iniciar Separação</button>
      <button className="w-full text-slate-500 underline" onClick={onCancel}>Cancelar</button>
    </div>
  );
}

function FinishForm({ op, efetivo, pausado, now, motivos, onConfirm, onBack }: { op: Op; efetivo: number; pausado: number; now: number; motivos: string[]; onConfirm: (f: Final) => void; onBack: () => void }) {
  const [imp, setImp] = useState<boolean | null>(null);
  const [mot, setMot] = useState<string[]>([]);
  const [desc, setDesc] = useState('');
  const invalid = imp === null || (imp && (!mot.length || !desc.trim()));
  return (
    <div className="bg-white rounded-xl p-5 space-y-4">
      <h2 className="text-2xl font-bold">Finalizar OP {op.numero}</h2>
      <ul className="text-lg space-y-1">
        <li>{op.kg} kg · {op.ajudantes + op.operadores} colaboradores</li>
        <li>Tempo efetivo: <b className="tnum">{fmt(efetivo)}</b> (pausas: {fmt(pausado)})</li>
        <li>Início: {fmtDate(op.events[0].at)}</li><li>Fim: {fmtDate(now)}</li>
      </ul>
      <p className="font-semibold text-lg">Houve impacto durante a separação?</p>
      <div className="grid grid-cols-2 gap-3">
        {[true, false].map(v => <button key={String(v)} onClick={() => setImp(v)}
          className={`h-14 rounded-lg text-lg font-semibold border-2 ${imp === v ? 'bg-[#0f2a4a] text-white border-[#0f2a4a]' : 'border-slate-300'}`}>{v ? 'Sim' : 'Não'}</button>)}
      </div>
      {imp && (<>
        {motivos.map(m => <label key={m} className="flex items-center gap-3 text-lg">
          <input type="checkbox" className="size-6" checked={mot.includes(m)}
            onChange={() => setMot(mot.includes(m) ? mot.filter(x => x !== m) : [...mot, m])} />{m}</label>)}
        <label className="block">Descreva o impacto ocorrido
          <textarea className="w-full min-h-28 p-3 rounded-lg border border-slate-300 text-lg" value={desc} onChange={e => setDesc(e.target.value)} /></label>
      </>)}
      <button disabled={!!invalid} className={`${btn} bg-[#16a34a] text-white`}
        onClick={() => onConfirm({ impacto: !!imp, motivos: imp ? mot : [], descricao: imp ? desc.trim() : '' })}>Confirmar finalização</button>
      <button className="w-full text-slate-500 underline" onClick={onBack}>Voltar ao cronômetro</button>
    </div>
  );
}

function Connect({ onDone }: { onDone: () => void }) {
  const [url, setUrl] = useState(DEFAULT_URL); const [pin, setPin] = useState('');
  const [err, setErr] = useState(''); const [wait, setWait] = useState(false);
  async function go() {
    setWait(true); setErr('');
    try { saveConn(url, pin); await call('ping'); onDone(); }
    catch (e) { clearConn(); setErr(e instanceof ApiError ? e.message : 'Não foi possível conectar. Verifique a internet e se a implantação está com acesso "Qualquer pessoa".'); }
    finally { setWait(false); }
  }
  return (
    <div className="min-h-screen bg-slate-100"><header className="bg-[#0f2a4a] text-white px-5 py-4"><h1 className="text-xl font-bold">Separação Ordem de Produção</h1></header>
      <main className="max-w-xl mx-auto p-5"><div className="bg-white rounded-xl p-5 space-y-4">
        <h2 className="text-2xl font-bold">Conectar à planilha</h2>
        <p className="text-slate-600">Informe uma vez neste dispositivo. A URL vem da implantação do Apps Script e o PIN, do menu “Separação OP” da planilha.</p>
        <label className="block">URL do aplicativo (termina em /exec)<input className={inp} value={url} onChange={e => setUrl(e.target.value)} /></label>
        <label className="block">PIN de acesso<input className={inp} value={pin} onChange={e => setPin(e.target.value)} /></label>
        {err && <p className="text-red-700">{err}</p>}
        <button disabled={wait} className={`${btn} bg-[#16a34a] text-white`} onClick={go}>{wait ? 'Conectando…' : 'Conectar'}</button>
      </div></main></div>
  );
}
