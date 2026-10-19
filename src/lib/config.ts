import { useEffect, useState } from 'react';
import { call } from './api';

export interface Cfg { tipos: string[]; conferentes: string[]; motivos: string[] }
const KEY = 'cfg-listas';
const PADRAO: Cfg = { tipos: ['Ribbon', 'Fábrica', 'Líquida'], conferentes: ['Conferente 1', 'Conferente 2'],
  motivos: ['Fumigação', 'Operador', 'Ajudante', 'Endereçamento divergente'] };

function guardada(): Cfg {
  try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); if (v?.tipos && v?.conferentes && v?.motivos) return v; } catch { /* usa o padrão */ }
  return PADRAO;
}

/** Listas editáveis na planilha (aba CONFIGURACOES). Lê a cada abertura; sem internet, usa a última cópia. */
export function useConfig(ativo: boolean): Cfg {
  const [cfg, setCfg] = useState<Cfg>(guardada);
  useEffect(() => {
    if (!ativo) return;
    call<Cfg>('config').then(j => {
      const n = { tipos: j.tipos ?? [], conferentes: j.conferentes ?? [], motivos: j.motivos ?? [] };
      if (n.tipos.length && n.conferentes.length && n.motivos.length) { localStorage.setItem(KEY, JSON.stringify(n)); setCfg(n); }
    }).catch(() => { /* offline: mantém a última lista */ });
  }, [ativo]);
  return cfg;
}
