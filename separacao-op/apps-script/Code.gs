/** Script vinculado à planilha (Extensões > Apps Script). Use o menu 'Separação OP' após recarregar a planilha. */
const TZ = 'America/Sao_Paulo';
const H_OP = ['ID_OP','NUMERO_OP','QUANTIDADE_KG','QTD_AJUDANTES','QTD_OPERADORES','DATA_HORA_INICIO','DATA_HORA_FIM',
  'TEMPO_EFETIVO_SEGUNDOS','TEMPO_PAUSADO_SEGUNDOS','QTD_PAUSAS','HOUVE_IMPACTO','MOTIVOS_IMPACTO','DESCRICAO_IMPACTO','STATUS','ULTIMA_ATUALIZACAO','TIPO_OP','CONFERENTE'];
const H_EV = ['ID_EVENTO','ID_OP','TIPO_EVENTO','DATA_HORA_EVENTO','TEMPO_ACUMULADO_SEGUNDOS','DATA_HORA_REGISTRO'];
const TYPES = ['INICIO','PAUSA','RETOMADA','FINALIZACAO'];

function setup() {
  const ss = SpreadsheetApp.getActive();
  [['ORDENS_PRODUCAO', H_OP], ['EVENTOS_OP', H_EV], ['CONFIGURACOES', ['CHAVE', 'VALOR']]].forEach(function (p) {
    const s = ss.getSheetByName(p[0]) || ss.insertSheet(p[0]);
    if (s.getMaxColumns() < p[1].length) s.insertColumnsAfter(s.getMaxColumns(), p[1].length - s.getMaxColumns());
    s.getRange(1, 1, 1, p[1].length).setValues([p[1]]).setFontWeight('bold'); s.setFrozenRows(1);
  });
  const op = ss.getSheetByName('ORDENS_PRODUCAO'), ev = ss.getSheetByName('EVENTOS_OP');
  [2, 6, 7, 15].forEach(function (c) { op.getRange(2, c, op.getMaxRows() - 1).setNumberFormat('@'); }); // texto: evita conversão automática
  [1, 2, 4, 6].forEach(function (c) { ev.getRange(2, c, ev.getMaxRows() - 1).setNumberFormat('@'); });
  const cfg = ss.getSheetByName('CONFIGURACOES');
  const have = readCfg_();   // só acrescenta chaves que faltam; nunca sobrescreve o que você editou
  Object.keys(CFG_DEFAULT).forEach(function (k) { if (have[k] === undefined) cfg.appendRow([k, CFG_DEFAULT[k]]); });
  getPin_();
}

function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
const sh_ = function (n) { return SpreadsheetApp.getActive().getSheetByName(n); };
const iso_ = function (ms) { return Utilities.formatDate(new Date(ms), TZ, "yyyy-MM-dd'T'HH:mm:ssXXX"); };
const ms_ = function (v) { return v instanceof Date ? v.getTime() : new Date(v).getTime(); };

function doGet() { return out_({ ok: true, service: 'separacao-op' }); }

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    const b = JSON.parse(e.postData.contents);
    if (!b.pin || b.pin !== getPin_()) return out_({ ok: false, error: 'PIN inválido' });
    if (b.action === 'ping') return out_({ ok: true });
    if (b.action === 'config') return out_(config_());
    lock.waitLock(25000);                        // serializa requisições simultâneas
    if (b.action === 'sync') return out_(sync_(b));
    if (b.action === 'list') return out_(list_(b));
    if (b.action === 'detail') return out_(detail_(b));
    return out_({ ok: false, error: 'ação inválida' });
  } catch (err) { return out_({ ok: false, error: String(err.message || err) }); }
  finally { try { lock.releaseLock(); } catch (_) {} }
}

function calc_(events, now) {   // mesma regra do frontend (src/lib/timer.ts)
  var work = 0, paused = 0, pauses = 0, run = null, pause = null, fin = false;
  events.forEach(function (e) {
    if (e.type === 'INICIO' || e.type === 'RETOMADA') { if (pause !== null) { paused += e.at - pause; pause = null; } run = e.at; }
    else { if (run !== null) { work += e.at - run; run = null; }
      if (e.type === 'PAUSA') { pause = e.at; pauses++; } else { fin = true; if (pause !== null) { paused += e.at - pause; pause = null; } } }
  });
  if (!fin) { if (run !== null) work += Math.max(0, now - run); if (pause !== null) paused += Math.max(0, now - pause); }
  return { efetivo: Math.floor(work / 1000), pausado: Math.floor(paused / 1000), pausas: pauses };
}

