/**
 * O que o leitor bipou → códigos candidatos (portado de central/conferencia/etiquetas.py).
 * Etiqueta do ML traz de tudo: rastreio dos Correios, rastreio do Mercado Envios, nº do envio no código de barras,
 * JSON no QR, chave da DANFE, URL da SEFAZ. Com o teclado no layout errado o leitor troca aspas e dois-pontos e quebra
 * o JSON — por isso sequências numéricas longas sempre entram como candidatas.
 */
const NFE_KEY = /\d{44}/g;
const NUMBERS = /\d{8,}/g;
const WORDS = /[A-Za-z0-9]{8,}/g;
const SYMBOLOGY = /^\][A-Za-z]\d/; // prefixo que alguns leitores mandam (ex.: "]C1" no Code 128)

function values(data: unknown): string[] {
  if (Array.isArray(data)) return data.flatMap(values);
  if (data && typeof data === 'object') return Object.values(data).flatMap(values);
  return data === null || data === undefined || data === '' ? [] : [String(data)];
}

export function extractCodes(raw: string): string[] {
  const text = raw.trim().replace(SYMBOLOGY, '');
  const out: string[] = [text];
  try {
    out.push(...values(JSON.parse(text))); // QR do ML: {"id":"<envio>","t":"lm",...}
  } catch {
    /* não é JSON */
  }
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      for (const [, v] of url.searchParams) out.push(v, ...v.split('|')); // QR da NFC-e: p=<chave>|2|1|...
      out.push(...url.pathname.split('/'));
    } catch {
      /* URL inválida */
    }
  }
  out.push(...(text.match(NFE_KEY) ?? []), ...(text.match(NUMBERS) ?? []), ...(text.match(WORDS) ?? []));
  const seen = new Set<string>();
  return out
    .map((c) => c.trim())
    .filter((c) => {
      const k = c.toUpperCase();
      if (c.length < 6 || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

export const normalizeCode = (c: string) => String(c).replace(/\s+/g, '').toUpperCase();
