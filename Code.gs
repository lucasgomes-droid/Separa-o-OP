/**
 * CENTRAL DE SEPARAÇÃO DE OP — BACKEND (Google Apps Script)
 * ----------------------------------------------------------
 * Mesma arquitetura da Central de Frota: o site estático (GitHub Pages)
 * conversa com este Web App via fetch(), e a planilha do Google Sheets é a
 * base de dados (abas SEPARACOES, IMPACTOS, CONFIG_USUARIOS, LOG_EVENTOS).
 *
 * INSTALAÇÃO (resumo — o passo a passo completo está no README.md):
 * 1. Planilha nova > Extensões > Apps Script > cole este arquivo.
 * 2. Configurações do projeto > Fuso horário: (GMT-03:00) São Paulo.
 * 3. Rode configurarPlanilha() uma vez (cria as abas e os usuários de exemplo).
 * 4. Implantar > Nova implantação > App da Web
 *      Executar como: Eu · Quem pode acessar: Qualquer pessoa
 * 5. Copie a URL /exec e cole em API_URL no app.js.
 * Sempre que editar este arquivo: Implantar > Gerenciar implantações >
 * Editar > Versão: Nova versão (senão a URL continua com o código antigo).
 *
 * CONVENÇÕES:
 * - Resposta: { ok: true, data } ou { ok: false, error, code }.
 * - Leituras ("get...") por GET; gravações por POST com corpo JSON em
 *   text/plain (evita o preflight CORS do navegador).
 * - Datas trafegam e ficam na planilha como texto ISO com fuso
 *   (ex.: 2026-10-18T14:32:00-03:00).
 * - Toda gravação leva um idRequisicao gerado no app e gravado na própria
 *   linha: se o mesmo pedido chegar duas vezes (rede caiu, reenvio da fila
 *   offline, clique duplo) o servidor devolve o registro já gravado em vez
 *   de duplicar.
 */

// ======================= CONFIGURAÇÃO =======================

const SHEETS = {
  USUARIOS: 'CONFIG_USUARIOS',
  SEPARACOES: 'SEPARACOES',
  IMPACTOS: 'IMPACTOS',
  LOG: 'LOG_EVENTOS',
  SEQ: '_SEQ'
};

const HEADERS = {
  CONFIG_USUARIOS: ['ID_USUARIO', 'NOME', 'TIPO', 'SENHA', 'ATIVO'],
  SEPARACOES: ['ID_SEPARACAO', 'NUMERO_OP', 'TIPO_OP', 'QTD_KG', 'OPERADORES', 'AJUDANTES',
    'ID_CONFERENTE', 'CONFERENTE', 'STATUS', 'INICIO', 'DIA', 'FIM', 'DURACAO_MIN',
    'TEVE_IMPACTO', 'MOTIVOS_IMPACTO', 'FINALIZADO_POR', 'OBSERVACAO',
    'REGISTRADO_EM', 'ATUALIZADO_EM', 'ID_REQ_INICIO', 'ID_REQ_FIM'],
  IMPACTOS: ['ID_IMPACTO', 'ID_SEPARACAO', 'NUMERO_OP', 'TIPO_OP', 'CONFERENTE', 'MOTIVO', 'DESCRICAO', 'DATA_HORA'],
  LOG_EVENTOS: ['DATA_HORA', 'ACAO', 'ID_SEPARACAO', 'NUMERO_OP', 'USUARIO', 'DETALHE'],
  _SEQ: ['PREFIXO', 'ULTIMO_NUMERO']
};

// Colunas gravadas como texto puro: o Sheets não pode "converter" número
// de OP com zero à esquerda, IDs nem as datas ISO.
const COLUNAS_TEXTO = {
  CONFIG_USUARIOS: ['ID_USUARIO', 'SENHA'],
  SEPARACOES: ['ID_SEPARACAO', 'NUMERO_OP', 'ID_CONFERENTE', 'INICIO', 'DIA', 'FIM', 'REGISTRADO_EM', 'ATUALIZADO_EM', 'ID_REQ_INICIO', 'ID_REQ_FIM'],
  IMPACTOS: ['ID_IMPACTO', 'ID_SEPARACAO', 'NUMERO_OP', 'DATA_HORA'],
  LOG_EVENTOS: ['DATA_HORA', 'ID_SEPARACAO', 'NUMERO_OP']
};

const TIPOS_OP = ['Fábrica', 'Ribbon', 'Líquido'];
const MOTIVOS_IMPACTO = ['Numlist', 'Fumigação', 'Endereço divergente', 'Operador', 'Ajudantes', 'Outros'];
const ST = { ANDAMENTO: 'andamento', FINALIZADA: 'finalizada', CANCELADA: 'cancelada' };
const ROTULO_STATUS = { andamento: 'em andamento', finalizada: 'finalizada', cancelada: 'cancelada' };

const SESSAO_DIAS = 7;
// O app manda a hora em que o conferente tocou no botão (já corrigida pelo
// relógio do servidor). Ela vale se não estiver no futuro (tolerância) e
// não for mais antiga que a janela offline — assim um registro guardado no
// aparelho sem internet entra com a hora real do clique.
const TOLERANCIA_FUTURO_MS = 2 * 60000;
const JANELA_OFFLINE_MS = 12 * 3600000;
const LIMITE_HISTORICO = 1000;
const DURACAO_MINIMA_MIN = 1;

const ACOES_PUBLICAS = ['getUsuariosLogin', 'login'];
const ACOES_GESTOR = ['getDashboard', 'getAoVivo', 'cancelarSeparacao'];

// ======================= INSTALAÇÃO =======================

