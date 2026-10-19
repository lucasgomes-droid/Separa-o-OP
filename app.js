/* =====================================================
   SEPARAÇÃO DE OP — FRONTEND (ICC Brazil)
   SPA em JS puro, sem build — mesmo modelo da Central de Frota. Fala
   com o backend em Google Apps Script via fetch(); a planilha do Google
   é a base de dados.

   Garantias contra perda e duplicidade:
   • Toda abertura/finalização ganha um idRequisicao e entra numa FILA
     guardada no aparelho (localStorage) ANTES de ser enviada. Só sai da
     fila quando o servidor confirma. Sem internet, fica lá e é reenviada
     sozinha (a cada 20 s, ao voltar a conexão e ao reabrir o app).
   • O servidor reconhece o idRequisicao: reenvio nunca grava duas vezes.
   • A hora gravada é a do toque no botão (corrigida pelo relógio do
     servidor), mesmo que o envio aconteça depois.
   ===================================================== */

// >>> COLE AQUI A URL DO SEU APPS SCRIPT WEB APP (termina em /exec) <<<
const API_URL = 'https://script.google.com/macros/s/AKfycbwUa4FrFtqXLp1HxC2Frk92QyGHTSVojI65qSQObTl1Pb7BDYtln5E8iIBMRaU4Cz9p/exec';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function () { /* PWA é bônus */ });
  });
}

// ------------------------- CONSTANTES -------------------------

const TIPOS_OP = ['Fábrica', 'Ribbon', 'Líquido'];
const MOTIVOS_IMPACTO = ['Numlist', 'Fumigação', 'Endereço divergente', 'Operador', 'Ajudantes', 'Outros'];
const CLASSE_TIPO = { 'Fábrica': 'fabrica', 'Ribbon': 'ribbon', 'Líquido': 'liquido' };
const STATUS_INFO = {
  andamento: { label: 'Em andamento', cls: 'andamento' },
  finalizada: { label: 'Finalizada', cls: 'finalizada' },
  cancelada: { label: 'Cancelada', cls: 'cancelada' }
};
const TIMEOUT_MS = 30000;
const TIMEOUT_LENTO = { getDashboard: 60000, getHistorico: 60000 };
const ATUALIZAR_A_CADA_MS = 15000;
const FILA_A_CADA_MS = 20000;
const CHAVE_SESSAO = 'sepop_sessao_v1';
const CHAVE_FILA = 'sepop_fila_v1';

// ------------------------- ESTADO -------------------------

const S = {
  usuario: null,       // { ID_USUARIO, NOME, TIPO }
  token: null,
  screen: 'login',
  perfil: null,        // 'CONFERENTE' | 'GESTOR' (escolha no login)
  pendingUser: null,
  offsetMs: 0,         // relógio do servidor − relógio do aparelho
  config: null,
  sepAtual: null,
  voltarPara: null,
  reqFinalizar: null,
  filtroAndamento: '',
  filtrosHist: null,
  filtrosDash: null,
  granularidade: 'dia',
  metricaEvolucao: 'kgPorHora'
};

const app = document.getElementById('app');
const ehGestor = function () { return !!S.usuario && S.usuario.TIPO === 'GESTOR'; };

// ------------------------- UTILITÁRIOS -------------------------

function el(html) { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild; }
function appendHtml(c, html) { const d = document.createElement('div'); d.innerHTML = html.trim(); while (d.firstChild) c.appendChild(d.firstChild); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function esperar(ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); }
function pad2(n) { return String(n).padStart(2, '0'); }
function novoId() { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 8); }

function toast(msg, erro, sucesso) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast is-show' + (erro ? ' is-error' : sucesso ? ' is-success' : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(function () { t.className = 'toast'; }, erro ? 6000 : 4000);
}

// Relógio: tudo que é "agora" usa a hora do servidor, para os cronômetros
// de aparelhos diferentes baterem e para a hora gravada ser confiável.
function agoraServidor() { return Date.now() + S.offsetMs; }
function ajustarRelogio(isoServidor) {
  const t = Date.parse(isoServidor);
  if (!isNaN(t)) S.offsetMs = t - Date.now();
}
function isoLocal(ms) {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset(), a = Math.abs(off);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(d.getHours()) + ':' +
    pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) + (off >= 0 ? '+' : '-') + pad2(Math.floor(a / 60)) + ':' + pad2(a % 60);
}
function isoAgora() { return isoLocal(agoraServidor()); }
function hojeYmd() { const d = new Date(agoraServidor()); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

function fmtData(v) { const d = new Date(v); return isNaN(d) || !v ? '—' : pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear(); }
function fmtHora(v) { const d = new Date(v); return isNaN(d) || !v ? '—' : pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
function fmtDataHora(v) { return v ? fmtData(v) + ' ' + fmtHora(v) : '—'; }
function fmtCronometro(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  return pad2(Math.floor(t / 3600)) + ':' + pad2(Math.floor((t % 3600) / 60)) + ':' + pad2(t % 60);
}
function fmtDuracao(min) {
  if (min === null || min === undefined || isNaN(min)) return '—';
  if (min < 1) return '< 1min';
  const total = Math.round(min), h = Math.floor(total / 60), m = total % 60;
  return h ? h + 'h ' + pad2(m) + 'min' : m + 'min';
}
function fmtNum(v, casas) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  return Number(v).toLocaleString('pt-BR', { minimumFractionDigits: casas || 0, maximumFractionDigits: casas || 0 });
}
function fmtKg(v) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  return Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + ' kg';
}
function fmtKgH(v) { return v === null || v === undefined ? '—' : fmtNum(v, 1) + ' kg/h'; }
function fmtPct(v) { return v === null || v === undefined ? '—' : fmtNum(v, 1) + '%'; }
function plural(n, s, p) { return n + ' ' + (n === 1 ? s : p); }

// "1.250,5" ou "1250.5" → 1250.5
function parseKg(t) {
  let s = String(t || '').trim().replace(/\s/g, '').replace(/kg$/i, '');
  if (!s) return NaN;
  if (s.indexOf(',') > -1) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return isFinite(n) ? n : NaN;
}

function tagStatus(st) { const i = STATUS_INFO[st] || { label: st, cls: 'cancelada' }; return '<span class="tag tag--' + i.cls + '">' + esc(i.label) + '</span>'; }
function tagTipo(t) { return '<span class="op-tag op-tag--' + (CLASSE_TIPO[t] || 'fabrica') + '">' + esc(t) + '</span>'; }
function equipeTxt(s) { return plural(s.operadores, 'operador', 'operadores') + ' · ' + plural(s.ajudantes, 'ajudante', 'ajudantes'); }

function screenHeader(eyebrow, titulo, sub) {
  return '<div class="stack" style="gap:4px;margin-bottom:6px"><span class="eyebrow">' + esc(eyebrow) + '</span>' +
    '<h1 class="title-xl">' + esc(titulo) + '</h1>' + (sub ? '<p class="subtle">' + esc(sub) + '</p>' : '') + '</div>';
}
function kpi(valor, rotulo, cls, sub) {
  return '<div class="kpi ' + (cls || '') + '"><span class="v">' + esc(valor) + '</span><span class="l">' + esc(rotulo) + '</span>' +
    (sub ? '<span class="s">' + esc(sub) + '</span>' : '') + '</div>';
}
function vazio(ic, txt) { return '<div class="empty"><span class="ic">' + ic + '</span>' + esc(txt) + '</div>'; }
function falhaBloco() {
  return '<div class="empty"><span class="ic">📡</span>Não foi possível carregar agora.<div style="margin-top:10px">' +
    '<button type="button" class="btn btn--outline btn--sm" onclick="render()">↻ Tentar de novo</button></div></div>';
}

// ------------------------- API -------------------------

function erroRede(tipo, msg, code) { const e = new Error(msg); e.tipo = tipo; e.code = code || ''; return e; }
function passageira(err) { return !!err && ['rede', 'timeout', 'resposta', 'ocupado'].indexOf(err.tipo) > -1; }
function plano(obj) {
  const out = {};
  Object.keys(obj || {}).forEach(function (k) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '' && typeof v !== 'object') out[k] = v;
  });
  return out;
}

// Uma ida ao servidor. Erro sempre com .tipo (rede|timeout|resposta|ocupado|aplicacao) e .code.
async function chamar(action, payload, token) {
  if (API_URL.indexOf('COLE_A_URL') > -1) throw erroRede('aplicacao', 'Configure a API_URL no topo do app.js.');
  if (navigator.onLine === false) throw erroRede('rede', 'Sem internet no aparelho.');
  const ctrl = new AbortController();
  const limite = setTimeout(function () { ctrl.abort(); }, TIMEOUT_LENTO[action] || TIMEOUT_MS);
  try {
    let res;
    if (action.indexOf('get') === 0) {
      const q = Object.assign({ action: action }, plano(payload));
      if (token) q.token = token;
      res = await fetch(API_URL + '?' + new URLSearchParams(q).toString(), { signal: ctrl.signal });
    } else {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // evita preflight CORS
        body: JSON.stringify({ action: action, payload: payload || {}, token: token || '' }),
        signal: ctrl.signal
      });
    }
    const texto = await res.text();
    let json;
    try { json = JSON.parse(texto); }
    catch (e) {
      console.error('[Separação OP] Resposta inesperada em ' + action + ': ' + texto.slice(0, 300));
      throw erroRede('resposta', 'O servidor não respondeu direito agora. Tente de novo em instantes.');
    }
    if (!json.ok) throw erroRede(json.code === 'OCUPADO' ? 'ocupado' : 'aplicacao', json.error || 'Erro desconhecido', json.code);
    marcarConexao(true);
    return json.data;
  } catch (err) {
    if (passageira(err) || err.tipo === undefined) marcarConexao(false);
    if (err.tipo) throw err;
    if (err.name === 'AbortError') throw erroRede('timeout', 'O servidor demorou para responder.');
    throw erroRede('rede', 'Não foi possível falar com o servidor. Confira a internet.');
  } finally {
    clearTimeout(limite);
  }
}

