export class ApiError extends Error {}
export const DEFAULT_URL = 'https://script.google.com/macros/s/AKfycby6h8zEVdJsVBcnAkMtFPl6WNw7NYehTAl-IgArEUJ_X7FHFh2kII54JKLH0nzzYpgfEg/exec'; // URL pública da implantação (não é segredo; o PIN é)
const KEY = 'conexao';
type Conn = { url: string; pin: string };

export function getConn(): Conn | null {
  try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); return v?.url && v?.pin ? v : null; } catch { return null; }
}
export function saveConn(url: string, pin: string) {
  url = url.trim(); pin = pin.trim();
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url)) throw new ApiError('A URL deve terminar em /exec (copie na tela de implantação).');
  if (!pin) throw new ApiError('Informe o PIN.');
  localStorage.setItem(KEY, JSON.stringify({ url, pin }));
}
export const clearConn = () => localStorage.removeItem(KEY);

/** POST text/plain evita preflight de CORS. A fila offline trata TypeError (rede) como "pendente". */
export async function call<T = any>(action: string, payload: object = {}): Promise<T> {
  const c = getConn();
  if (!c) throw new ApiError('Aplicativo não configurado.');
  const res = await fetch(c.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action, pin: c.pin, ...payload }) });
  let j: any;
  try { j = await res.json(); } catch { throw new TypeError('resposta inválida'); }
  if (!j.ok) throw new ApiError(j.error || 'Erro na API');
  return j;
}