// Rode uma vez pelo editor (▶ Executar). Pode ser rodada de novo com
// segurança: só cria o que falta; os exemplos só entram em aba vazia.
function configurarPlanilha() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(HEADERS).forEach(function (nome) {
    let sh = ss.getSheetByName(nome);
    if (!sh) sh = ss.insertSheet(nome);
    const cab = HEADERS[nome];
    const atual = sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String) : [];
    if (!atual.join('')) {
      sh.getRange(1, 1, 1, cab.length).setValues([cab]);
    } else {
      // Aba já existe: acrescenta no fim só as colunas que faltarem.
      cab.forEach(function (h) {
        if (atual.indexOf(h) === -1) { atual.push(h); sh.getRange(1, atual.length).setValue(h); }
      });
    }
    sh.getRange(1, 1, 1, sh.getLastColumn()).setFontWeight('bold');
    sh.setFrozenRows(1);
    formatarColunasTexto_(nome, 2, Math.max(sh.getMaxRows() - 1, 1));
  });

  semear_(SHEETS.USUARIOS, [
    ['USR-001', 'Gestor', 'GESTOR', '1234', 'SIM'],
    ['USR-002', 'Conferente Exemplo 1', 'CONFERENTE', '', 'SIM'],
    ['USR-003', 'Conferente Exemplo 2', 'CONFERENTE', '', 'SIM']
  ]);
  SpreadsheetApp.flush();
  return 'Planilha configurada. Troque a senha do gestor na aba CONFIG_USUARIOS.';
}

function semear_(nome, linhas) {
  const sh = aba_(nome);
  if (sh.getLastRow() <= 1) sh.getRange(2, 1, linhas.length, linhas[0].length).setValues(linhas);
}

function formatarColunasTexto_(nome, linhaIni, qtd) {
  const sh = aba_(nome);
  const cab = cabecalho_(nome);
  (COLUNAS_TEXTO[nome] || []).forEach(function (h) {
    const c = cab.indexOf(h);
    if (c > -1) sh.getRange(linhaIni, c + 1, qtd, 1).setNumberFormat('@');
  });
}

// ======================= ENTRADA HTTP =======================

function doGet(e) {
  const p = Object.assign({}, (e && e.parameter) || {});
  return jsonOut_(executar_(p.action, p, p.token));
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); }
  catch (err) { return jsonOut_({ ok: false, error: 'Pedido inválido.' }); }
  return jsonOut_(executar_(body.action, body.payload || {}, body.token));
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function executar_(action, params, token) {
  MEMO_ = {};
  try {
    const sessao = autenticar_(action, params || {}, token);
    return { ok: true, data: rotear_(action, params || {}, sessao) };
  } catch (err) {
    return { ok: false, error: err.message || String(err), code: err.code || '' };
  }
}

function rotear_(action, p, s) {
  switch (action) {
    case 'getUsuariosLogin': return getUsuariosLogin_();
    case 'login': return login_(p);
    case 'getConfig': return getConfig_(s);
    case 'getMinha': return getMinha_(s);
    case 'getAndamento': return getAndamento_();
    case 'getAoVivo': return getAoVivo_();
    case 'getHistorico': return getHistorico_(p);
    case 'getDashboard': return getDashboard_(p);
    case 'iniciarSeparacao': return iniciarSeparacao_(p, s);
    case 'finalizarSeparacao': return finalizarSeparacao_(p, s);
    case 'cancelarSeparacao': return cancelarSeparacao_(p, s);
    default: throw new Error('Ação desconhecida: ' + action);
  }
}

function falha_(code, mensagem) {
  const e = new Error(mensagem);
  e.code = code;
  return e;
}

// ======================= PLANILHA =======================

var MEMO_ = {};

function aba_(nome) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(nome);
  if (!sh) throw new Error('A aba "' + nome + '" não existe. Rode configurarPlanilha() no editor do Apps Script.');
  return sh;
}

function cabecalho_(nome) {
  const sh = aba_(nome);
  const n = sh.getLastColumn();
  return n ? sh.getRange(1, 1, 1, n).getValues()[0].map(function (h) { return String(h).trim(); }) : [];
}

// Lê a aba inteira uma vez por pedido. Cada objeto guarda a linha real
// (_linha) para a atualização gravar no lugar certo.
function ler_(nome) {
  if (!MEMO_[nome]) {
    const valores = aba_(nome).getDataRange().getValues();
    const cab = valores.length ? valores[0].map(function (h) { return String(h).trim(); }) : [];
    MEMO_[nome] = valores.slice(1).map(function (r, i) {
      const o = { _linha: i + 2, _vazia: r.join('') === '' };
      cab.forEach(function (h, j) {
        if (!h) return;
        let v = r[j];
        if (v instanceof Date) v = toIso_(v);
        o[h] = v;
      });
      return o;
    }).filter(function (o) { return !o._vazia; });
  }
  return MEMO_[nome].map(function (o) { return Object.assign({}, o); });
}

function inserir_(nome, objs) {
  if (!objs.length) return;
  const sh = aba_(nome);
  const cab = cabecalho_(nome);
  const matriz = objs.map(function (o) {
    return cab.map(function (h) { return (o[h] === undefined || o[h] === null) ? '' : o[h]; });
  });
  const linha = sh.getLastRow() + 1;
  formatarColunasTexto_(nome, linha, matriz.length);
  sh.getRange(linha, 1, matriz.length, cab.length).setValues(matriz);
  delete MEMO_[nome];
}

// Atualiza uma linha conferindo antes que ela ainda é do mesmo registro.
function atualizar_(nome, linha, colunaId, valorId, mudancas) {
  const sh = aba_(nome);
  const cab = cabecalho_(nome);
  const atual = sh.getRange(linha, 1, 1, cab.length).getValues()[0];
  if (String(atual[cab.indexOf(colunaId)]) !== String(valorId)) {
    throw new Error('A planilha foi alterada enquanto o registro era salvo. Atualize a tela e tente de novo.');
  }
  Object.keys(mudancas).forEach(function (k) {
    const c = cab.indexOf(k);
    if (c > -1) atual[c] = mudancas[k];
  });
  sh.getRange(linha, 1, 1, cab.length).setValues([atual]);
  delete MEMO_[nome];
}

function nextIds_(prefixo, qtd) {
  const sh = aba_(SHEETS.SEQ);
  const valores = sh.getDataRange().getValues();
  let ultimo = 0, linha = -1;
  for (let i = 1; i < valores.length; i++) {
    if (String(valores[i][0]) === prefixo) { ultimo = Number(valores[i][1]) || 0; linha = i + 1; break; }
  }
  const ids = [];
  for (let n = 1; n <= qtd; n++) ids.push(prefixo + '-' + String(ultimo + n).padStart(6, '0'));
  if (linha > -1) sh.getRange(linha, 2).setValue(ultimo + qtd);
  else sh.appendRow([prefixo, qtd]);
  return ids;
}
function nextId_(prefixo) { return nextIds_(prefixo, 1)[0]; }