async function chamarComRepeticao(action, payload, token, tentativas) {
  const pausas = [800, 2000, 4000].slice(0, tentativas === undefined ? 3 : tentativas);
  for (let i = 0; ; i++) {
    try { return await chamar(action, payload, token); }
    catch (err) {
      if (passageira(err) && i < pausas.length) { await esperar(pausas[i]); continue; }
      throw err;
    }
  }
}

// Leituras e login (podem repetir à vontade).
async function api(action, payload, opts) {
  opts = opts || {};
  try {
    return await chamarComRepeticao(action, payload, S.token);
  } catch (err) {
    if (err.code === 'SESSAO' && S.usuario) { sair(); toast('Sua sessão expirou. Entre novamente.', true); throw err; }
    if (!opts.silencioso) toast(err.message, true);
    throw err;
  }
}

function marcarConexao(ok) {
  const dot = document.getElementById('syncDot');
  if (!dot) return;
  const pend = lerFila().length;
  dot.className = 'sync-dot' + (!ok ? ' is-off' : pend ? ' is-pend' : '');
  dot.title = !ok ? 'Sem conexão com a planilha' : pend ? 'Registros aguardando envio' : 'Conectado à planilha';
}

// ------------------------- FILA (sem perda de registro) -------------------------

function lerFila() { try { return JSON.parse(localStorage.getItem(CHAVE_FILA) || '[]'); } catch (e) { return []; } }
function gravarFila(f) {
  try { localStorage.setItem(CHAVE_FILA, JSON.stringify(f)); }
  catch (e) { toast('O aparelho está sem espaço para guardar o registro offline.', true); }
  atualizarAvisoFila();
}
function filaDoUsuario() { return S.usuario ? lerFila().filter(function (x) { return x.idUsuario === S.usuario.ID_USUARIO; }) : []; }

function atualizarAvisoFila() {
  const box = document.getElementById('filaAviso');
  const n = lerFila().length;
  if (!S.usuario || !n) { box.hidden = true; marcarConexao(navigator.onLine !== false); return; }
  box.hidden = false;
  document.getElementById('filaTexto').textContent = '⏳ ' + plural(n, 'registro guardado', 'registros guardados') +
    ' no aparelho, aguardando envio para a planilha.';
  marcarConexao(navigator.onLine !== false);
}

const RESULTADOS = {};
const ESPERANDO = {};
let PROCESSANDO = null;

function processarFila() {
  if (PROCESSANDO) return PROCESSANDO;
  PROCESSANDO = (async function () {
    for (;;) {
      const fila = lerFila();
      if (!fila.length) break;
      const item = fila[0];
      try {
        const data = await chamarComRepeticao(item.action, item.payload, item.token, 1);
        RESULTADOS[item.id] = { ok: true, data: data };
        if (!ESPERANDO[item.id]) {
          const sp = data && data.separacao;
          toast('Sincronizado: ' + (item.action === 'iniciarSeparacao' ? 'abertura' : 'finalização') +
            (sp ? ' da OP ' + sp.numeroOp : '') + '.', false, true);
        }
      } catch (err) {
        if (passageira(err)) break; // sem conexão: tenta depois, na mesma ordem
        RESULTADOS[item.id] = { ok: false, err: err };
        if (!ESPERANDO[item.id]) {
          toast('Não foi possível registrar a ' + (item.action === 'iniciarSeparacao' ? 'abertura' : 'finalização') +
            ' da OP ' + (item.payload.numeroOp || item.rotulo || '') + ': ' + err.message, true);
        }
      }
      gravarFila(lerFila().filter(function (x) { return x.id !== item.id; }));
    }
  })().finally(function () { PROCESSANDO = null; atualizarAvisoFila(); });
  return PROCESSANDO;
}

// Grava na fila e tenta enviar. Devolve { data } quando o servidor
// confirmou ou { pendente: true } quando ficou guardado sem conexão.
async function enviarComFila(action, payload, rotulo) {
  const item = { id: payload.idRequisicao, action: action, payload: payload, token: S.token,
    idUsuario: S.usuario.ID_USUARIO, criadoEm: Date.now(), rotulo: rotulo || '' };
  const fila = lerFila().filter(function (x) { return x.id !== item.id; });
  fila.push(item);
  gravarFila(fila);
  ESPERANDO[item.id] = true;
  try {
    await processarFila();
    if (!RESULTADOS[item.id] && lerFila().some(function (x) { return x.id === item.id; }) && navigator.onLine !== false) {
      await processarFila(); // pode ter entrado depois da última volta
    }
    const r = RESULTADOS[item.id];
    delete RESULTADOS[item.id];
    if (!r) return { pendente: true };
    if (!r.ok) throw r.err;
    return { data: r.data };
  } finally {
    delete ESPERANDO[item.id];
  }
}

setInterval(function () { if (lerFila().length) processarFila(); }, FILA_A_CADA_MS);
window.addEventListener('online', function () { marcarConexao(true); processarFila(); });
window.addEventListener('offline', function () { marcarConexao(false); });
document.getElementById('filaBotao').onclick = function () {
  processarFila().then(function () {
    if (lerFila().length) toast('Ainda sem conexão com a planilha. Os registros continuam guardados.', true);
    else if (S.usuario) render();
  });
};

// ------------------------- SESSÃO -------------------------

function salvarSessao() {
  try { sessionStorage.setItem(CHAVE_SESSAO, JSON.stringify({ usuario: S.usuario, token: S.token, offsetMs: S.offsetMs })); } catch (e) { /* segue */ }
}
function restaurarSessao() {
  try {
    const s = JSON.parse(sessionStorage.getItem(CHAVE_SESSAO) || 'null');
    if (s && s.token && s.usuario) { S.usuario = s.usuario; S.token = s.token; S.offsetMs = s.offsetMs || 0; S.screen = home(); }
  } catch (e) { /* começa no login */ }
}
function home() { return S.usuario && S.usuario.TIPO === 'GESTOR' ? 'aoVivo' : 'inicio'; }

function sair() {
  if (filaDoUsuario().length && !window.confirm('Há registros seus guardados no aparelho aguardando envio. Eles continuam guardados e serão enviados quando houver conexão. Sair mesmo assim?')) return false;
  S.usuario = null; S.token = null; S.config = null; S.sepAtual = null; S.filtrosHist = null; S.filtrosDash = null;
  try { sessionStorage.removeItem(CHAVE_SESSAO); } catch (e) { /* */ }
  S.screen = 'login';
  render();
  return true;
}
document.getElementById('btnLogout').onclick = function () { sair(); };

async function garantirConfig() {
  if (S.config) return S.config;
  const c = await api('getConfig', {}, { silencioso: true });
  S.config = c;
  ajustarRelogio(c.agora);
  salvarSessao();
  return c;
}

// ------------------------- ROTEADOR -------------------------

let GERACAO = 0;
let POLL = null;

function go(screen, extra) {
  S.screen = screen;
  if (extra) Object.assign(S, extra);
  render();
  window.scrollTo(0, 0);
}

const SCREENS = {
  login: renderLogin,
  loginUsuario: renderLoginUsuario,
  loginSenha: renderLoginSenha,
  inicio: renderInicio,
  iniciar: renderIniciar,
  finalizar: renderFinalizar,
  andamento: renderAndamento,
  aoVivo: renderAoVivo,
  historico: renderHistorico,
  detalhe: renderDetalhe,
  dashboard: renderDashboard
};
const SO_GESTOR = ['aoVivo', 'dashboard'];
const TAB_PAI = { iniciar: 'inicio', finalizar: 'inicio', detalhe: null };

function render() {
  GERACAO++;
  if (POLL) { clearInterval(POLL); POLL = null; }
  app.innerHTML = '';
  if (!S.usuario && ['login', 'loginUsuario', 'loginSenha'].indexOf(S.screen) === -1) S.screen = 'login';
  if (S.usuario && SO_GESTOR.indexOf(S.screen) > -1 && !ehGestor()) S.screen = 'inicio';
  const g = GERACAO;
  const fn = SCREENS[S.screen] || renderLogin;
  const falhou = function (err) {
    console.error('[Separação OP] Falha ao montar ' + S.screen, err);
    if (g === GERACAO) app.appendChild(el(falhaBloco()));
  };
  try { const r = fn(g); if (r && r.then) r.catch(falhou); } catch (e) { falhou(e); }
  atualizarChrome();
  atualizarAvisoFila();
}
function viva(g) { return g === GERACAO; }
function agendar(fn) { POLL = setInterval(function () { if (!document.hidden) fn(); }, ATUALIZAR_A_CADA_MS); }

function atualizarChrome() {
  const topbar = document.getElementById('topbar'), tabbar = document.getElementById('tabbar');
  if (!S.usuario) { topbar.hidden = true; tabbar.hidden = true; return; }
  topbar.hidden = false; tabbar.hidden = false;
  salvarSessao();
  document.getElementById('topbarUsuario').textContent = S.usuario.NOME + ' · ' + (ehGestor() ? 'Gestor' : 'Conferente');
  const tabs = ehGestor()
    ? [{ s: 'aoVivo', ic: '📡', label: 'Ao vivo' }, { s: 'andamento', ic: '⏱️', label: 'Em andamento' },
      { s: 'historico', ic: '🗂️', label: 'Histórico' }, { s: 'dashboard', ic: '📊', label: 'Dashboard' }]
    : [{ s: 'inicio', ic: '▶️', label: 'Separação' }, { s: 'andamento', ic: '⏱️', label: 'Em andamento' },
      { s: 'historico', ic: '🗂️', label: 'Histórico' }];
  const ativa = TAB_PAI[S.screen] !== undefined ? (TAB_PAI[S.screen] || S.voltarPara) : S.screen;
  tabbar.innerHTML = tabs.map(function (t) {
    return '<button class="' + (ativa === t.s ? 'is-active' : '') + '" data-s="' + t.s + '"><span class="ic">' + t.ic + '</span>' + t.label + '</button>';
  }).join('');
  tabbar.querySelectorAll('button').forEach(function (b) { b.onclick = function () { go(b.dataset.s); }; });
}