function sync_(b) {
  const op = b.op, ev = b.event;
  if (!op || !ev || !ev.id || !op.id || !isFinite(ev.at)) throw new Error('payload inválido');
  if (TYPES.indexOf(ev.type) < 0) throw new Error('tipo de evento inválido');
  const so = sh_('ORDENS_PRODUCAO'), se = sh_('EVENTOS_OP');
  const evRows = se.getLastRow() > 1 ? se.getRange(2, 1, se.getLastRow() - 1, 6).getValues() : [];
  if (evRows.some(function (r) { return r[0] === ev.id; })) return { ok: true, duplicate: true };   // idempotência

  const ids = so.getLastRow() > 1 ? so.getRange(2, 1, so.getLastRow() - 1, 1).getValues().map(function (r) { return r[0]; }) : [];
  var row = ids.indexOf(op.id); row = row < 0 ? -1 : row + 2;
  if (row < 0) {
    if (ev.type !== 'INICIO') throw new Error('OP inexistente');
    if (!/^\d+$/.test(String(op.numero)) || !(op.kg > 0) || !(op.ajudantes >= 0) || !(op.operadores >= 0) || op.ajudantes + op.operadores < 1 || !String(op.tipo || '').trim() || !String(op.conferente || '').trim()) throw new Error('dados da OP inválidos (tipo e conferente são obrigatórios)');
  } else if (so.getRange(row, 14).getValue() === 'Finalizada') throw new Error('OP já finalizada');

  var fim = '', imp = '', mot = '', desc = '';
  if (ev.type === 'FINALIZACAO') {
    const f = b.final || {};
    if (f.impacto && (!(f.motivos || []).length || !String(f.descricao || '').trim())) throw new Error('motivo e descrição do impacto são obrigatórios');
    fim = iso_(ev.at); imp = f.impacto ? 'SIM' : 'NÃO'; mot = (f.motivos || []).join('; '); desc = f.descricao || '';
  }
  const now = Date.now();
  if (row < 0) { so.appendRow([op.id, String(op.numero), op.kg, op.ajudantes, op.operadores, iso_(ev.at), '', 0, 0, 0, '', '', '', 'Em andamento', iso_(now), String(op.tipo).slice(0, 80), String(op.conferente).slice(0, 80)]); row = so.getLastRow(); }
  const evs = evRows.filter(function (r) { return r[1] === op.id; }).map(function (r) { return { type: r[2], at: ms_(r[3]) }; });
  evs.push({ type: ev.type, at: ev.at });
  const c = calc_(evs, ev.at);
  se.appendRow([ev.id, op.id, ev.type, iso_(ev.at), c.efetivo, iso_(now)]);
  const status = ev.type === 'PAUSA' ? 'Pausada' : ev.type === 'FINALIZACAO' ? 'Finalizada' : 'Em andamento';
  so.getRange(row, 7, 1, 9).setValues([[fim, c.efetivo, c.pausado, c.pausas, imp, mot, desc, status, iso_(now)]]);
  return { ok: true };
}

function opObj_(r) {
  return { id: r[0], numero: String(r[1]), kg: r[2], ajudantes: r[3], operadores: r[4], inicio: r[5], fim: r[6],
    efetivo: r[7], pausado: r[8], pausas: r[9], impacto: r[10], motivos: r[11], descricao: r[12], status: r[13], tipo: r[15] || '', conferente: r[16] || '' };
}
function list_(b) {   // filtros: from/to (ms), numero, status
  const s = sh_('ORDENS_PRODUCAO'); if (s.getLastRow() < 2) return { ok: true, items: [] };
  var items = s.getRange(2, 1, s.getLastRow() - 1, 17).getValues().map(opObj_).filter(function (o) {
    const t = ms_(o.inicio);
    return (!b.from || t >= b.from) && (!b.to || t <= b.to) && (!b.numero || o.numero.indexOf(String(b.numero)) >= 0) && (!b.status || o.status === b.status);
  });
  items.sort(function (a, c) { return ms_(c.inicio) - ms_(a.inicio); });
  return { ok: true, items: items.slice(0, 1000) };
}
function detail_(b) {
  const l = list_({}).items.filter(function (o) { return o.id === b.id; })[0]; if (!l) throw new Error('OP não encontrada');
  const se = sh_('EVENTOS_OP');
  const evs = se.getRange(2, 1, Math.max(1, se.getLastRow() - 1), 6).getValues().filter(function (r) { return r[1] === b.id; })
    .map(function (r) { return { id: r[0], tipo: r[2], quando: r[3], acumulado: r[4] }; });
  return { ok: true, op: l, eventos: evs };
}

function getPin_() {   // PIN gerado automaticamente e guardado só nas propriedades do script
  const p = PropertiesService.getScriptProperties(); var v = p.getProperty('APP_PIN');
  if (!v) { v = Utilities.getUuid().replace(/-/g, '').slice(0, 12); p.setProperty('APP_PIN', v); }
  return v;
}
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Separação OP').addItem('1. Preparar planilha', 'setup').addItem('2. Mostrar PIN de acesso', 'showPin').addToUi();
}
function showPin() {
  SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput('<p>PIN de acesso (cole no aplicativo):</p><input style="width:100%;font-size:18px" value="' + getPin_() + '" onclick="this.select()">').setHeight(110), 'PIN');
}

// Listas editáveis na aba CONFIGURACOES (coluna A = CHAVE, coluna B = itens separados por ; ou por linha)
const CFG_DEFAULT = { TIPOS_OP: 'Ribbon;Fábrica;Líquida', CONFERENTES: 'Conferente 1;Conferente 2', MOTIVOS_IMPACTO: 'Fumigação;Operador;Ajudante;Endereçamento divergente' };
function readCfg_() {
  const s = sh_('CONFIGURACOES'), m = {};
  if (s && s.getLastRow() > 1) s.getRange(2, 1, s.getLastRow() - 1, 2).getValues().forEach(function (r) { if (r[0]) m[String(r[0]).trim()] = String(r[1]); });
  return m;
}
function listCfg_(m, k) { return (m[k] !== undefined ? m[k] : CFG_DEFAULT[k]).split(/[;\n]/).map(function (x) { return x.trim(); }).filter(Boolean); }
function config_() { const m = readCfg_(); return { ok: true, tipos: listCfg_(m, 'TIPOS_OP'), conferentes: listCfg_(m, 'CONFERENTES'), motivos: listCfg_(m, 'MOTIVOS_IMPACTO') }; }