// Trava do script: só um pedido por vez grava (gera ID, confere regras
// e escreve a linha). Leituras não usam trava.
function comTrava_(fn) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(20000); }
  catch (e) { throw falha_('OCUPADO', 'O servidor está ocupado com outros registros. Aguarde alguns segundos e tente de novo.'); }
  try { return fn(); }
  finally { lock.releaseLock(); }
}

function cache_(chave, segundos, fn) {
  const cache = CacheService.getScriptCache();
  const v = cache.get(chave);
  if (v !== null) return JSON.parse(v);
  const r = fn();
  try { cache.put(chave, JSON.stringify(r), segundos); } catch (e) { /* grande demais: segue sem cache */ }
  return r;
}

function limparCacheAoVivo_() {
  try { CacheService.getScriptCache().removeAll(['andamento_v1']); } catch (e) { /* expira sozinho em 5 s */ }
}

function log_(acao, sep, usuario, detalhe) {
  try {
    inserir_(SHEETS.LOG, [{
      DATA_HORA: toIso_(new Date()), ACAO: acao, ID_SEPARACAO: sep.ID_SEPARACAO || '',
      NUMERO_OP: sep.NUMERO_OP || '', USUARIO: usuario || '', DETALHE: detalhe || ''
    }]);
  } catch (e) { /* o log nunca derruba o registro */ }
}

// ======================= DATAS =======================

function fuso_() { return Session.getScriptTimeZone() || 'America/Sao_Paulo'; }

function toIso_(d) {
  const tz = fuso_();
  const base = Utilities.formatDate(d, tz, "yyyy-MM-dd'T'HH:mm:ss");
  const z = Utilities.formatDate(d, tz, 'Z'); // -0300
  return base + z.slice(0, 3) + ':' + z.slice(3);
}

function parseData_(v) {
  if (v === '' || v === null || v === undefined) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const t = String(v).trim();
  const so = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (so) return new Date(Number(so[1]), Number(so[2]) - 1, Number(so[3]));
  const d = new Date(t);
  return isNaN(d.getTime()) ? null : d;
}

function fmtData_(d) { return Utilities.formatDate(d, fuso_(), 'dd/MM/yyyy'); }
function fmtDataHora_(v) { const d = parseData_(v); return d ? Utilities.formatDate(d, fuso_(), 'dd/MM/yyyy HH:mm') : '-'; }
function chaveDia_(d) { return Utilities.formatDate(d, fuso_(), 'yyyy-MM-dd'); }

// Hora informada pelo app, se for plausível; senão, a hora do servidor.
function horaDoCliente_(valor, agora, minimo) {
  const d = parseData_(valor);
  let h = agora;
  if (d && d.getTime() <= agora.getTime() + TOLERANCIA_FUTURO_MS && d.getTime() >= agora.getTime() - JANELA_OFFLINE_MS) {
    h = d.getTime() > agora.getTime() ? agora : d;
  }
  if (minimo && h.getTime() < minimo.getTime()) h = agora.getTime() < minimo.getTime() ? minimo : agora;
  return h;
}

// Janela de datas de cada filtro de período. O período sempre se refere à
// DATA DE INÍCIO da separação (documentado na tela e no README).
function janela_(p) {
  const modo = String(p.periodo || 'mes_atual');
  const hoje = new Date();
  const ini = function (d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };
  const fimDia = function (d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999); };
  const base = parseData_(p.data) || hoje;
  let i, f, label;
  switch (modo) {
    case 'hoje':
      i = ini(hoje); f = fimDia(hoje); label = 'Hoje (' + fmtData_(i) + ')'; break;
    case 'dia':
      i = ini(base); f = fimDia(base); label = 'Dia ' + fmtData_(i); break;
    case 'semana_atual':
    case 'semana': {
      const ref = modo === 'semana' ? base : hoje;
      const dow = (ref.getDay() + 6) % 7; // segunda = 0
      i = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - dow);
      f = fimDia(new Date(i.getFullYear(), i.getMonth(), i.getDate() + 6));
      label = 'Semana de ' + fmtData_(i) + ' a ' + fmtData_(f); break;
    }
    case 'mes_atual':
    case 'mes': {
      let ano = hoje.getFullYear(), mes = hoje.getMonth();
      const m = String(p.mes || '').match(/^(\d{4})-(\d{2})$/);
      if (modo === 'mes' && m) { ano = Number(m[1]); mes = Number(m[2]) - 1; }
      i = new Date(ano, mes, 1);
      f = new Date(ano, mes + 1, 0, 23, 59, 59, 999);
      label = 'Mês ' + Utilities.formatDate(i, fuso_(), 'MM/yyyy'); break;
    }
    case 'ultimos7':
    case 'ultimos30': {
      const n = modo === 'ultimos7' ? 7 : 30;
      i = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() - (n - 1));
      f = fimDia(hoje); label = 'Últimos ' + n + ' dias'; break;
    }
    case 'custom': {
      const a = parseData_(p.dataInicio), b = parseData_(p.dataFim);
      i = a ? ini(a) : null; f = b ? fimDia(b) : fimDia(hoje);
      if (i && f < i) throw new Error('A data final é anterior à inicial.');
      label = (i ? fmtData_(i) : 'início') + ' a ' + fmtData_(f); break;
    }
    case 'todos':
      i = null; f = null; label = 'Todo o período'; break;
    default:
      throw new Error('Período inválido: ' + modo);
  }
  return { inicio: i, fim: f, label: label };
}

function dentro_(valor, j) {
  if (!j.inicio && !j.fim) return true;
  const d = parseData_(valor);
  if (!d) return false;
  return (!j.inicio || d >= j.inicio) && (!j.fim || d <= j.fim);
}

// ======================= VALIDAÇÃO =======================

function texto_(v) { return String(v === undefined || v === null ? '' : v).trim(); }

function numero_(v) {
  if (typeof v === 'number') return v;
  const t = texto_(v);
  if (!t) return NaN;
  return Number(t.indexOf(',') > -1 ? t.replace(/\./g, '').replace(',', '.') : t);
}

function inteiro_(v, nome, min, max) {
  const t = texto_(v);
  if (!/^\d+$/.test(t)) throw new Error('Informe ' + nome + ' com um número inteiro.');
  const n = Number(t);
  if (n < min || n > max) throw new Error(nome + ' deve ficar entre ' + min + ' e ' + max + '.');
  return n;
}