// Cronômetros: todo elemento com data-desde é atualizado a cada segundo.
// Quando o cartão tem data-media (tempo médio do tipo de OP, em min), a
// cor muda: acima da média → laranja; acima de 1,5× → vermelho.
setInterval(function () {
  const agora = agoraServidor();
  document.querySelectorAll('[data-desde]').forEach(function (n) {
    const ms = agora - Date.parse(n.dataset.desde);
    n.textContent = fmtCronometro(ms);
    const card = n.closest('[data-media]');
    if (card) {
      const media = Number(card.dataset.media) || 0;
      const min = ms / 60000;
      card.dataset.alerta = !media ? 'ok' : min > media * 1.5 ? 'alto' : min > media ? 'medio' : 'ok';
    }
  });
}, 1000);

// ------------------------- LOGIN -------------------------

function renderLogin() {
  appendHtml(app,
    '<div class="stack" style="padding-top:7vh">' +
      '<div class="login-logo"><img src="logo.png" alt="ICC Brazil"></div>' +
      '<h1 class="title-xl" style="text-align:center">Separação de OP</h1>' +
      '<p class="subtle" style="text-align:center;margin-bottom:8px">Abertura, acompanhamento e controle da separação</p>' +
      '<div class="card stack">' +
        '<button type="button" class="list-item" id="perfilConf"><span><span class="list-item__title">🧑‍🏭 Conferente</span>' +
          '<span class="list-item__sub">Abrir e finalizar separações</span></span><span>›</span></button>' +
        '<button type="button" class="list-item" id="perfilGest"><span><span class="list-item__title">🛡️ Gestor</span>' +
          '<span class="list-item__sub">Acompanhamento ao vivo, histórico e dashboard · pede senha</span></span><span>›</span></button>' +
      '</div>' +
    '</div>');
  document.getElementById('perfilConf').onclick = function () { go('loginUsuario', { perfil: 'CONFERENTE' }); };
  document.getElementById('perfilGest').onclick = function () { go('loginUsuario', { perfil: 'GESTOR' }); };
}

async function renderLoginUsuario(g) {
  appendHtml(app, screenHeader('Login · ' + (S.perfil === 'GESTOR' ? 'Gestor' : 'Conferente'), 'Quem é você?', 'Selecione seu nome'));
  const voltar = el('<button class="btn btn--outline btn--sm" style="align-self:flex-start;margin-bottom:12px">← Voltar</button>');
  voltar.onclick = function () { go('login'); };
  app.appendChild(voltar);
  const box = el('<div class="card stack"><p class="subtle">Carregando…</p></div>');
  app.appendChild(box);
  let lista;
  try { lista = await api('getUsuariosLogin', {}); } catch (e) { if (viva(g)) box.innerHTML = falhaBloco(); return; }
  if (!viva(g)) return;
  lista = lista.filter(function (u) { return u.TIPO === S.perfil; });
  box.innerHTML = '';
  if (!lista.length) { box.appendChild(el('<p class="subtle">Nenhum usuário ativo com esse perfil na aba CONFIG_USUARIOS.</p>')); return; }
  lista.forEach(function (u) {
    const b = el('<button type="button" class="list-item"><span><span class="list-item__title">' + esc(u.NOME) + '</span>' +
      '<span class="list-item__sub">' + (u.pedeSenha ? 'Pede senha' : 'Entrada direta') + '</span></span><span>›</span></button>');
    b.onclick = function () {
      if (u.pedeSenha) go('loginSenha', { pendingUser: u });
      else { b.disabled = true; entrar(u.ID_USUARIO, '').catch(function () { b.disabled = false; }); }
    };
    box.appendChild(b);
  });
}

function renderLoginSenha() {
  const u = S.pendingUser;
  appendHtml(app, screenHeader('Login', u.NOME, 'Digite sua senha'));
  const card = el('<div class="card stack"><div class="field"><label for="inpSenha">Senha</label>' +
    '<input type="password" id="inpSenha" autocomplete="current-password"></div>' +
    '<button class="btn btn--primary btn--block" id="btnEntrar">Entrar</button>' +
    '<button class="btn btn--outline btn--block" id="btnVoltar">← Voltar</button></div>');
  app.appendChild(card);
  const inp = card.querySelector('#inpSenha'), btn = card.querySelector('#btnEntrar');
  inp.focus();
  inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') btn.click(); });
  card.querySelector('#btnVoltar').onclick = function () { go('loginUsuario'); };
  btn.onclick = function () {
    btn.disabled = true; btn.textContent = 'Verificando…';
    entrar(u.ID_USUARIO, inp.value).catch(function () { btn.disabled = false; btn.textContent = 'Entrar'; });
  };
}

async function entrar(idUsuario, senha) {
  const d = await api('login', { idUsuario: idUsuario, senha: senha });
  S.token = d.token; S.usuario = d.usuario; S.config = null;
  ajustarRelogio(d.agora);
  salvarSessao();
  go(home());
  processarFila();
}

// ------------------------- CONFERENTE: SEPARAÇÃO -------------------------

function cartaoOp(sp, opts) {
  opts = opts || {};
  return '<div class="card stack" style="border-top:4px solid var(--accent)">' +
    '<div class="row between wrap"><span class="eyebrow">' + esc(opts.titulo || 'Sua separação em andamento') + '</span>' +
      (opts.tagExtra || tagStatus('andamento')) + '</div>' +
    '<div class="row wrap" style="gap:8px"><span class="shiplabel">OP ' + esc(sp.numeroOp) + '</span>' + tagTipo(sp.tipoOp) + '</div>' +
    '<div class="timer timer--xl" data-desde="' + esc(sp.inicio) + '">' + fmtCronometro(agoraServidor() - Date.parse(sp.inicio)) + '</div>' +
    '<div class="info-grid">' +
      '<div><div class="k">Quantidade</div><div class="v">' + fmtKg(sp.kg) + '</div></div>' +
      '<div><div class="k">Operadores</div><div class="v">' + sp.operadores + '</div></div>' +
      '<div><div class="k">Ajudantes</div><div class="v">' + sp.ajudantes + '</div></div>' +
      '<div><div class="k">Início</div><div class="v">' + fmtDataHora(sp.inicio) + '</div></div>' +
    '</div></div>';
}

async function renderInicio(g) {
  appendHtml(app, screenHeader('Separação', 'Olá, ' + S.usuario.NOME.split(' ')[0], 'Abra e finalize a sua separação de OP'));
  const body = el('<div class="stack"><p class="subtle">Carregando…</p></div>');
  app.appendChild(body);

  async function carregar() {
    let minha = null, falhou = false;
    try { const d = await api('getMinha', {}, { silencioso: true }); ajustarRelogio(d.agora); minha = d.separacao; }
    catch (e) { falhou = true; }
    if (!viva(g)) return;
    const fila = filaDoUsuario();
    const iniPend = fila.find(function (x) { return x.action === 'iniciarSeparacao'; });
    body.innerHTML = '';
    if (falhou) body.appendChild(el('<div class="note warn">Sem conexão com a planilha agora. Você pode continuar: o que registrar fica guardado no aparelho e é enviado sozinho quando a conexão voltar.</div>'));

    let sp = minha, pendenteIni = false;
    if (!sp && iniPend) {
      const p = iniPend.payload;
      sp = { id: '', idReqInicio: p.idRequisicao, numeroOp: p.numeroOp, tipoOp: p.tipoOp, kg: p.qtdKg, operadores: p.operadores,
        ajudantes: p.ajudantes, inicio: p.inicioCliente, conferente: S.usuario.NOME, status: 'andamento' };
      pendenteIni = true;
    }
    if (sp) {
      const finPend = fila.find(function (x) {
        return x.action === 'finalizarSeparacao' &&
          ((sp.id && x.payload.idSeparacao === sp.id) || (sp.idReqInicio && x.payload.idRequisicaoInicio === sp.idReqInicio));
      });
      appendHtml(body, cartaoOp(sp, {
        tagExtra: finPend ? '<span class="tag tag--pendente">Finalização aguardando envio</span>'
          : pendenteIni ? '<span class="tag tag--pendente">Abertura aguardando envio</span>' : null
      }));
      if (finPend) {
        body.appendChild(el('<div class="note warn">A finalização desta OP foi registrada às ' + fmtHora(finPend.payload.fimCliente) +
          ' e está guardada no aparelho. Ela será enviada para a planilha assim que houver conexão — não é preciso finalizar de novo.</div>'));
      } else {
        const btn = el('<button class="btn btn--accent btn--block btn--xl">⏹ Finalizar Separação</button>');
        btn.onclick = function () { go('finalizar', { sepAtual: sp, reqFinalizar: novoId(), voltarPara: 'inicio' }); };
        body.appendChild(btn);
        if (pendenteIni) body.appendChild(el('<div class="note warn">Esta abertura ainda não chegou à planilha (sem conexão). Ela será enviada com a hora em que você tocou em Iniciar.</div>'));
      }
      return;
    }
    const btn = el('<button type="button" class="btn-start"><span class="ic">▶</span><strong>Iniciar Separação</strong>' +
      '<span>Registra a data e a hora de início automaticamente</span></button>');
    btn.onclick = function () { go('iniciar'); };
    body.appendChild(btn);
    body.appendChild(el('<div class="note">Regra: cada conferente pode ter <strong>apenas uma OP em andamento</strong>. Para abrir outra, finalize a atual.</div>'));
  }
  await carregar();
  agendar(function () { if (S.screen === 'inicio') carregar(); });
}

function stepper(container, opts) {
  const id = 'st_' + Math.random().toString(36).slice(2);
  const wrap = el('<div class="field"><label for="' + id + '">' + esc(opts.label) + ' *</label>' +
    '<div class="stepper"><button type="button" data-d="-1" aria-label="Diminuir">−</button>' +
    '<input id="' + id + '" type="number" inputmode="numeric" min="' + opts.min + '" max="' + opts.max + '" value="' + opts.value + '">' +
    '<button type="button" data-d="1" aria-label="Aumentar">+</button></div></div>');
  const inp = wrap.querySelector('input');
  wrap.querySelectorAll('button').forEach(function (b) {
    b.onclick = function () {
      let n = parseInt(inp.value || '0', 10) || 0;
      n = Math.max(opts.min, Math.min(opts.max, n + Number(b.dataset.d)));
      inp.value = n;
    };
  });
  container.appendChild(wrap);
  return { node: wrap, getValue: function () { const t = String(inp.value).trim(); return /^\d+$/.test(t) ? parseInt(t, 10) : NaN; } };
}

