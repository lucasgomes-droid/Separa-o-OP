/** Script vinculado à planilha (Extensões > Apps Script). Use o menu 'Separação OP' após recarregar a planilha.
 *  v2: gravação reparável (nunca deixa OP "Em andamento" com evento já gravado), painel em tempo real,
 *  encerramento manual pelo supervisor, reparo de histórico e log de erros. */
const VERSION = '2.0';
const TZ = 'America/Sao_Paulo';
const H_OP = ['ID_OP','NUMERO_OP','QUANTIDADE_KG','QTD_AJUDANTES','QTD_OPERADORES','DATA_HORA_INICIO','DATA_HORA_FIM',
  'TEMPO_EFETIVO_SEGUNDOS','TEMPO_PAUSADO_SEGUNDOS','QTD_PAUSAS','HOUVE_IMPACTO','MOTIVOS_IMPACTO','DESCRICAO_IMPACTO','STATUS','ULTIMA_ATUALIZACAO','TIPO_OP','CONFERENTE'];
const H_EV = ['ID_EVENTO','ID_OP','TIPO_EVENTO','DATA_HORA_EVENTO','TEMPO_ACUMULADO_SEGUNDOS','DATA_HORA_REGISTRO'];
const H_LOG = ['QUANDO','ACAO','ID_OP','ID_EVENTO','ERRO'];
const TYPES = ['INICIO','PAUSA','RETOMADA','FINALIZACAO'];
const DONE = ['Finalizada','Encerrada'];   // 'Encerrada' = fechada pelo supervisor (não entra nos indicadores)
// Listas editáveis na aba CONFIGURACOES (coluna A = CHAVE, coluna B = itens separados por ; ou por linha)
const CFG_DEFAULT = { TIPOS_OP: 'Ribbon;Fábrica;Líquida', CONFERENTES: 'Conferente 1;Conferente 2',
  MOTIVOS_IMPACTO: 'Fumigação;Operador;Ajudante;Endereçamento divergente', HORAS_OP_PARADA: '10' };

function setup() {
  const ss = SpreadsheetApp.getActive();
  [['ORDENS_PRODUCAO', H_OP], ['EVENTOS_OP', H_EV], ['CONFIGURACOES', ['CHAVE', 'VALOR']], ['LOG_ERROS', H_LOG]].forEach(function (p) {
    const s = ss.getSheetByName(p[0]) || ss.insertSheet(p[0]);
    if (s.getMaxColumns() < p[1].length) s.insertColumnsAfter(s.getMaxColumns(), p[1].length - s.getMaxColumns());
    s.getRange(1, 1, 1, p[1].length).setValues([p[1]]).setFontWeight('bold'); s.setFrozenRows(1);
  });
  const op = ss.getSheetByName('ORDENS_PRODUCAO'), ev = ss.getSheetByName('EVENTOS_OP');
  [1, 2, 6, 7, 15].forEach(function (c) { if (op.getMaxRows() > 1) op.getRange(2, c, op.getMaxRows() - 1).setNumberFormat('@'); }); // texto: evita conversão automática
  [1, 2, 4, 6].forEach(function (c) { if (ev.getMaxRows() > 1) ev.getRange(2, c, ev.getMaxRows() - 1).setNumberFormat('@'); });
  const cfg = ss.getSheetByName('CONFIGURACOES');
  const have = readCfg_();   // só acrescenta chaves que faltam; nunca sobrescreve o que você editou
  Object.keys(CFG_DEFAULT).forEach(function (k) { if (have[k] === undefined) cfg.appendRow([k, CFG_DEFAULT[k]]); });
  getPin_();
}

function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
const sh_ = function (n) { return SpreadsheetApp.getActive().getSheetByName(n); };
const iso_ = function (ms) { return Utilities.formatDate(new Date(ms), TZ, "yyyy-MM-dd'T'HH:mm:ssXXX"); };
const day_ = function (ms) { return Utilities.formatDate(new Date(ms), TZ, 'yyyy-MM-dd'); };
const ms_ = function (v) { return v instanceof Date ? v.getTime() : new Date(v).getTime(); };
const isoAny_ = function (v) { if (v === '' || v === null || v === undefined) return ''; const t = ms_(v); return isNaN(t) ? String(v) : iso_(t); };
function perm_(msg) { const e = new Error(msg); e.permanent = true; return e; }   // erro que não adianta tentar de novo

function doGet() { return out_({ ok: true, service: 'separacao-op', v: VERSION }); }