function validarOp_(v) {
  const op = texto_(v).toUpperCase().replace(/\s+/g, '');
  if (!op) throw new Error('Informe o número da OP.');
  if (!/^[A-Z0-9][A-Z0-9.\-\/]{0,29}$/.test(op)) throw new Error('Número da OP inválido: use só letras, números, ponto, hífen ou barra (até 30 caracteres).');
  return op;
}

function validarTipo_(v) {
  const t = texto_(v);
  const achado = TIPOS_OP.find(function (x) { return x.toLowerCase() === t.toLowerCase(); });
  if (!achado) throw new Error('Tipo de OP inválido. Use Fábrica, Ribbon ou Líquido.');
  return achado;
}

function exigirIdReq_(v) {
  const id = texto_(v);
  if (!/^[\w\-]{8,80}$/.test(id)) throw new Error('Pedido sem identificação. Atualize o app e tente de novo.');
  return id;
}

// ======================= USUÁRIOS / SESSÃO =======================

function usuarios_() {
  return cache_('usuarios_v1', 60, function () {
    return ler_(SHEETS.USUARIOS)
      .filter(function (u) { return String(u.ATIVO).trim().toUpperCase() === 'SIM' && texto_(u.ID_USUARIO); })
      .map(function (u) {
        return {
          ID_USUARIO: texto_(u.ID_USUARIO), NOME: texto_(u.NOME),
          TIPO: texto_(u.TIPO).toUpperCase() === 'GESTOR' ? 'GESTOR' : 'CONFERENTE',
          SENHA: texto_(u.SENHA)
        };
      });
  });
}

function publico_(u) { return { ID_USUARIO: u.ID_USUARIO, NOME: u.NOME, TIPO: u.TIPO }; }

// Gestor sempre entra com senha. Conferente entra só escolhendo o nome
// (igual ao operador da Central de Frota) — a não ser que a coluna SENHA
// dele esteja preenchida na planilha, aí a senha também é pedida.
function getUsuariosLogin_() {
  return usuarios_().map(function (u) {
    return Object.assign(publico_(u), { pedeSenha: u.TIPO === 'GESTOR' || !!u.SENHA });
  }).sort(function (a, b) { return a.NOME.localeCompare(b.NOME); });
}

function login_(p) {
  const u = usuarios_().find(function (x) { return x.ID_USUARIO === texto_(p.idUsuario); });
  if (!u) throw new Error('Usuário não encontrado ou inativo.');
  const pede = u.TIPO === 'GESTOR' || !!u.SENHA;
  if (pede) {
    if (u.TIPO === 'GESTOR' && !u.SENHA) throw new Error('Este gestor está sem senha na planilha (aba CONFIG_USUARIOS).');
    const cache = CacheService.getScriptCache();
    const chave = 'falha_' + u.ID_USUARIO;
    const falhas = Number(cache.get(chave) || 0);
    if (falhas >= 5) throw new Error('Muitas tentativas com senha errada. Aguarde 15 minutos.');
    if (texto_(p.senha) !== u.SENHA) { cache.put(chave, String(falhas + 1), 900); throw new Error('Senha incorreta.'); }
    cache.remove(chave);
  }
  return Object.assign(criarSessao_(u), { agora: toIso_(new Date()) });
}

function segredo_() {
  const props = PropertiesService.getScriptProperties();
  let s = props.getProperty('SESSAO_SEGREDO');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); props.setProperty('SESSAO_SEGREDO', s); }
  return s;
}

function b64_(dados) { return Utilities.base64EncodeWebSafe(dados).replace(/=+$/, ''); }

// A senha e o perfil entram na assinatura: trocar a senha ou o TIPO na
// planilha invalida as sessões antigas daquele usuário.
function assinar_(corpo, u) {
  return b64_(Utilities.computeHmacSha256Signature(corpo + '|' + u.SENHA + '|' + u.TIPO, segredo_()));
}

function criarSessao_(u) {
  const corpo = b64_(JSON.stringify({ u: u.ID_USUARIO, exp: Date.now() + SESSAO_DIAS * 86400000 }));
  return { token: 'v1.' + corpo + '.' + assinar_(corpo, u), usuario: publico_(u) };
}

function lerSessao_(token) {
  const partes = texto_(token).split('.');
  if (partes.length !== 3 || partes[0] !== 'v1') return null;
  let dados;
  try {
    let b = partes[1];
    while (b.length % 4) b += '=';
    dados = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(b)).getDataAsString());
  } catch (e) { return null; }
  if (!dados || !(Number(dados.exp) > Date.now())) return null;
  const u = usuarios_().find(function (x) { return x.ID_USUARIO === String(dados.u); });
  if (!u || assinar_(partes[1], u) !== partes[2]) return null;
  return u;
}

function autenticar_(action, params, token) {
  if (ACOES_PUBLICAS.indexOf(action) > -1) return null;
  const s = lerSessao_(token);
  if (!s) throw falha_('SESSAO', 'Sessão expirada. Entre novamente.');
  if (ACOES_GESTOR.indexOf(action) > -1 && s.TIPO !== 'GESTOR') throw new Error('Ação restrita ao gestor.');
  return s;
}

// ======================= LEITURA / FORMATO =======================

function num_(v) { const n = numero_(v); return isNaN(n) ? 0 : n; }
function r1_(v) { return Math.round(v * 10) / 10; }
function r2_(v) { return Math.round(v * 100) / 100; }

function impactosPorSep_() {
  const m = {};
  ler_(SHEETS.IMPACTOS).forEach(function (i) {
    const k = String(i.ID_SEPARACAO);
    (m[k] = m[k] || []).push({ motivo: texto_(i.MOTIVO), descricao: texto_(i.DESCRICAO), dataHora: texto_(i.DATA_HORA) });
  });
  return m;
}