function campoTexto(container, opts) {
  const id = 'f_' + Math.random().toString(36).slice(2);
  const tag = opts.multiline ? 'textarea' : 'input';
  const wrap = el('<div class="field"><label for="' + id + '">' + esc(opts.label) + (opts.required ? ' *' : '') + '</label>' +
    '<' + tag + ' id="' + id + '"' + (opts.multiline ? '' : ' type="text"') + ' placeholder="' + esc(opts.placeholder || '') + '"' +
    (opts.attrs || '') + '></' + tag + '>' + (opts.hint ? '<span class="hint">' + esc(opts.hint) + '</span>' : '') + '</div>');
  container.appendChild(wrap);
  const input = wrap.querySelector(tag);
  if (opts.value !== undefined) input.value = opts.value;
  input.addEventListener('input', function () {
    wrap.classList.remove('is-erro');
    const e = wrap.querySelector('.erro');
    if (e) e.remove();
  });
  return {
    node: wrap, input: input,
    getValue: function () { return String(input.value || '').trim(); },
    erro: function (msg) {
      wrap.classList.toggle('is-erro', !!msg);
      let e = wrap.querySelector('.erro');
      if (msg) { if (!e) { e = el('<span class="erro"></span>'); wrap.appendChild(e); } e.textContent = msg; }
      else if (e) e.remove();
    }
  };
}

function renderIniciar() {
  appendHtml(app, screenHeader('Nova separação', 'Iniciar Separação', 'Preencha os dados da OP. A data e a hora de início são registradas no toque do botão.'));
  const voltar = el('<button class="btn btn--outline btn--sm" style="align-self:flex-start;margin-bottom:12px">← Voltar</button>');
  voltar.onclick = function () { go('inicio'); };
  app.appendChild(voltar);

  const card = el('<div class="card stack"></div>');
  app.appendChild(card);
  campoTexto(card, { label: 'Nome do conferente', value: S.usuario.NOME, attrs: ' readonly', hint: 'Usuário do login' });

  let tipo = null;
  const tipoWrap = el('<div class="field"><label>Tipo de OP *</label><div class="option-grid">' +
    TIPOS_OP.map(function (t) { return '<button type="button" class="option-btn" data-t="' + esc(t) + '">' + esc(t) + '</button>'; }).join('') +
    '</div></div>');
  card.appendChild(tipoWrap);
  tipoWrap.querySelectorAll('.option-btn').forEach(function (b) {
    b.onclick = function () {
      tipo = b.dataset.t;
      tipoWrap.querySelectorAll('.option-btn').forEach(function (x) { x.classList.toggle('is-selected', x === b); });
      tipoWrap.classList.remove('is-erro');
    };
  });

  const op = campoTexto(card, { label: 'Número da OP', required: true, placeholder: 'Ex.: 001234',
    attrs: ' maxlength="30" autocapitalize="characters" autocomplete="off"' });
  op.input.addEventListener('input', function () { op.input.value = op.input.value.toUpperCase().replace(/\s+/g, ''); });
  const kg = campoTexto(card, { label: 'Quantidade total da OP (kg)', required: true, placeholder: 'Ex.: 1.250,5',
    attrs: ' inputmode="decimal" autocomplete="off"' });
  const grid = el('<div class="grid2"></div>');
  card.appendChild(grid);
  const operadores = stepper(grid, { label: 'Operadores', min: 0, max: 100, value: 1 });
  const ajudantes = stepper(grid, { label: 'Ajudantes', min: 0, max: 100, value: 0 });

  const btn = el('<button class="btn btn--primary btn--block btn--xl">▶ Iniciar Separação</button>');
  card.appendChild(btn);
  const reqId = novoId();

  btn.onclick = async function () {
    let ok = true;
    if (!tipo) { tipoWrap.classList.add('is-erro'); toast('Escolha o tipo de OP', true); ok = false; }
    const numero = op.getValue();
    if (!numero) { op.erro('Informe o número da OP'); ok = false; }
    else if (!/^[A-Z0-9][A-Z0-9.\-\/]{0,29}$/.test(numero)) { op.erro('Use só letras, números, ponto, hífen ou barra'); ok = false; }
    else op.erro('');
    const qtd = parseKg(kg.getValue());
    if (!(qtd > 0)) { kg.erro('Informe a quantidade em kg (maior que zero)'); ok = false; }
    else if (qtd > 1000000) { kg.erro('Quantidade acima do limite (1.000.000 kg)'); ok = false; }
    else kg.erro('');
    const nOp = operadores.getValue(), nAj = ajudantes.getValue();
    if (isNaN(nOp) || isNaN(nAj)) { toast('Informe operadores e ajudantes com números inteiros', true); ok = false; }
    else if (nOp + nAj < 1) { toast('Informe pelo menos um operador ou ajudante', true); ok = false; }
    if (!ok) return;
    if (!window.confirm('Iniciar a separação?\n\nOP ' + numero + ' · ' + tipo + '\n' + fmtKg(qtd) + '\n' +
      plural(nOp, 'operador', 'operadores') + ' e ' + plural(nAj, 'ajudante', 'ajudantes'))) return;
    await enviarInicio({ idRequisicao: reqId, numeroOp: numero, tipoOp: tipo, qtdKg: qtd, operadores: nOp, ajudantes: nAj, inicioCliente: isoAgora() });
  };

  async function enviarInicio(payload) {
    btn.disabled = true; btn.textContent = 'Registrando…';
    try {
      const r = await enviarComFila('iniciarSeparacao', payload, payload.numeroOp);
      if (r.pendente) toast('Sem conexão: a abertura foi guardada no aparelho e será enviada sozinha.', false);
      else toast('Separação da OP ' + r.data.separacao.numeroOp + ' iniciada às ' + fmtHora(r.data.separacao.inicio) + '.', false, true);
      go('inicio');
    } catch (err) {
      btn.disabled = false; btn.textContent = '▶ Iniciar Separação';
      if (err.code === 'OP_JA_SEPARADA') {
        if (window.confirm(err.message + '\n\nÉ uma nova separação da mesma OP? Toque em OK para abrir mesmo assim.')) {
          return enviarInicio(Object.assign({}, payload, { confirmarRepetida: true }));
        }
        return;
      }
      if (err.code === 'SESSAO') { sair(); return; }
      toast(err.message, true);
      if (err.code === 'CONFERENTE_OCUPADO') go('inicio');
    }
  }
}

// ------------------------- FINALIZAR -------------------------

function renderFinalizar() {
  const sp = S.sepAtual;
  if (!sp) { go(home()); return; }
  appendHtml(app, screenHeader('Finalizar', 'Finalizar Separação', 'A data e a hora de término são registradas no toque do botão.'));
  const voltar = el('<button class="btn btn--outline btn--sm" style="align-self:flex-start;margin-bottom:12px">← Voltar</button>');
  voltar.onclick = function () { go(S.voltarPara || home()); };
  app.appendChild(voltar);

  appendHtml(app, cartaoOp(sp, { titulo: sp.conferente ? 'Conferente: ' + sp.conferente : 'Separação em andamento' }));

  const card = el('<div class="card stack" style="margin-top:12px"></div>');
  app.appendChild(card);
  card.appendChild(el('<h3 class="title-lg">Houve algum impacto durante a separação desta OP?</h3>'));
  const btnNao = el('<button type="button" class="option-btn ok" style="width:100%">✓ Não houve impacto</button>');
  card.appendChild(btnNao);
  const grid = el('<div class="impact-grid">' + MOTIVOS_IMPACTO.map(function (m) {
    return '<button type="button" class="option-btn nok" data-m="' + esc(m) + '">' + esc(m) + '</button>';
  }).join('') + '</div>');
  card.appendChild(grid);
  card.appendChild(el('<p class="subtle">Pode marcar mais de um motivo. Cada motivo marcado pede uma descrição do que aconteceu.</p>'));
  const descs = el('<div class="stack"></div>');
  card.appendChild(descs);

  let semImpacto = false;
  const marcados = [];
  const textos = {};
  const campos = {};

  function desenhar() {
    btnNao.classList.toggle('is-selected', semImpacto);
    grid.querySelectorAll('.option-btn').forEach(function (b) { b.classList.toggle('is-selected', marcados.indexOf(b.dataset.m) > -1); });
    Object.keys(campos).forEach(function (m) { textos[m] = campos[m].getValue(); delete campos[m]; });
    descs.innerHTML = '';
    MOTIVOS_IMPACTO.filter(function (m) { return marcados.indexOf(m) > -1; }).forEach(function (m) {
      campos[m] = campoTexto(descs, { label: 'Descreva o impacto — ' + m, required: true, multiline: true,
        placeholder: 'O que aconteceu, quanto tempo atrasou, o que foi feito…', value: textos[m] || '' });
    });
  }
  btnNao.onclick = function () { semImpacto = true; marcados.length = 0; desenhar(); };
  grid.querySelectorAll('.option-btn').forEach(function (b) {
    b.onclick = function () {
      semImpacto = false;
      const i = marcados.indexOf(b.dataset.m);
      if (i > -1) marcados.splice(i, 1); else marcados.push(b.dataset.m);
      desenhar();
      if (i === -1 && campos[b.dataset.m]) campos[b.dataset.m].input.focus();
    };
  });

  const btn = el('<button class="btn btn--accent btn--block btn--xl">⏹ Finalizar Separação</button>');
  card.appendChild(btn);
  btn.onclick = async function () {
    if (!semImpacto && !marcados.length) { toast('Responda se houve impacto: escolha "Não houve impacto" ou um motivo.', true); return; }
    const impactos = [];
    let ok = true;
    marcados.forEach(function (m) {
      const t = campos[m].getValue();
      if (t.length < 5) { campos[m].erro('Descrição obrigatória (mínimo 5 caracteres)'); ok = false; }
      else { campos[m].erro(''); impactos.push({ motivo: m, descricao: t }); }
    });
    if (!ok) { toast('Descreva cada impacto marcado.', true); return; }
    const fim = isoAgora();
    const duracao = (Date.parse(fim) - Date.parse(sp.inicio)) / 60000;
    if (duracao < 1) {
      toast('Esta separação foi aberta há menos de 1 minuto. Se foi por engano, peça ao gestor para cancelar a abertura.', true);
      return;
    }
    if (!window.confirm('Finalizar a separação da OP ' + sp.numeroOp + '?\n\nDuração: ' + fmtDuracao(duracao) + '\n' +
      (semImpacto ? 'Sem impacto' : 'Impactos: ' + marcados.join(', ')))) return;
    btn.disabled = true; btn.textContent = 'Registrando…';
    try {
      const r = await enviarComFila('finalizarSeparacao', {
        idRequisicao: S.reqFinalizar || novoId(), idSeparacao: sp.id || '', idRequisicaoInicio: sp.id ? '' : (sp.idReqInicio || ''),
        semImpacto: semImpacto, impactos: impactos, fimCliente: fim
      }, sp.numeroOp);
      if (r.pendente) toast('Sem conexão: a finalização foi guardada no aparelho e será enviada sozinha.', false);
      else toast('OP ' + sp.numeroOp + ' finalizada · ' + fmtDuracao(r.data.separacao.duracaoMin) + '.', false, true);
      go(S.voltarPara === 'detalhe' ? 'andamento' : (S.voltarPara || home()));
    } catch (err) {
      btn.disabled = false; btn.textContent = '⏹ Finalizar Separação';
      if (err.code === 'SESSAO') { sair(); return; }
      toast(err.message, true);
      if (err.code === 'NAO_ESTA_EM_ANDAMENTO') go(home());
    }
  };
}