function doPost(e) {
  var b = {};
  try {
    b = JSON.parse(e.postData.contents);
    if (!b.pin || b.pin !== getPin_()) return out_({ ok: false, error: 'PIN inválido', permanent: true });
    // leituras NÃO usam o lock: o painel ao vivo consulta a cada poucos segundos e não pode atrasar a gravação das OPs
    if (b.action === 'ping') return out_({ ok: true, v: VERSION });
    if (b.action === 'config') return out_(config_());
    if (b.action === 'live') return out_(live_());
    if (b.action === 'list') return out_(list_(b));
    if (b.action === 'detail') return out_(detail_(b));
    if (b.action === 'sync' || b.action === 'forceClose') {
      const lock = LockService.getScriptLock();
      lock.waitLock(25000);                      // serializa gravações simultâneas
      try { return out_(b.action === 'sync' ? sync_(b) : forceClose_(b)); } finally { try { lock.releaseLock(); } catch (_) {} }
    }
    return out_({ ok: false, error: 'ação inválida', permanent: true });
  } catch (err) {
    log_(b.action || '?', b, err);
    return out_({ ok: false, error: String(err.message || err), permanent: err.permanent === true });
  }
}

function log_(acao, b, err) {   // registra falhas na aba LOG_ERROS para você enxergar o que não subiu
  try {
    const ss = SpreadsheetApp.getActive(); const s = ss.getSheetByName('LOG_ERROS') || ss.insertSheet('LOG_ERROS');
    if (s.getLastRow() === 0) s.appendRow(H_LOG);
    s.appendRow([iso_(Date.now()), acao, String((b.op && b.op.id) || b.id || ''), String((b.event && b.event.id) || ''), String((err && err.message) || err)]);
    if (s.getLastRow() > 3000) s.deleteRows(2, 1000);
  } catch (_) {}
}

function calc_(events, now) {   // mesma regra do frontend (src/lib/timer.ts); eventos em ordem cronológica
  var work = 0, paused = 0, pauses = 0, run = null, pause = null, fin = false;
  events.forEach(function (e) {
    if (e.type === 'INICIO' || e.type === 'RETOMADA') { if (pause !== null) { paused += e.at - pause; pause = null; } run = e.at; }
    else { if (run !== null) { work += e.at - run; run = null; }
      if (e.type === 'PAUSA') { pause = e.at; pauses++; } else { fin = true; if (pause !== null) { paused += e.at - pause; pause = null; } } }
  });
  if (!fin) { if (run !== null) work += Math.max(0, now - run); if (pause !== null) paused += Math.max(0, now - pause); }
  return { efetivo: Math.floor(work / 1000), pausado: Math.floor(paused / 1000), pausas: pauses };
}

function findRow_(s, id) {
  const n = s.getLastRow(); if (n < 2) return -1;
  const v = s.getRange(2, 1, n - 1, 1).getValues();
  for (var i = 0; i < v.length; i++) if (String(v[i][0]) === String(id)) return i + 2;
  return -1;
}
function opEvents_(se, opId, rows) {   // lê só o trecho da planilha onde estão os eventos desta OP
  if (!rows.length) return [];
  const a = rows[0], z = rows[rows.length - 1];
  return se.getRange(a, 1, z - a + 1, 6).getValues().filter(function (r) { return String(r[1]) === String(opId); })
    .map(function (r) { return { id: String(r[0]), type: r[2], at: ms_(r[3]) }; });
}
function statusOf_(last) { return last.type === 'PAUSA' ? 'Pausada' : last.type === 'FINALIZACAO' ? 'Finalizada' : 'Em andamento'; }
function invalidateLive_() { try { CacheService.getScriptCache().remove('live'); } catch (_) {} }

/** Ordem de gravação pensada para ser reparável: 1) cria a OP, 2) grava o evento, 3) recalcula a linha da OP a partir
 *  de TODOS os eventos. Se a execução cair entre 2 e 3, o app reenvia o mesmo evento e o passo 3 é refeito (antes, o
 *  servidor respondia "duplicado" e a OP ficava "Em andamento" para sempre, sem histórico). */