function sepOut_(r, impactos) {
  const id = String(r.ID_SEPARACAO);
  const o = {
    id: id,
    numeroOp: texto_(r.NUMERO_OP),
    tipoOp: texto_(r.TIPO_OP),
    kg: num_(r.QTD_KG),
    operadores: num_(r.OPERADORES),
    ajudantes: num_(r.AJUDANTES),
    idConferente: texto_(r.ID_CONFERENTE),
    conferente: texto_(r.CONFERENTE),
    status: texto_(r.STATUS),
    inicio: texto_(r.INICIO),
    fim: texto_(r.FIM),
    duracaoMin: (r.DURACAO_MIN === '' || r.DURACAO_MIN === undefined) ? null : num_(r.DURACAO_MIN),
    teveImpacto: texto_(r.TEVE_IMPACTO).toUpperCase() === 'SIM',
    motivos: texto_(r.MOTIVOS_IMPACTO).split('|').map(texto_).filter(Boolean),
    finalizadoPor: texto_(r.FINALIZADO_POR),
    observacao: texto_(r.OBSERVACAO),
    idReqInicio: texto_(r.ID_REQ_INICIO)
  };
  if (impactos) o.impactos = impactos[id] || [];
  return o;
}

// Tempo médio (min) das OPs finalizadas nos últimos 30 dias, por tipo —
// serve para o painel ao vivo destacar separações que já passaram da média.
function mediaPorTipo_(rows) {
  const desde = Date.now() - 30 * 86400000;
  const soma = {};
  rows.forEach(function (r) {
    if (texto_(r.STATUS) !== ST.FINALIZADA) return;
    const d = parseData_(r.INICIO);
    if (!d || d.getTime() < desde) return;
    const t = texto_(r.TIPO_OP);
    const s = soma[t] || (soma[t] = [0, 0]);
    s[0] += num_(r.DURACAO_MIN); s[1]++;
  });
  const out = {};
  Object.keys(soma).forEach(function (t) { out[t] = r1_(soma[t][0] / soma[t][1]); });
  return out;
}

function conferentes_() {
  return usuarios_().filter(function (u) { return u.TIPO === 'CONFERENTE'; })
    .map(function (u) { return { id: u.ID_USUARIO, nome: u.NOME }; })
    .sort(function (a, b) { return a.nome.localeCompare(b.nome); });
}

function getConfig_(s) {
  return {
    agora: toIso_(new Date()),
    usuario: publico_(s),
    tiposOp: TIPOS_OP,
    motivosImpacto: MOTIVOS_IMPACTO,
    conferentes: conferentes_()
  };
}

function getMinha_(s) {
  const r = ler_(SHEETS.SEPARACOES).find(function (x) {
    return texto_(x.STATUS) === ST.ANDAMENTO && texto_(x.ID_CONFERENTE) === s.ID_USUARIO;
  });
  return { agora: toIso_(new Date()), separacao: r ? sepOut_(r) : null };
}

function getAndamento_() {
  const dados = cache_('andamento_v1', 5, function () {
    const rows = ler_(SHEETS.SEPARACOES);
    return {
      separacoes: rows.filter(function (r) { return texto_(r.STATUS) === ST.ANDAMENTO; })
        .map(function (r) { return sepOut_(r); })
        .sort(function (a, b) { return Date.parse(a.inicio) - Date.parse(b.inicio); }),
      mediaMinPorTipo: mediaPorTipo_(rows)
    };
  });
  return Object.assign(dados, { agora: toIso_(new Date()) });
}

// ======================= GRAVAÇÕES =======================

function iniciarSeparacao_(p, s) {
  const numeroOp = validarOp_(p.numeroOp);
  const tipo = validarTipo_(p.tipoOp);
  const kg = numero_(p.qtdKg);
  if (!(kg > 0) || kg > 1000000) throw new Error('Informe a quantidade total da OP em kg (maior que zero).');
  const operadores = inteiro_(p.operadores, 'a quantidade de operadores', 0, 100);
  const ajudantes = inteiro_(p.ajudantes, 'a quantidade de ajudantes', 0, 100);
  if (operadores + ajudantes < 1) throw new Error('Informe pelo menos um operador ou ajudante na equipe.');
  const idReq = exigirIdReq_(p.idRequisicao);
  const confirmar = p.confirmarRepetida === true || String(p.confirmarRepetida) === 'true';

  return comTrava_(function () {
    const rows = ler_(SHEETS.SEPARACOES);
    // 1) Mesmo pedido chegando de novo: devolve o que já foi gravado.
    const repetida = rows.find(function (r) { return texto_(r.ID_REQ_INICIO) === idReq; });
    if (repetida) return { separacao: sepOut_(repetida), repetida: true };

    // 2) Regra: um conferente, uma OP em andamento.
    const ativa = rows.find(function (r) { return texto_(r.STATUS) === ST.ANDAMENTO && texto_(r.ID_CONFERENTE) === s.ID_USUARIO; });
    if (ativa) {
      throw falha_('CONFERENTE_OCUPADO', 'Você já tem a OP ' + ativa.NUMERO_OP + ' (' + ativa.TIPO_OP + ') em andamento desde ' +
        fmtDataHora_(ativa.INICIO) + '. Finalize-a antes de abrir outra.');
    }
    // 3) A mesma OP não pode estar aberta duas vezes.
    const mesmaOp = rows.find(function (r) {
      return texto_(r.STATUS) === ST.ANDAMENTO && texto_(r.NUMERO_OP) === numeroOp && texto_(r.TIPO_OP) === tipo;
    });
    if (mesmaOp) throw falha_('OP_EM_ANDAMENTO', 'A OP ' + numeroOp + ' (' + tipo + ') já está sendo separada por ' + mesmaOp.CONFERENTE + '.');
    // 4) OP já separada antes: só abre de novo se o conferente confirmar.
    if (!confirmar) {
      const feita = rows.filter(function (r) {
        return texto_(r.STATUS) === ST.FINALIZADA && texto_(r.NUMERO_OP) === numeroOp && texto_(r.TIPO_OP) === tipo;
      }).pop();
      if (feita) {
        throw falha_('OP_JA_SEPARADA', 'A OP ' + numeroOp + ' (' + tipo + ') já foi separada em ' + fmtDataHora_(feita.FIM) +
          ' por ' + feita.CONFERENTE + '.');
      }
    }

    const agora = new Date();
    const inicio = horaDoCliente_(p.inicioCliente, agora, null);
    const reg = {
      ID_SEPARACAO: nextId_('SEP'),
      NUMERO_OP: numeroOp, TIPO_OP: tipo, QTD_KG: r2_(kg),
      OPERADORES: operadores, AJUDANTES: ajudantes,
      ID_CONFERENTE: s.ID_USUARIO, CONFERENTE: s.NOME,
      STATUS: ST.ANDAMENTO,
      INICIO: toIso_(inicio), DIA: chaveDia_(inicio), FIM: '', DURACAO_MIN: '',
      TEVE_IMPACTO: '', MOTIVOS_IMPACTO: '', FINALIZADO_POR: '', OBSERVACAO: confirmar ? 'Reabertura confirmada de OP já separada' : '',
      REGISTRADO_EM: toIso_(agora), ATUALIZADO_EM: toIso_(agora),
      ID_REQ_INICIO: idReq, ID_REQ_FIM: ''
    };
    inserir_(SHEETS.SEPARACOES, [reg]);
    log_('INICIO', reg, s.NOME, numeroOp + ' · ' + tipo + ' · ' + r2_(kg) + ' kg · ' + operadores + ' op / ' + ajudantes + ' aj');
    limparCacheAoVivo_();
    return { separacao: sepOut_(reg), repetida: false };
  });
}