// ------------------------- EM ANDAMENTO -------------------------

function cartaoAoVivo(sp, media) {
  return '<button type="button" class="live-card" data-media="' + (media || 0) + '" data-alerta="ok" data-id="' + esc(sp.id) + '">' +
    '<div class="live-card__top"><span class="live-card__nome">' + esc(sp.conferente) + '</span>' + tagStatus(sp.status) + '</div>' +
    '<div class="row wrap" style="gap:8px"><span class="shiplabel">OP ' + esc(sp.numeroOp) + '</span>' + tagTipo(sp.tipoOp) + '</div>' +
    '<div class="timer" data-desde="' + esc(sp.inicio) + '">' + fmtCronometro(agoraServidor() - Date.parse(sp.inicio)) + '</div>' +
    '<div class="live-card__meta"><span>⚖️ <b>' + fmtKg(sp.kg) + '</b></span><span>👷 <b>' + sp.operadores + '</b> op.</span>' +
    '<span>🧑‍🔧 <b>' + sp.ajudantes + '</b> aj.</span><span>🕐 início <b>' + fmtDataHora(sp.inicio) + '</b></span>' +
    (media ? '<span>média do tipo <b>' + fmtDuracao(media) + '</b></span>' : '') + '</div></button>';
}

async function renderAndamento(g) {
  appendHtml(app, screenHeader('Ao vivo', 'Separações em andamento', 'Atualiza sozinho a cada 15 segundos'));
  const chips = el('<div class="chips" style="margin-bottom:12px"></div>');
  app.appendChild(chips);
  const status = el('<p class="subtle" style="margin-bottom:10px"></p>');
  app.appendChild(status);
  const body = el('<div class="live-grid"><p class="subtle">Carregando…</p></div>');
  app.appendChild(body);
  let dados = null;

  function desenhar() {
    const lista = dados.separacoes.filter(function (sp) { return !S.filtroAndamento || sp.tipoOp === S.filtroAndamento; });
    chips.innerHTML = ['', 'Fábrica', 'Ribbon', 'Líquido'].map(function (t) {
      const n = t ? dados.separacoes.filter(function (sp) { return sp.tipoOp === t; }).length : dados.separacoes.length;
      return '<button type="button" class="chip' + (S.filtroAndamento === t ? ' is-active' : '') + '" data-t="' + esc(t) + '">' + (t || 'Todos') + ' (' + n + ')</button>';
    }).join('');
    chips.querySelectorAll('.chip').forEach(function (c) { c.onclick = function () { S.filtroAndamento = c.dataset.t; desenhar(); }; });
    const pessoas = lista.reduce(function (t, sp) { return t + sp.operadores + sp.ajudantes; }, 0);
    const kgTot = lista.reduce(function (t, sp) { return t + sp.kg; }, 0);
    status.textContent = plural(lista.length, 'OP aberta', 'OPs abertas') + ' · ' + plural(pessoas, 'pessoa', 'pessoas') + ' em campo · ' +
      fmtKg(kgTot) + ' em separação · atualizado às ' + fmtHora(isoAgora()) + ':' + pad2(new Date(agoraServidor()).getSeconds());
    body.innerHTML = '';
    if (!lista.length) { body.appendChild(el(vazio('✅', 'Nenhuma separação em andamento agora.'))); return; }
    lista.forEach(function (sp) {
      const c = el(cartaoAoVivo(sp, dados.mediaMinPorTipo[sp.tipoOp]));
      c.onclick = function () { go('detalhe', { sepAtual: sp, voltarPara: 'andamento' }); };
      body.appendChild(c);
    });
  }
  async function carregar() {
    try { dados = await api('getAndamento', {}, { silencioso: !!dados }); ajustarRelogio(dados.agora); }
    catch (e) { if (viva(g) && !dados) body.innerHTML = falhaBloco(); return; }
    if (viva(g)) desenhar();
  }
  await carregar();
  agendar(function () { if (S.screen === 'andamento') carregar(); });
}

// ------------------------- GESTOR: AO VIVO -------------------------

async function renderAoVivo(g) {
  appendHtml(app, screenHeader('Gestão · tempo real', 'Visão operacional', 'Quem está separando o quê, há quanto tempo, e o que já foi finalizado hoje'));
  const body = el('<div class="stack"><p class="subtle">Carregando…</p></div>');
  app.appendChild(body);
  let carregou = false;

  async function carregar() {
    let d;
    try { d = await api('getAoVivo', {}, { silencioso: carregou }); ajustarRelogio(d.agora); }
    catch (e) { if (viva(g) && !carregou) body.innerHTML = falhaBloco(); return; }
    if (!viva(g)) return;
    carregou = true;
    const y = window.scrollY;
    body.innerHTML = '';
    appendHtml(body, '<div class="kpi-grid">' +
      kpi(d.andamento.length, 'OPs em andamento', 'kpi--warn') +
      kpi(d.pessoasEmCampo, 'Pessoas em campo', 'kpi--info', d.operadoresEmCampo + ' op. · ' + d.ajudantesEmCampo + ' aj.') +
      kpi(fmtKg(d.kgEmSeparacao), 'Kg em separação', 'kpi--brand') +
      kpi(d.totalFinalizadasHoje, 'Finalizadas hoje', 'kpi--ok') +
      kpi(fmtKg(d.hoje.kg), 'Kg separados hoje', 'kpi--ok') +
      kpi(fmtKgH(d.hoje.kgPorHora), 'Produtividade hoje', 'kpi--brand') +
      kpi(fmtDuracao(d.hoje.tempoMedioMin), 'Tempo médio hoje') +
      kpi(d.impactosHoje, 'Impactos hoje', d.impactosHoje ? 'kpi--risco' : '') + '</div>');

    body.appendChild(el('<div class="row between" style="margin-top:6px"><h3 class="title-lg">Conferentes</h3>' +
      '<span class="subtle">atualizado às ' + fmtHora(d.agora) + ' · a cada 15 s</span></div>'));
    const grid = el('<div class="live-grid"></div>');
    body.appendChild(grid);
    if (!d.conferentes.length) grid.appendChild(el(vazio('🧑‍🏭', 'Nenhum conferente cadastrado.')));
    d.conferentes.forEach(function (c) {
      if (c.separacao) {
        const card = el(cartaoAoVivo(c.separacao, d.mediaMinPorTipo[c.separacao.tipoOp]));
        appendHtml(card, '<div class="subtle">Hoje: ' + plural(c.finalizadasHoje, 'OP finalizada', 'OPs finalizadas') + ' · ' + fmtKg(c.kgHoje) + '</div>');
        card.onclick = function () { go('detalhe', { sepAtual: c.separacao, voltarPara: 'aoVivo' }); };
        grid.appendChild(card);
      } else {
        grid.appendChild(el('<div class="live-card is-livre"><div class="live-card__top"><span class="live-card__nome">' + esc(c.nome) + '</span>' +
          '<span class="tag tag--livre">Livre</span></div><div class="subtle">Hoje: ' + plural(c.finalizadasHoje, 'OP finalizada', 'OPs finalizadas') +
          ' · ' + fmtKg(c.kgHoje) + (c.ultimaFim ? ' · última às ' + fmtHora(c.ultimaFim) : '') + '</div></div>'));
      }
    });

    body.appendChild(el('<h3 class="title-lg" style="margin-top:6px">Finalizadas hoje</h3>'));
    const lista = el('<div class="stack" style="gap:8px"></div>');
    body.appendChild(lista);
    if (!d.finalizadasHoje.length) lista.appendChild(el(vazio('🕐', 'Nenhuma OP finalizada hoje ainda.')));
    d.finalizadasHoje.forEach(function (sp) { lista.appendChild(itemHistorico(sp, 'aoVivo')); });
    window.scrollTo(0, y);
  }
  await carregar();
  agendar(function () { if (S.screen === 'aoVivo') carregar(); });
}

// ------------------------- HISTÓRICO -------------------------

function itemHistorico(sp, voltar) {
  const imp = sp.status !== 'finalizada' ? '' : sp.teveImpacto
    ? '<span class="tag tag--impacto">' + esc(sp.motivos.join(', ')) + '</span>' : '<span class="tag tag--semimpacto">Sem impacto</span>';
  const cls = sp.status === 'andamento' ? 'is-warn' : sp.status === 'cancelada' ? 'is-off' : sp.teveImpacto ? 'is-warn' : 'is-ok';
  const b = el('<button type="button" class="list-item ' + cls + '"><span>' +
    '<span class="row wrap" style="gap:6px"><span class="shiplabel">OP ' + esc(sp.numeroOp) + '</span>' + tagTipo(sp.tipoOp) + imp + '</span>' +
    '<span class="list-item__sub" style="margin-top:6px"><strong>' + esc(sp.conferente) + '</strong> · ' + fmtDataHora(sp.inicio) +
    (sp.fim ? ' → ' + fmtHora(sp.fim) : '') + ' · <strong>' + fmtDuracao(sp.duracaoMin) + '</strong></span>' +
    '<span class="list-item__sub">' + fmtKg(sp.kg) + ' · ' + equipeTxt(sp) + '</span></span>' +
    '<span>' + tagStatus(sp.status) + '</span></button>');
  b.onclick = function () { go('detalhe', { sepAtual: sp, voltarPara: voltar }); };
  return b;
}