function sync_(b) {
  const op = b.op, ev = b.event;
  if (!op || !ev || !ev.id || !op.id || !isFinite(ev.at)) throw perm_('payload inválido');
  if (TYPES.indexOf(ev.type) < 0) throw perm_('tipo de evento inválido');
  const so = sh_('ORDENS_PRODUCAO'), se = sh_('EVENTOS_OP'), nowMs = Date.now();

  const lastE = se.getLastRow();
  const keys = lastE > 1 ? se.getRange(2, 1, lastE - 1, 2).getValues() : [];
  var dupe = false; const mine = [];
  keys.forEach(function (r, i) { if (String(r[0]) === ev.id) dupe = true; if (String(r[1]) === op.id) mine.push(i + 2); });

  var row = findRow_(so, op.id);
  if (row < 0) {
    if (ev.type !== 'INICIO') throw new Error('OP inexistente (o início ainda não chegou)');   // temporário: tenta de novo
    if (!/^\d+$/.test(String(op.numero)) || !(op.kg > 0) || !(op.ajudantes >= 0) || !(op.operadores >= 0) || op.ajudantes + op.operadores < 1 ||
        !String(op.tipo || '').trim() || !String(op.conferente || '').trim()) throw perm_('dados da OP inválidos (tipo e conferente são obrigatórios)');
    so.appendRow([op.id, String(op.numero), op.kg, op.ajudantes, op.operadores, iso_(ev.at), '', 0, 0, 0, '', '', '', 'Em andamento', iso_(nowMs),
      String(op.tipo).slice(0, 80), String(op.conferente).slice(0, 80)]);
    row = so.getLastRow();
  } else if (DONE.indexOf(String(so.getRange(row, 14).getValue())) >= 0) {
    // OP já encerrada: confirma (ok) para não travar a fila do celular com duplo toque ou evento atrasado
    if (!dupe) log_('sync-ignorado', b, new Error('evento ' + ev.type + ' recebido depois da OP encerrada'));
    return { ok: true, duplicate: dupe, ignored: !dupe, v: VERSION };
  }

  var f = {};
  if (ev.type === 'FINALIZACAO') {
    f = b.final || {};
    if (f.impacto && (!(f.motivos || []).length || !String(f.descricao || '').trim())) throw perm_('motivo e descrição do impacto são obrigatórios');
  }
  const evs = opEvents_(se, op.id, mine);
  if (!dupe) {
    evs.push({ id: ev.id, type: ev.type, at: ev.at });
    evs.sort(function (a, c) { return a.at - c.at; });
    se.appendRow([ev.id, op.id, ev.type, iso_(ev.at), calc_(evs.filter(function (e) { return e.at <= ev.at; }), ev.at).efetivo, iso_(nowMs)]);
  } else evs.sort(function (a, c) { return a.at - c.at; });

  const last = evs[evs.length - 1], c = calc_(evs, last.at), status = statusOf_(last);
  var fim = '', imp = '', mot = '', desc = '';
  if (status === 'Finalizada') {
    fim = iso_(last.at);
    if (ev.type === 'FINALIZACAO') { imp = f.impacto ? 'SIM' : 'NÃO'; mot = (f.motivos || []).join('; '); desc = f.descricao || ''; }
  }
  so.getRange(row, 7, 1, 9).setValues([[fim, c.efetivo, c.pausado, c.pausas, imp, mot, desc, status, iso_(nowMs)]]);
  SpreadsheetApp.flush(); invalidateLive_();
  return { ok: true, duplicate: dupe, status: status, v: VERSION };
}

/** Supervisor encerra uma OP que ficou aberta (ex.: o conferente fechou o app sem sincronizar). */
function forceClose_(b) {
  const so = sh_('ORDENS_PRODUCAO'), se = sh_('EVENTOS_OP');
  const row = findRow_(so, b.id); if (row < 0) throw perm_('OP não encontrada');
  if (DONE.indexOf(String(so.getRange(row, 14).getValue())) >= 0) return { ok: true, duplicate: true };
  const lastE = se.getLastRow();
  const keys = lastE > 1 ? se.getRange(2, 1, lastE - 1, 2).getValues() : [], mine = [];
  keys.forEach(function (r, i) { if (String(r[1]) === String(b.id)) mine.push(i + 2); });
  const evs = opEvents_(se, b.id, mine).sort(function (a, c) { return a.at - c.at; });
  if (!evs.length) throw perm_('OP sem eventos');
  const nowMs = Date.now(), lastAt = evs[evs.length - 1].at;
  const fimMs = Math.min(nowMs, Math.max(lastAt, isFinite(b.fim) ? Number(b.fim) : lastAt));
  const ev = { id: 'manual-' + Utilities.getUuid(), type: 'FINALIZACAO', at: fimMs };
  evs.push(ev);
  const c = calc_(evs, fimMs);
  se.appendRow([ev.id, b.id, ev.type, iso_(ev.at), c.efetivo, iso_(nowMs)]);
  so.getRange(row, 7, 1, 9).setValues([[iso_(fimMs), c.efetivo, c.pausado, c.pausas, 'NÃO', '', 'Encerrada manualmente pelo painel (o conferente não finalizou)', 'Encerrada', iso_(nowMs)]]);
  log_('encerrar-manual', b, new Error('OP encerrada pelo painel em ' + iso_(fimMs)));
  SpreadsheetApp.flush(); invalidateLive_();
  return { ok: true };
}