function finalizarSeparacao_(p, s) {
  const idReq = exigirIdReq_(p.idRequisicao);
  const semImpacto = p.semImpacto === true || String(p.semImpacto) === 'true';
  let impactos = [];
  if (!semImpacto) {
    const vistos = {};
    impactos = (Array.isArray(p.impactos) ? p.impactos : []).map(function (i) {
      const motivo = MOTIVOS_IMPACTO.find(function (m) { return m.toLowerCase() === texto_(i && i.motivo).toLowerCase(); });
      if (!motivo) throw new Error('Motivo de impacto inválido: ' + texto_(i && i.motivo));
      if (vistos[motivo]) throw new Error('O motivo "' + motivo + '" foi informado duas vezes.');
      vistos[motivo] = true;
      const descricao = texto_(i.descricao);
      if (descricao.length < 5) throw new Error('Descreva o que aconteceu no impacto "' + motivo + '" (mínimo 5 caracteres).');
      return { motivo: motivo, descricao: descricao.slice(0, 1000) };
    });
    if (!impactos.length) throw new Error('Responda se houve impacto: escolha "Não houve impacto" ou pelo menos um motivo.');
  }

  return comTrava_(function () {
    const rows = ler_(SHEETS.SEPARACOES);
    const idSep = texto_(p.idSeparacao), idReqIni = texto_(p.idRequisicaoInicio);
    const alvo = rows.find(function (r) {
      return (idSep && texto_(r.ID_SEPARACAO) === idSep) || (!idSep && idReqIni && texto_(r.ID_REQ_INICIO) === idReqIni);
    });
    if (!alvo) throw new Error('Separação não encontrada. Ela pode ainda não ter sido sincronizada.');
    if (texto_(alvo.ID_REQ_FIM) === idReq) return { separacao: sepOut_(alvo, impactosPorSep_()), repetida: true };
    if (texto_(alvo.STATUS) !== ST.ANDAMENTO) {
      throw falha_('NAO_ESTA_EM_ANDAMENTO', 'A OP ' + alvo.NUMERO_OP + ' já está ' + (ROTULO_STATUS[texto_(alvo.STATUS)] || alvo.STATUS) + '.');
    }
    if (s.TIPO !== 'GESTOR' && texto_(alvo.ID_CONFERENTE) !== s.ID_USUARIO) {
      throw new Error('Só o conferente responsável (' + alvo.CONFERENTE + ') ou um gestor pode finalizar esta OP.');
    }

    const agora = new Date();
    const inicio = parseData_(alvo.INICIO) || agora;
    const fim = horaDoCliente_(p.fimCliente, agora, inicio);
    const duracao = r1_((fim.getTime() - inicio.getTime()) / 60000);
    // Separação com menos de 1 minuto é quase sempre abertura por engano —
    // gravada como finalizada, ela distorceria a produtividade (kg ÷ horas).
    if (duracao < DURACAO_MINIMA_MIN) {
      throw falha_('DURACAO_CURTA', 'A OP ' + alvo.NUMERO_OP + ' foi aberta há menos de ' + DURACAO_MINIMA_MIN +
        ' minuto. Se a abertura foi por engano, peça ao gestor para cancelá-la; se não, aguarde e finalize de novo.');
    }
    const mudancas = {
      STATUS: ST.FINALIZADA, FIM: toIso_(fim), DURACAO_MIN: duracao,
      TEVE_IMPACTO: impactos.length ? 'SIM' : 'NAO',
      MOTIVOS_IMPACTO: impactos.map(function (i) { return i.motivo; }).join('|'),
      FINALIZADO_POR: s.NOME, ATUALIZADO_EM: toIso_(agora), ID_REQ_FIM: idReq
    };
    atualizar_(SHEETS.SEPARACOES, alvo._linha, 'ID_SEPARACAO', alvo.ID_SEPARACAO, mudancas);
    if (impactos.length) {
      const ids = nextIds_('IMP', impactos.length);
      inserir_(SHEETS.IMPACTOS, impactos.map(function (i, n) {
        return {
          ID_IMPACTO: ids[n], ID_SEPARACAO: alvo.ID_SEPARACAO, NUMERO_OP: alvo.NUMERO_OP, TIPO_OP: alvo.TIPO_OP,
          CONFERENTE: alvo.CONFERENTE, MOTIVO: i.motivo, DESCRICAO: i.descricao, DATA_HORA: toIso_(fim)
        };
      }));
    }
    log_('FIM', alvo, s.NOME, duracao + ' min · impactos: ' + (mudancas.MOTIVOS_IMPACTO || 'nenhum'));
    limparCacheAoVivo_();
    const final = Object.assign({}, alvo, mudancas);
    const imp = {}; imp[String(alvo.ID_SEPARACAO)] = impactos.map(function (i) { return { motivo: i.motivo, descricao: i.descricao, dataHora: toIso_(fim) }; });
    return { separacao: sepOut_(final, imp), repetida: false };
  });
}