function opcoesMeses() {
  const d = new Date(agoraServidor());
  const out = [];
  for (let i = 0; i < 24; i++) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push({ v: m.getFullYear() + '-' + pad2(m.getMonth() + 1), t: pad2(m.getMonth() + 1) + '/' + m.getFullYear() });
  }
  return out;
}

// Filtro de período compartilhado (histórico e dashboard).
function filtroPeriodo(container, modos, valor, onChange) {
  const rotulos = { hoje: 'Hoje', dia: 'Dia específico', semana_atual: 'Esta semana', semana: 'Semana de uma data',
    mes_atual: 'Este mês', mes: 'Mês específico', ultimos7: 'Últimos 7 dias', ultimos30: 'Últimos 30 dias',
    custom: 'Período personalizado', todos: 'Todo o período' };
  const wrap = el('<div class="filters" style="grid-column:1/-1"></div>');
  container.appendChild(wrap);
  const fSel = el('<div class="field"><label>Período</label><select>' + modos.map(function (m) {
    return '<option value="' + m + '">' + rotulos[m] + '</option>'; }).join('') + '</select></div>');
  const fData = el('<div class="field"><label>Data</label><input type="date"></div>');
  const fMes = el('<div class="field"><label>Mês</label><select>' + opcoesMeses().map(function (o) {
    return '<option value="' + o.v + '">' + o.t + '</option>'; }).join('') + '</select></div>');
  const fIni = el('<div class="field"><label>De</label><input type="date"></div>');
  const fFim = el('<div class="field"><label>Até</label><input type="date"></div>');
  [fSel, fData, fMes, fIni, fFim].forEach(function (n) { wrap.appendChild(n); });
  const sel = fSel.querySelector('select');
  sel.value = valor.periodo || modos[0];
  fData.querySelector('input').value = valor.data || hojeYmd();
  if (valor.mes) fMes.querySelector('select').value = valor.mes;
  fIni.querySelector('input').value = valor.dataInicio || '';
  fFim.querySelector('input').value = valor.dataFim || '';
  function ajustar() {
    const m = sel.value;
    fData.hidden = !(m === 'dia' || m === 'semana');
    fData.querySelector('label').textContent = m === 'semana' ? 'Qualquer dia da semana' : 'Data';
    fMes.hidden = m !== 'mes';
    fIni.hidden = fFim.hidden = m !== 'custom';
  }
  ajustar();
  [sel, fData.querySelector('input'), fMes.querySelector('select'), fIni.querySelector('input'), fFim.querySelector('input')]
    .forEach(function (n) { n.addEventListener('change', function () { ajustar(); if (onChange) onChange(); }); });
  return {
    getValue: function () {
      const m = sel.value;
      return { periodo: m,
        data: (m === 'dia' || m === 'semana') ? fData.querySelector('input').value : undefined,
        mes: m === 'mes' ? fMes.querySelector('select').value : undefined,
        dataInicio: m === 'custom' ? fIni.querySelector('input').value : undefined,
        dataFim: m === 'custom' ? fFim.querySelector('input').value : undefined };
    }
  };
}

function selectSimples(container, label, opcoes, valor) {
  const f = el('<div class="field"><label>' + esc(label) + '</label><select>' + opcoes.map(function (o) {
    return '<option value="' + esc(o[0]) + '">' + esc(o[1]) + '</option>'; }).join('') + '</select></div>');
  container.appendChild(f);
  const s = f.querySelector('select');
  s.value = valor || '';
  return s;
}

async function renderHistorico(g) {
  appendHtml(app, screenHeader('Consulta', 'Histórico de separações', 'O período considera a data de início da separação'));
  let cfg;
  try { cfg = await garantirConfig(); } catch (e) { cfg = { conferentes: [] }; }
  if (!viva(g)) return;
  const f = S.filtrosHist || { periodo: 'semana_atual', status: 'finalizada' };

  const card = el('<div class="card stack"></div>');
  app.appendChild(card);
  const grid = el('<div class="filters"></div>');
  card.appendChild(grid);
  const per = filtroPeriodo(grid, ['hoje', 'dia', 'semana_atual', 'semana', 'mes_atual', 'mes', 'custom', 'todos'], f);
  const sConf = selectSimples(grid, 'Conferente', [['', 'Todos']].concat(cfg.conferentes.map(function (c) { return [c.id, c.nome]; })), f.conferente);
  const sTipo = selectSimples(grid, 'Tipo de OP', [['', 'Todos']].concat(TIPOS_OP.map(function (t) { return [t, t]; })), f.tipo);
  const sStatus = selectSimples(grid, 'Status', [['finalizada', 'Finalizadas'], ['andamento', 'Em andamento'], ['cancelada', 'Canceladas'], ['todos', 'Todos']], f.status);
  const sImp = selectSimples(grid, 'Impacto', [['', 'Todos'], ['sem', 'Sem impacto'], ['com', 'Com qualquer impacto']]
    .concat(MOTIVOS_IMPACTO.map(function (m) { return [m, m]; })), f.impacto);
  const fOp = el('<div class="field"><label>Número da OP</label><input type="search" placeholder="Contém…" autocapitalize="characters"></div>');
  grid.appendChild(fOp);
  const inpOp = fOp.querySelector('input');
  inpOp.value = f.numeroOp || '';
  const btn = el('<button class="btn btn--primary">🔎 Filtrar</button>');
  card.appendChild(btn);

  const body = el('<div class="stack" style="margin-top:14px"></div>');
  app.appendChild(body);

  async function carregar() {
    const filtros = Object.assign(per.getValue(), { conferente: sConf.value, tipo: sTipo.value, status: sStatus.value,
      impacto: sImp.value, numeroOp: inpOp.value.trim() });
    S.filtrosHist = filtros;
    body.innerHTML = '<p class="subtle">Carregando…</p>';
    let d;
    try { d = await api('getHistorico', filtros); } catch (e) { if (viva(g)) body.innerHTML = falhaBloco(); return; }
    if (!viva(g)) return;
    body.innerHTML = '';
    const r = d.resumo;
    appendHtml(body, '<p class="subtle">' + esc(d.periodo) + ' · ' + plural(d.total, 'registro', 'registros') +
      (d.limitado ? ' (mostrando os 1.000 mais recentes — use o CSV ou a planilha para o restante)' : '') + '</p>');
    if (r.ops) {
      appendHtml(body, '<div class="kpi-grid">' + kpi(r.ops, 'OPs finalizadas', 'kpi--ok') + kpi(fmtKg(r.kg), 'Kg separados', 'kpi--brand') +
        kpi(fmtDuracao(r.tempoMedioMin), 'Tempo médio por OP') + kpi(fmtKgH(r.kgPorHora), 'Produtividade', 'kpi--info') + '</div>');
    }
    if (!d.separacoes.length) { body.appendChild(el(vazio('🗂️', 'Nenhuma separação encontrada com esses filtros.'))); return; }
    const csv = el('<button class="btn btn--outline btn--sm" style="align-self:flex-start">⬇ Exportar CSV</button>');
    csv.onclick = function () { exportarCsvSeparacoes(d.separacoes); };
    body.appendChild(csv);
    const lista = el('<div class="stack" style="gap:8px"></div>');
    body.appendChild(lista);
    paginar(lista, d.separacoes, function (sp) { return itemHistorico(sp, 'historico'); }, 30);
  }
  btn.onclick = carregar;
  inpOp.addEventListener('keydown', function (e) { if (e.key === 'Enter') carregar(); });
  carregar();
}

function paginar(container, itens, fn, n) {
  let mostrados = 0;
  const mais = el('<div style="text-align:center"></div>');
  container.appendChild(mais);
  function proximo() {
    itens.slice(mostrados, mostrados + n).forEach(function (i) { container.insertBefore(fn(i), mais); });
    mostrados = Math.min(itens.length, mostrados + n);
    mais.innerHTML = '';
    if (mostrados < itens.length) {
      const b = el('<button class="btn btn--outline btn--sm">Carregar mais (' + mostrados + ' de ' + itens.length + ')</button>');
      b.onclick = proximo;
      mais.appendChild(b);
    }
  }
  proximo();
}