function opObj_(r) {
  return { id: String(r[0]), numero: String(r[1]), kg: Number(r[2]), ajudantes: Number(r[3]), operadores: Number(r[4]), inicio: isoAny_(r[5]), fim: isoAny_(r[6]),
    efetivo: r[7], pausado: r[8], pausas: r[9], impacto: r[10], motivos: r[11], descricao: r[12], status: r[13], ultima: isoAny_(r[14]), tipo: r[15] || '', conferente: r[16] || '' };
}
function list_(b) {   // filtros: from/to (ms), numero, status
  const s = sh_('ORDENS_PRODUCAO'); if (s.getLastRow() < 2) return { ok: true, items: [] };
  var items = s.getRange(2, 1, s.getLastRow() - 1, 17).getValues().filter(function (r) { return r[0] !== ''; }).map(opObj_).filter(function (o) {
    const t = ms_(o.inicio);
    return (!b.from || t >= b.from) && (!b.to || t <= b.to) && (!b.numero || o.numero.indexOf(String(b.numero)) >= 0) && (!b.status || o.status === b.status);
  });
  items.sort(function (a, c) { return ms_(c.inicio) - ms_(a.inicio); });
  return { ok: true, items: items.slice(0, 1000) };
}
function detail_(b) {
  const l = list_({}).items.filter(function (o) { return o.id === b.id; })[0]; if (!l) throw new Error('OP não encontrada');
  const se = sh_('EVENTOS_OP'); if (se.getLastRow() < 2) return { ok: true, op: l, eventos: [] };
  const evs = se.getRange(2, 1, se.getLastRow() - 1, 6).getValues().filter(function (r) { return String(r[1]) === b.id; })
    .map(function (r) { return { id: r[0], tipo: r[2], quando: isoAny_(r[3]), acumulado: r[4] }; });
  return { ok: true, op: l, eventos: evs };
}

/** Painel em tempo real: OPs abertas agora + totais de hoje. Resposta guardada 8 s em cache para aguentar vários painéis abertos. */
function live_() {
  const cache = CacheService.getScriptCache(); var data = null;
  try { const hit = cache.get('live'); if (hit) data = JSON.parse(hit); } catch (_) {}
  if (!data) { data = buildLive_(); try { cache.put('live', JSON.stringify(data), 8); } catch (_) {} }
  data.serverNow = Date.now();
  return data;
}
function buildLive_() {
  const now = Date.now(), m = readCfg_(), limite = (Number(m.HORAS_OP_PARADA) || 10) * 3600000, today = day_(now);
  const so = sh_('ORDENS_PRODUCAO'), se = sh_('EVENTOS_OP');
  const rows = so.getLastRow() > 1 ? so.getRange(2, 1, so.getLastRow() - 1, 17).getValues() : [];
  const ativas = [], hoje = { finalizadas: 0, kg: 0, porTipo: {} }, ids = {};
  rows.forEach(function (r) {
    if (r[0] === '') return; const o = opObj_(r);
    if (o.status === 'Em andamento' || o.status === 'Pausada') { ativas.push(o); ids[o.id] = []; }
    else if (o.status === 'Finalizada' && o.fim && day_(ms_(o.fim)) === today) {
      hoje.finalizadas++; hoje.kg += o.kg; const t = o.tipo || 'Sem tipo';
      const x = hoje.porTipo[t] || { ops: 0, kg: 0 }; x.ops++; x.kg += o.kg; hoje.porTipo[t] = x;
    }
  });
  if (ativas.length && se.getLastRow() > 1)
    se.getRange(2, 1, se.getLastRow() - 1, 6).getValues().forEach(function (r) { const k = String(r[1]); if (ids[k]) ids[k].push({ type: r[2], at: ms_(r[3]) }); });
  const out = ativas.map(function (o) {
    const evs = ids[o.id].sort(function (a, c) { return a.at - c.at; }), c = calc_(evs, now);
    const t = evs.length ? evs[evs.length - 1].at : ms_(o.ultima);   // "parada" = sem nenhum evento (início/pausa/retomada) há muito tempo
    return { id: o.id, numero: o.numero, tipo: o.tipo || 'Sem tipo', conferente: o.conferente, kg: o.kg, ajudantes: o.ajudantes, operadores: o.operadores,
      status: o.status, inicio: o.inicio, efetivo: c.efetivo, pausado: c.pausado, rodando: o.status === 'Em andamento', ultima: isFinite(t) ? iso_(t) : o.ultima,
      parada: isFinite(t) && now - t > limite };
  });
  out.sort(function (a, c) { return ms_(a.inicio) - ms_(c.inicio); });
  hoje.kg = Math.round(hoje.kg * 10) / 10;
  return { ok: true, geradoEm: now, ativas: out, hoje: hoje, tipos: listCfg_(m, 'TIPOS_OP'), limiteHoras: limite / 3600000 };
}