// Abertura feita por engano (OP errada, quantidade errada): o gestor
// cancela com motivo. A linha continua na planilha como registro.
function cancelarSeparacao_(p, s) {
  const motivo = texto_(p.motivo);
  if (motivo.length < 5) throw new Error('Informe o motivo do cancelamento (mínimo 5 caracteres).');
  return comTrava_(function () {
    const alvo = ler_(SHEETS.SEPARACOES).find(function (r) { return texto_(r.ID_SEPARACAO) === texto_(p.idSeparacao); });
    if (!alvo) throw new Error('Separação não encontrada.');
    if (texto_(alvo.STATUS) !== ST.ANDAMENTO) throw new Error('Só é possível cancelar uma OP em andamento.');
    const agora = toIso_(new Date());
    const mudancas = { STATUS: ST.CANCELADA, FIM: agora, FINALIZADO_POR: s.NOME, OBSERVACAO: 'Cancelada: ' + motivo, ATUALIZADO_EM: agora };
    atualizar_(SHEETS.SEPARACOES, alvo._linha, 'ID_SEPARACAO', alvo.ID_SEPARACAO, mudancas);
    log_('CANCELAMENTO', alvo, s.NOME, motivo);
    limparCacheAoVivo_();
    return { separacao: sepOut_(Object.assign({}, alvo, mudancas)) };
  });
}

// ======================= INDICADORES =======================

/**
 * Fórmulas (todas sobre OPs FINALIZADAS):
 *  horas de separação = Σ duração da OP (min) ÷ 60
 *  tempo médio por OP = Σ duração ÷ nº de OPs
 *  kg/h               = Σ kg ÷ Σ horas
 *  kg/h por operador  = Σ kg (OPs com operador) ÷ Σ (operadores × horas da OP)
 *  kg/h por ajudante  = Σ kg (OPs com ajudante) ÷ Σ (ajudantes × horas da OP)
 *  kg/h por pessoa    = Σ kg ÷ Σ ((operadores + ajudantes) × horas da OP)
 * São médias ponderadas pelo tempo — uma OP curta não pesa o mesmo que
 * uma longa, e não existe "média de médias".
 */
function agregar_(lista) {
  let ops = 0, kg = 0, min = 0, kgOp = 0, hhOp = 0, kgAj = 0, hhAj = 0, hhPes = 0, comImpacto = 0;
  lista.forEach(function (sp) {
    if (sp.duracaoMin === null) return;
    const h = sp.duracaoMin / 60;
    ops++; kg += sp.kg; min += sp.duracaoMin;
    if (sp.operadores > 0) { kgOp += sp.kg; hhOp += sp.operadores * h; }
    if (sp.ajudantes > 0) { kgAj += sp.kg; hhAj += sp.ajudantes * h; }
    hhPes += (sp.operadores + sp.ajudantes) * h;
    if (sp.teveImpacto) comImpacto++;
  });
  const horas = min / 60;
  return {
    ops: ops,
    kg: r2_(kg),
    horas: r2_(horas),
    tempoMedioMin: ops ? r1_(min / ops) : null,
    kgPorHora: horas > 0 ? r1_(kg / horas) : null,
    kgPorHoraOperador: hhOp > 0 ? r1_(kgOp / hhOp) : null,
    horasOperador: r1_(hhOp),
    kgPorHoraAjudante: hhAj > 0 ? r1_(kgAj / hhAj) : null,
    horasAjudante: r1_(hhAj),
    kgPorHoraPessoa: hhPes > 0 ? r1_(kg / hhPes) : null,
    opsComImpacto: comImpacto,
    pctComImpacto: ops ? r1_(comImpacto / ops * 100) : null
  };
}

function serie_(lista, chaveFn, rotuloFn, maxItens) {
  const grupos = {};
  lista.forEach(function (sp) {
    const d = parseData_(sp.inicio);
    if (!d) return;
    const k = chaveFn(d);
    (grupos[k] = grupos[k] || { rotulo: rotuloFn(d), itens: [] }).itens.push(sp);
  });
  return Object.keys(grupos).sort().slice(-maxItens).map(function (k) {
    return Object.assign({ chave: k, rotulo: grupos[k].rotulo }, agregar_(grupos[k].itens));
  });
}

function segundaDaSemana_(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
}

function getDashboard_(p) {
  const j = janela_(p);
  const imp = impactosPorSep_();
  const rows = ler_(SHEETS.SEPARACOES);
  const tipo = texto_(p.tipo), conf = texto_(p.conferente);
  const filtra = function (sp) { return (!tipo || sp.tipoOp === tipo) && (!conf || sp.idConferente === conf); };
  const todas = rows.map(function (r) { return sepOut_(r, imp); }).filter(filtra);
  const doPeriodo = todas.filter(function (sp) { return dentro_(sp.inicio, j); });
  const fin = doPeriodo.filter(function (sp) { return sp.status === ST.FINALIZADA && sp.duracaoMin !== null; });

  // ---- impactos ----
  let ocorrencias = 0;
  const porMotivo = {};
  fin.forEach(function (sp) {
    (sp.impactos || []).forEach(function (i) {
      ocorrencias++;
      const m = porMotivo[i.motivo] || (porMotivo[i.motivo] = { motivo: i.motivo, ocorrencias: 0, ops: {} });
      m.ocorrencias++; m.ops[sp.id] = sp;
    });
  });
  const motivos = Object.keys(porMotivo).map(function (k) {
    const m = porMotivo[k];
    const ops = Object.keys(m.ops).map(function (id) { return m.ops[id]; });
    const ag = agregar_(ops);
    return { motivo: m.motivo, ocorrencias: m.ocorrencias, pct: ocorrencias ? r1_(m.ocorrencias / ocorrencias * 100) : 0,
      opsAfetadas: ops.length, kgPorHora: ag.kgPorHora, tempoMedioMin: ag.tempoMedioMin };
  }).sort(function (a, b) { return b.ocorrencias - a.ocorrencias; });

  // ---- por conferente ----
  const porConf = {};
  fin.forEach(function (sp) { (porConf[sp.idConferente] = porConf[sp.idConferente] || { nome: sp.conferente, itens: [] }).itens.push(sp); });
  const conferentes = Object.keys(porConf).map(function (id) {
    return Object.assign({ idConferente: id, conferente: porConf[id].nome }, agregar_(porConf[id].itens));
  }).sort(function (a, b) { return b.kg - a.kg; });

  return {
    periodo: j.label,
    geradoEm: toIso_(new Date()),
    totais: agregar_(fin),
    andamentoAgora: todas.filter(function (sp) { return sp.status === ST.ANDAMENTO; }).length,
    andamentoNoPeriodo: doPeriodo.filter(function (sp) { return sp.status === ST.ANDAMENTO; }).length,
    canceladasNoPeriodo: doPeriodo.filter(function (sp) { return sp.status === ST.CANCELADA; }).length,
    impactosRegistrados: ocorrencias,
    motivos: motivos,
    comparativoImpacto: {
      semImpacto: agregar_(fin.filter(function (sp) { return !sp.teveImpacto; })),
      comImpacto: agregar_(fin.filter(function (sp) { return sp.teveImpacto; }))
    },
    porTipo: TIPOS_OP.map(function (t) {
      return Object.assign({ tipo: t }, agregar_(fin.filter(function (sp) { return sp.tipoOp === t; })));
    }),
    porConferente: conferentes,
    evolucao: {
      dia: serie_(fin, function (d) { return chaveDia_(d); },
        function (d) { return Utilities.formatDate(d, fuso_(), 'dd/MM'); }, 62),
      semana: serie_(fin, function (d) { return chaveDia_(segundaDaSemana_(d)); },
        function (d) { return 'Sem. ' + Utilities.formatDate(segundaDaSemana_(d), fuso_(), 'dd/MM'); }, 26),
      mes: serie_(fin, function (d) { return Utilities.formatDate(d, fuso_(), 'yyyy-MM'); },
        function (d) { return Utilities.formatDate(d, fuso_(), 'MM/yyyy'); }, 24)
    },
    formulas: [
      'Período: considera a data de INÍCIO da separação. Só OPs finalizadas entram nas médias.',
      'Tempo médio por OP = soma das durações ÷ nº de OPs finalizadas.',
      'Produtividade (kg/h) = kg separados ÷ horas de separação somadas.',
      'kg/h por operador = kg das OPs com operador ÷ Σ (operadores × horas da OP).',
      'kg/h por ajudante = kg das OPs com ajudante ÷ Σ (ajudantes × horas da OP).',
      'kg/h por pessoa = kg ÷ Σ ((operadores + ajudantes) × horas da OP).'
    ]
  };
}