function baixarCsv(nome, colunas, linhas) {
  const e = function (v) { v = v == null ? '' : String(v); return /[;"\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const out = [colunas.map(function (c) { return e(c[0]); }).join(';')].concat(linhas.map(function (l) {
    return colunas.map(function (c) { return e(c[1](l)); }).join(';');
  }));
  const blob = new Blob(['﻿' + out.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = nome;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
}
function numCsv(v, c) { return v === null || v === undefined ? '' : Number(v).toFixed(c === undefined ? 2 : c).replace('.', ','); }
function exportarCsvSeparacoes(lista) {
  baixarCsv('separacoes_' + hojeYmd() + '.csv', [
    ['ID', function (s) { return s.id; }], ['OP', function (s) { return s.numeroOp; }], ['Tipo', function (s) { return s.tipoOp; }],
    ['Conferente', function (s) { return s.conferente; }], ['Status', function (s) { return (STATUS_INFO[s.status] || {}).label || s.status; }],
    ['Kg', function (s) { return numCsv(s.kg); }], ['Operadores', function (s) { return s.operadores; }], ['Ajudantes', function (s) { return s.ajudantes; }],
    ['Início', function (s) { return fmtDataHora(s.inicio); }], ['Término', function (s) { return fmtDataHora(s.fim); }],
    ['Duração (min)', function (s) { return numCsv(s.duracaoMin, 1); }],
    ['Kg/h', function (s) { return s.duracaoMin > 0 ? numCsv(s.kg / (s.duracaoMin / 60), 1) : ''; }],
    ['Impactos', function (s) { return s.motivos.join(', '); }],
    ['Descrição dos impactos', function (s) { return (s.impactos || []).map(function (i) { return i.motivo + ': ' + i.descricao; }).join(' | '); }],
    ['Observação', function (s) { return s.observacao; }]
  ], lista);
}

// ------------------------- DETALHE -------------------------

function renderDetalhe() {
  const sp = S.sepAtual;
  if (!sp) { go(home()); return; }
  appendHtml(app, screenHeader(sp.id || 'Separação', 'OP ' + sp.numeroOp, sp.conferente));
  const voltar = el('<button class="btn btn--outline btn--sm" style="align-self:flex-start;margin-bottom:12px">← Voltar</button>');
  voltar.onclick = function () { go(S.voltarPara || home()); };
  app.appendChild(voltar);

  const card = el('<div class="card stack"></div>');
  app.appendChild(card);
  appendHtml(card, '<div class="row between wrap"><div class="row wrap" style="gap:8px"><span class="shiplabel">OP ' + esc(sp.numeroOp) + '</span>' +
    tagTipo(sp.tipoOp) + '</div>' + tagStatus(sp.status) + '</div>');
  if (sp.status === 'andamento') {
    appendHtml(card, '<div><div class="subtle">Tempo decorrido</div><div class="timer timer--xl" data-desde="' + esc(sp.inicio) + '">' +
      fmtCronometro(agoraServidor() - Date.parse(sp.inicio)) + '</div></div>');
  }
  appendHtml(card, '<div class="info-grid">' +
    '<div><div class="k">Conferente</div><div class="v">' + esc(sp.conferente) + '</div></div>' +
    '<div><div class="k">Quantidade</div><div class="v">' + fmtKg(sp.kg) + '</div></div>' +
    '<div><div class="k">Operadores</div><div class="v">' + sp.operadores + '</div></div>' +
    '<div><div class="k">Ajudantes</div><div class="v">' + sp.ajudantes + '</div></div>' +
    '<div><div class="k">Início</div><div class="v">' + fmtDataHora(sp.inicio) + '</div></div>' +
    '<div><div class="k">Término</div><div class="v">' + fmtDataHora(sp.fim) + '</div></div>' +
    '<div><div class="k">Tempo total</div><div class="v">' + fmtDuracao(sp.duracaoMin) + '</div></div>' +
    '<div><div class="k">Produtividade</div><div class="v">' + (sp.duracaoMin > 0 ? fmtKgH(sp.kg / (sp.duracaoMin / 60)) : '—') + '</div></div>' +
    '</div>');
  if (sp.finalizadoPor && sp.finalizadoPor !== sp.conferente) {
    card.appendChild(el('<p class="subtle">' + (sp.status === 'cancelada' ? 'Cancelada' : 'Finalizada') + ' por ' + esc(sp.finalizadoPor) + '.</p>'));
  }
  if (sp.observacao) card.appendChild(el('<div class="note warn">' + esc(sp.observacao) + '</div>'));

  if (sp.status === 'finalizada') {
    const ic = el('<div class="card stack" style="margin-top:12px"><h3 class="title-lg">Impactos registrados</h3></div>');
    app.appendChild(ic);
    if (!sp.teveImpacto) ic.appendChild(el('<p class="subtle">✓ Não houve impacto nesta separação.</p>'));
    (sp.impactos || []).forEach(function (i) {
      ic.appendChild(el('<div class="note erro"><strong>' + esc(i.motivo) + '</strong><br>' + esc(i.descricao) + '</div>'));
    });
    if (sp.teveImpacto && !(sp.impactos || []).length) ic.appendChild(el('<p class="subtle">Motivos: ' + esc(sp.motivos.join(', ')) + '</p>'));
  }

  if (sp.status === 'andamento' && (ehGestor() || sp.idConferente === S.usuario.ID_USUARIO)) {
    const fin = el('<button class="btn btn--accent btn--block btn--xl" style="margin-top:12px">⏹ Finalizar Separação</button>');
    fin.onclick = function () { go('finalizar', { sepAtual: sp, reqFinalizar: novoId(), voltarPara: S.voltarPara || home() }); };
    app.appendChild(fin);
  }
  if (sp.status === 'andamento' && ehGestor()) {
    const canc = el('<button class="btn btn--danger btn--block" style="margin-top:10px">✕ Cancelar abertura (feita por engano)</button>');
    canc.onclick = async function () {
      const motivo = window.prompt('Motivo do cancelamento da OP ' + sp.numeroOp + ' (o registro continua na planilha como cancelado):');
      if (motivo === null) return;
      if (motivo.trim().length < 5) { toast('Informe o motivo (mínimo 5 caracteres).', true); return; }
      canc.disabled = true;
      try {
        await chamarComRepeticao('cancelarSeparacao', { idSeparacao: sp.id, motivo: motivo.trim() }, S.token, 1);
        toast('Separação cancelada.', false, true);
        go(S.voltarPara || home());
      } catch (err) { canc.disabled = false; toast(err.message, true); }
    };
    app.appendChild(canc);
  }
}

// ------------------------- DASHBOARD -------------------------

function barras(titulo, sub, itens) {
  const card = el('<div class="card stack"><h3 class="title-lg">' + esc(titulo) + '</h3>' + (sub ? '<p class="subtle" style="margin-top:-6px">' + esc(sub) + '</p>' : '') + '</div>');
  const validos = itens.filter(function (i) { return i.valor !== null && i.valor !== undefined; });
  if (!validos.length) { card.appendChild(el('<p class="subtle">Sem dados no período.</p>')); return card; }
  const max = Math.max.apply(null, validos.map(function (i) { return i.valor; }).concat([0.0001]));
  itens.forEach(function (i) {
    card.appendChild(el('<div class="bar-row"><span class="label" title="' + esc(i.rotulo) + '">' + esc(i.rotulo) + '</span>' +
      '<div class="bar-track">' + (i.valor ? '<div class="bar-fill" style="width:' + Math.max(3, i.valor / max * 100) + '%' + (i.cor ? ';background:' + i.cor : '') + '"></div>' : '') + '</div>' +
      '<span class="bar-val">' + esc(i.texto) + '</span></div>'));
  });
  return card;
}

function graficoColunas(titulo, sub, itens) {
  const p = el('<div class="chart-panel"><div><h3>' + esc(titulo) + '</h3><span class="chart-sub">' + esc(sub) + '</span></div></div>');
  if (!itens.length) { p.appendChild(el('<p class="chart-sub">Sem dados no período.</p>')); return p; }
  const max = Math.max.apply(null, itens.map(function (i) { return i.valor || 0; }).concat([0.0001]));
  const scroll = el('<div class="chart-scroll"></div>');
  const inner = el('<div style="min-width:' + Math.max(itens.length * 42, 200) + 'px"></div>');
  const bars = el('<div class="chart-bars"></div>'), labels = el('<div class="chart-labels"></div>');
  itens.forEach(function (i) {
    bars.appendChild(el('<div class="chart-col" title="' + esc(i.rotulo + ': ' + i.texto) + '"><span class="chart-val">' + esc(i.curto) + '</span>' +
      '<div class="chart-bar" style="height:' + Math.max(2, (i.valor || 0) / max * 100) + '%"></div></div>'));
    labels.appendChild(el('<span>' + esc(i.rotulo) + '</span>'));
  });
  inner.appendChild(bars); inner.appendChild(labels); scroll.appendChild(inner); p.appendChild(scroll);
  return p;
}

function tabela(colunas, linhas) {
  const w = el('<div class="table-scroll"></div>');
  const t = document.createElement('table');
  t.className = 'report-table';
  t.innerHTML = '<thead><tr>' + colunas.map(function (c) { return '<th class="' + (c[2] ? 'num' : '') + '">' + esc(c[0]) + '</th>'; }).join('') + '</tr></thead>';
  const tb = document.createElement('tbody');
  linhas.forEach(function (l) {
    const tr = document.createElement('tr');
    tr.innerHTML = colunas.map(function (c) { return '<td class="' + (c[2] ? 'num' : '') + '">' + esc(c[1](l)) + '</td>'; }).join('');
    tb.appendChild(tr);
  });
  t.appendChild(tb); w.appendChild(t);
  return w;
}

const COR_TIPO = { 'Fábrica': '#5e9030', 'Ribbon': '#2563eb', 'Líquido': '#0e7490' };
const METRICAS = {
  kgPorHora: { rotulo: 'Produtividade (kg/h)', fmt: fmtKgH, curto: function (v) { return v === null ? '—' : fmtNum(v, 0); } },
  kgPorHoraOperador: { rotulo: 'kg/h por operador', fmt: fmtKgH, curto: function (v) { return v === null ? '—' : fmtNum(v, 0); } },
  kgPorHoraAjudante: { rotulo: 'kg/h por ajudante', fmt: fmtKgH, curto: function (v) { return v === null ? '—' : fmtNum(v, 0); } },
  kg: { rotulo: 'Kg separados', fmt: fmtKg, curto: function (v) { return v >= 1000 ? fmtNum(v / 1000, 1) + 't' : fmtNum(v, 0); } },
  ops: { rotulo: 'OPs finalizadas', fmt: function (v) { return fmtNum(v); }, curto: function (v) { return fmtNum(v); } },
  tempoMedioMin: { rotulo: 'Tempo médio por OP', fmt: fmtDuracao, curto: function (v) { return v === null ? '—' : fmtNum(v, 0) + "'"; } }
};

async function renderDashboard(g) {
  appendHtml(app, screenHeader('Gestão', 'Dashboard de produtividade', 'Calculado com os registros da planilha'));
  let cfg;
  try { cfg = await garantirConfig(); } catch (e) { cfg = { conferentes: [] }; }
  if (!viva(g)) return;
  const f = S.filtrosDash || { periodo: 'mes_atual' };
  const card = el('<div class="card stack"></div>');
  app.appendChild(card);
  const grid = el('<div class="filters"></div>');
  card.appendChild(grid);
  const per = filtroPeriodo(grid, ['hoje', 'semana_atual', 'mes_atual', 'ultimos7', 'ultimos30', 'dia', 'semana', 'mes', 'custom', 'todos'], f, function () { carregar(); });
  const sTipo = selectSimples(grid, 'Tipo de OP', [['', 'Todos']].concat(TIPOS_OP.map(function (t) { return [t, t]; })), f.tipo);
  const sConf = selectSimples(grid, 'Conferente', [['', 'Todos']].concat(cfg.conferentes.map(function (c) { return [c.id, c.nome]; })), f.conferente);
  sTipo.onchange = sConf.onchange = function () { carregar(); };

  const body = el('<div class="stack" style="margin-top:14px"></div>');
  app.appendChild(body);

  async function carregar() {
    const filtros = Object.assign(per.getValue(), { tipo: sTipo.value, conferente: sConf.value });
    S.filtrosDash = filtros;
    body.innerHTML = '<p class="subtle">Calculando…</p>';
    let d;
    try { d = await api('getDashboard', filtros); } catch (e) { if (viva(g)) body.innerHTML = falhaBloco(); return; }
    if (!viva(g)) return;
    montarDashboard(body, d);
  }
  carregar();
}

function montarDashboard(body, d) {
  body.innerHTML = '';
  const t = d.totais;
  appendHtml(body, '<p class="subtle">' + esc(d.periodo) + ' · gerado às ' + fmtHora(d.geradoEm) + '</p>');
  appendHtml(body, '<div class="kpi-grid">' +
    kpi(fmtNum(t.ops), 'OPs separadas', 'kpi--ok', 'finalizadas no período') +
    kpi(fmtKg(t.kg), 'Kg separados', 'kpi--brand') +
    kpi(fmtDuracao(t.tempoMedioMin), 'Tempo médio por OP', '', fmtNum(t.horas, 1) + ' h de separação') +
    kpi(fmtKgH(t.kgPorHora), 'Produtividade', 'kpi--info') +
    kpi(fmtKgH(t.kgPorHoraOperador), 'Por operador', 'kpi--info', fmtNum(t.horasOperador, 1) + ' h·operador') +
    kpi(fmtKgH(t.kgPorHoraAjudante), 'Por ajudante', 'kpi--info', fmtNum(t.horasAjudante, 1) + ' h·ajudante') +
    kpi(d.andamentoAgora, 'Em andamento agora', 'kpi--warn', d.canceladasNoPeriodo ? d.canceladasNoPeriodo + ' cancelada(s) no período' : '') +
    kpi(d.impactosRegistrados, 'Impactos registrados', d.impactosRegistrados ? 'kpi--risco' : '', t.opsComImpacto + ' OP(s) · ' + fmtPct(t.pctComImpacto)) +
    '</div>');

  const notas = el('<details class="note"><summary style="cursor:pointer;font-weight:600">Como cada indicador é calculado</summary>' +
    '<ul style="margin:8px 0 0;padding-left:18px">' + d.formulas.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></details>');
  body.appendChild(notas);

  // ---- comparativo por tipo ----
  body.appendChild(barras('Produtividade por tipo de OP', 'kg/h de cada tipo (Fábrica, Ribbon e Líquido)', d.porTipo.map(function (x) {
    return { rotulo: x.tipo, valor: x.kgPorHora, texto: fmtKgH(x.kgPorHora), cor: COR_TIPO[x.tipo] };
  })));
  const cTipo = el('<div class="card stack"><h3 class="title-lg">Comparativo por tipo de OP</h3></div>');
  cTipo.appendChild(tabela([
    ['Tipo', function (x) { return x.tipo; }],
    ['OPs', function (x) { return fmtNum(x.ops); }, 1], ['Kg', function (x) { return fmtKg(x.kg); }, 1],
    ['Tempo médio', function (x) { return fmtDuracao(x.tempoMedioMin); }, 1], ['kg/h', function (x) { return fmtKgH(x.kgPorHora); }, 1],
    ['kg/h por operador', function (x) { return fmtKgH(x.kgPorHoraOperador); }, 1], ['kg/h por ajudante', function (x) { return fmtKgH(x.kgPorHoraAjudante); }, 1],
    ['kg/h por pessoa', function (x) { return fmtKgH(x.kgPorHoraPessoa); }, 1], ['% com impacto', function (x) { return fmtPct(x.pctComImpacto); }, 1]
  ], d.porTipo));
  body.appendChild(cTipo);

  // ---- evolução ----
  const evo = el('<div class="stack"></div>');
  body.appendChild(evo);
  const controles = el('<div class="row wrap" style="gap:10px"></div>');
  evo.appendChild(controles);
  const seg = el('<div class="segmented" style="flex:1 1 260px">' + [['dia', 'Por dia'], ['semana', 'Por semana'], ['mes', 'Por mês']].map(function (o) {
    return '<button type="button" data-g="' + o[0] + '">' + o[1] + '</button>'; }).join('') + '</div>');
  controles.appendChild(seg);
  const selM = el('<select style="flex:1 1 200px;padding:9px 10px;border:1px solid var(--line);border-radius:8px;font-size:14px">' +
    Object.keys(METRICAS).map(function (k) { return '<option value="' + k + '">' + METRICAS[k].rotulo + '</option>'; }).join('') + '</select>');
  controles.appendChild(selM);
  selM.value = S.metricaEvolucao;
  const evoBox = el('<div></div>');
  evo.appendChild(evoBox);
  function desenharEvolucao() {
    seg.querySelectorAll('button').forEach(function (b) { b.classList.toggle('is-active', b.dataset.g === S.granularidade); });
    const m = METRICAS[S.metricaEvolucao];
    const serie = d.evolucao[S.granularidade] || [];
    evoBox.innerHTML = '';
    evoBox.appendChild(graficoColunas('Evolução — ' + m.rotulo, { dia: 'Por dia', semana: 'Por semana (início na segunda)', mes: 'Por mês' }[S.granularidade] + ' · período filtrado',
      serie.map(function (x) { const v = x[S.metricaEvolucao]; return { rotulo: x.rotulo, valor: v, texto: m.fmt(v), curto: m.curto(v) }; })));
  }
  seg.querySelectorAll('button').forEach(function (b) { b.onclick = function () { S.granularidade = b.dataset.g; desenharEvolucao(); }; });
  selM.onchange = function () { S.metricaEvolucao = selM.value; desenharEvolucao(); };
  desenharEvolucao();

  // ---- impactos ----
  body.appendChild(barras('Principais motivos de impacto', d.impactosRegistrados + ' ocorrência(s) no período', d.motivos.map(function (m) {
    return { rotulo: m.motivo, valor: m.ocorrencias, texto: m.ocorrencias + ' · ' + fmtPct(m.pct), cor: '#dc2626' };
  })));
  const ci = d.comparativoImpacto;
  const cImp = el('<div class="card stack"><h3 class="title-lg">Efeito dos impactos na produtividade</h3>' +
    '<p class="subtle" style="margin-top:-6px">Mesmo cálculo (kg ÷ horas) separando OPs com e sem impacto</p></div>');
  appendHtml(cImp, '<div class="kpi-grid">' +
    kpi(fmtKgH(ci.semImpacto.kgPorHora), 'Sem impacto', 'kpi--ok', fmtNum(ci.semImpacto.ops) + ' OP(s) · média ' + fmtDuracao(ci.semImpacto.tempoMedioMin)) +
    kpi(fmtKgH(ci.comImpacto.kgPorHora), 'Com impacto', 'kpi--risco', fmtNum(ci.comImpacto.ops) + ' OP(s) · média ' + fmtDuracao(ci.comImpacto.tempoMedioMin)) +
    '</div>');
  if (d.motivos.length) {
    cImp.appendChild(tabela([
      ['Motivo', function (m) { return m.motivo; }], ['Ocorrências', function (m) { return fmtNum(m.ocorrencias); }, 1],
      ['OPs afetadas', function (m) { return fmtNum(m.opsAfetadas); }, 1], ['kg/h dessas OPs', function (m) { return fmtKgH(m.kgPorHora); }, 1],
      ['Tempo médio', function (m) { return fmtDuracao(m.tempoMedioMin); }, 1]
    ], d.motivos));
  }
  body.appendChild(cImp);

  // ---- por conferente ----
  const cConf = el('<div class="card stack"><h3 class="title-lg">Por conferente</h3></div>');
  if (!d.porConferente.length) cConf.appendChild(el('<p class="subtle">Sem OPs finalizadas no período.</p>'));
  else {
    cConf.appendChild(tabela([
      ['Conferente', function (x) { return x.conferente; }], ['OPs', function (x) { return fmtNum(x.ops); }, 1],
      ['Kg', function (x) { return fmtKg(x.kg); }, 1], ['Tempo médio', function (x) { return fmtDuracao(x.tempoMedioMin); }, 1],
      ['kg/h', function (x) { return fmtKgH(x.kgPorHora); }, 1], ['kg/h por operador', function (x) { return fmtKgH(x.kgPorHoraOperador); }, 1],
      ['kg/h por ajudante', function (x) { return fmtKgH(x.kgPorHoraAjudante); }, 1], ['% com impacto', function (x) { return fmtPct(x.pctComImpacto); }, 1]
    ], d.porConferente));
    const b = el('<button class="btn btn--outline btn--sm" style="align-self:flex-start">⬇ Exportar CSV</button>');
    b.onclick = function () {
      baixarCsv('produtividade_conferentes_' + hojeYmd() + '.csv', [
        ['Conferente', function (x) { return x.conferente; }], ['OPs', function (x) { return x.ops; }], ['Kg', function (x) { return numCsv(x.kg); }],
        ['Horas', function (x) { return numCsv(x.horas); }], ['Tempo médio (min)', function (x) { return numCsv(x.tempoMedioMin, 1); }],
        ['Kg/h', function (x) { return numCsv(x.kgPorHora, 1); }], ['Kg/h por operador', function (x) { return numCsv(x.kgPorHoraOperador, 1); }],
        ['Kg/h por ajudante', function (x) { return numCsv(x.kgPorHoraAjudante, 1); }], ['% com impacto', function (x) { return numCsv(x.pctComImpacto, 1); }]
      ], d.porConferente);
    };
    cConf.appendChild(b);
  }
  body.appendChild(cConf);
}

// ------------------------- PRIMEIRA PINTURA -------------------------

restaurarSessao();
render();
if (S.usuario) {
  garantirConfig().catch(function () { /* sem conexão: segue com o relógio salvo */ });
  processarFila();
}