/** Conserta OPs que têm o evento FINALIZACAO gravado mas a linha da OP ficou "Em andamento" (falha antiga do script). */
function repairAll_() {
  const so = sh_('ORDENS_PRODUCAO'), se = sh_('EVENTOS_OP'), m = readCfg_(), limite = (Number(m.HORAS_OP_PARADA) || 10) * 3600000, now = Date.now();
  if (so.getLastRow() < 2) return { fixed: 0, stale: 0 };
  const rows = so.getRange(2, 1, so.getLastRow() - 1, 17).getValues(), byOp = {};
  if (se.getLastRow() > 1) se.getRange(2, 1, se.getLastRow() - 1, 6).getValues().forEach(function (r) {
    const k = String(r[1]); (byOp[k] = byOp[k] || []).push({ type: r[2], at: ms_(r[3]) }); });
  var fixed = 0, stale = 0;
  rows.forEach(function (r, i) {
    if (r[0] === '' || DONE.indexOf(String(r[13])) >= 0) return;
    const evs = (byOp[String(r[0])] || []).sort(function (a, c) { return a.at - c.at; });
    if (!evs.length) return;
    const last = evs[evs.length - 1];
    if (last.type === 'FINALIZACAO') {
      const c = calc_(evs, last.at);
      so.getRange(i + 2, 7, 1, 9).setValues([[iso_(last.at), c.efetivo, c.pausado, c.pausas, '', '', 'Reconstituída a partir dos eventos (impacto não registrado)', 'Finalizada', iso_(now)]]);
      fixed++;
    } else if (now - last.at > limite) stale++;
  });
  SpreadsheetApp.flush(); invalidateLive_();
  return { fixed: fixed, stale: stale };
}
function repair() {
  const lock = LockService.getScriptLock(); lock.waitLock(25000);
  try {
    const r = repairAll_();
    SpreadsheetApp.getUi().alert('Reparo concluído', 'OPs corrigidas: ' + r.fixed + '\nOPs abertas há muito tempo (encerre pelo painel Tempo real): ' + r.stale, SpreadsheetApp.getUi().ButtonSet.OK);
  } finally { lock.releaseLock(); }
}

function getPin_() {   // PIN gerado automaticamente e guardado só nas propriedades do script
  const p = PropertiesService.getScriptProperties(); var v = p.getProperty('APP_PIN');
  if (!v) { v = Utilities.getUuid().replace(/-/g, '').slice(0, 12); p.setProperty('APP_PIN', v); }
  return v;
}
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Separação OP').addItem('1. Preparar planilha', 'setup').addItem('2. Mostrar PIN de acesso', 'showPin')
    .addItem('3. Reparar OPs sem histórico', 'repair').addToUi();
}
function showPin() {
  SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput('<p>PIN de acesso (cole no aplicativo):</p><input style="width:100%;font-size:18px" value="' + getPin_() + '" onclick="this.select()">').setHeight(110), 'PIN');
}

function readCfg_() {
  const s = sh_('CONFIGURACOES'), m = {};
  if (s && s.getLastRow() > 1) s.getRange(2, 1, s.getLastRow() - 1, 2).getValues().forEach(function (r) { if (r[0]) m[String(r[0]).trim()] = String(r[1]); });
  return m;
}
function listCfg_(m, k) { return (m[k] !== undefined ? m[k] : CFG_DEFAULT[k]).split(/[;\n]/).map(function (x) { return x.trim(); }).filter(Boolean); }
function config_() { const m = readCfg_(); return { ok: true, tipos: listCfg_(m, 'TIPOS_OP'), conferentes: listCfg_(m, 'CONFERENTES'), motivos: listCfg_(m, 'MOTIVOS_IMPACTO') }; }