// Visão operacional para a gestão: quem está separando o quê agora, quem
// está livre e o que já foi finalizado hoje.
function getAoVivo_() {
  const rows = ler_(SHEETS.SEPARACOES);
  const jHoje = janela_({ periodo: 'hoje' });
  const andamento = rows.filter(function (r) { return texto_(r.STATUS) === ST.ANDAMENTO; })
    .map(function (r) { return sepOut_(r); })
    .sort(function (a, b) { return Date.parse(a.inicio) - Date.parse(b.inicio); });
  const imp = impactosPorSep_();
  const finHoje = rows.filter(function (r) { return texto_(r.STATUS) === ST.FINALIZADA && dentro_(r.FIM, jHoje); })
    .map(function (r) { return sepOut_(r, imp); })
    .sort(function (a, b) { return Date.parse(b.fim) - Date.parse(a.fim); });

  const lista = conferentes_().map(function (c) { return { id: c.id, nome: c.nome }; });
  andamento.forEach(function (sp) {
    if (!lista.some(function (c) { return c.id === sp.idConferente; })) lista.push({ id: sp.idConferente, nome: sp.conferente });
  });
  const conferentes = lista.map(function (c) {
    const at = andamento.find(function (sp) { return sp.idConferente === c.id; }) || null;
    const doDia = finHoje.filter(function (sp) { return sp.idConferente === c.id; });
    return {
      id: c.id, nome: c.nome, ocupado: !!at, separacao: at,
      finalizadasHoje: doDia.length,
      kgHoje: r2_(doDia.reduce(function (t, sp) { return t + sp.kg; }, 0)),
      ultimaFim: doDia.length ? doDia[0].fim : ''
    };
  }).sort(function (a, b) { return (b.ocupado - a.ocupado) || a.nome.localeCompare(b.nome); });

  return {
    agora: toIso_(new Date()),
    andamento: andamento,
    pessoasEmCampo: andamento.reduce(function (t, sp) { return t + sp.operadores + sp.ajudantes; }, 0),
    operadoresEmCampo: andamento.reduce(function (t, sp) { return t + sp.operadores; }, 0),
    ajudantesEmCampo: andamento.reduce(function (t, sp) { return t + sp.ajudantes; }, 0),
    kgEmSeparacao: r2_(andamento.reduce(function (t, sp) { return t + sp.kg; }, 0)),
    hoje: agregar_(finHoje),
    impactosHoje: finHoje.reduce(function (t, sp) { return t + (sp.impactos || []).length; }, 0),
    finalizadasHoje: finHoje.slice(0, 40),
    totalFinalizadasHoje: finHoje.length,
    mediaMinPorTipo: mediaPorTipo_(rows),
    conferentes: conferentes
  };
}

function getHistorico_(p) {
  const j = janela_(Object.assign({ periodo: 'mes_atual' }, p));
  const status = texto_(p.status) || ST.FINALIZADA;      // 'todos' = sem filtro
  const conf = texto_(p.conferente), tipo = texto_(p.tipo);
  const op = texto_(p.numeroOp).toUpperCase().replace(/\s+/g, '');
  const impacto = texto_(p.impacto);                      // '' | 'sem' | 'com' | motivo
  const imp = impactosPorSep_();

  let lista = ler_(SHEETS.SEPARACOES)
    .filter(function (r) { return dentro_(r.INICIO, j); })
    .map(function (r) { return sepOut_(r, imp); })
    .filter(function (sp) {
      if (status !== 'todos' && sp.status !== status) return false;
      if (conf && sp.idConferente !== conf) return false;
      if (tipo && sp.tipoOp !== tipo) return false;
      if (op && sp.numeroOp.indexOf(op) === -1) return false;
      if (impacto === 'sem' && (sp.status !== ST.FINALIZADA || sp.teveImpacto)) return false;
      if (impacto === 'com' && !sp.teveImpacto) return false;
      if (impacto && impacto !== 'sem' && impacto !== 'com' && sp.motivos.indexOf(impacto) === -1) return false;
      return true;
    })
    .sort(function (a, b) { return Date.parse(b.inicio) - Date.parse(a.inicio); });

  return {
    periodo: j.label,
    total: lista.length,
    limitado: lista.length > LIMITE_HISTORICO,
    resumo: agregar_(lista.filter(function (sp) { return sp.status === ST.FINALIZADA; })),
    separacoes: lista.slice(0, LIMITE_HISTORICO)
  };
}
