/**
 * Leitura de planilha CSV do cadastro de SKUs (Excel salva em CSV com ; e vírgula decimal).
 * Cabeçalho flexível: sku | custo_unit ou "custo unitario". Coluna de imposto, se vier, é ignorada
 * (o imposto é a alíquota única da empresa).
 */
export interface CsvSkuRow {
  line: number;
  sku: string;
  custoUnit: number | null;
  impostoPct: number | null;
  error: string | null;
}

const ALIASES: Record<string, 'sku' | 'custo' | 'imposto'> = {
  sku: 'sku',
  custo_unit: 'custo',
  'custo unitario': 'custo',
  'custo unitário': 'custo',
  custo: 'custo',
  imposto_pct: 'imposto',
  'imposto %': 'imposto',
  imposto: 'imposto',
};

/** "1.234,56" → 1234.56 ; "1234.56" → 1234.56 ; "R$ 10" → 10 */
export function parseBrNumber(raw: string): number | null {
  const s = raw.replace(/[R$\s%]/g, '').trim();
  if (!s) return null;
  const normalized = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : NaN;
}

function splitLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === sep && !quoted) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

export function parseSkuCsv(csv: string): { rows: CsvSkuRow[]; headerError: string | null } {
  const lines = csv.replace(/^\uFEFF/, '').split(/\r?\n/);
  const headerLine = lines[0] ?? '';
  const sep = headerLine.split(';').length > headerLine.split(',').length ? ';' : ',';
  const header = splitLine(headerLine, sep).map((h) => ALIASES[h.toLowerCase()] ?? null);
  const idx = { sku: header.indexOf('sku'), custo: header.indexOf('custo'), imposto: header.indexOf('imposto') };
  if (idx.sku < 0 || idx.custo < 0) {
    return { rows: [], headerError: 'Cabeçalho precisa ter as colunas "sku" e "custo_unit" (e opcionalmente "imposto_pct").' };
  }
  const rows: CsvSkuRow[] = [];
  lines.slice(1).forEach((text, i) => {
    if (!text.trim()) return;
    const cells = splitLine(text, sep);
    const sku = (cells[idx.sku] ?? '').trim();
    const custo = parseBrNumber(cells[idx.custo] ?? '');
    const imposto = idx.imposto >= 0 ? parseBrNumber(cells[idx.imposto] ?? '') : 0;
    let error: string | null = null;
    // custo vazio ou zero é aceito: o SKU fica "sem custo" no cadastro (não trava a planilha)
    if (!sku) error = 'SKU vazio';
    else if (custo !== null && Number.isNaN(custo)) error = 'custo inválido';
    else if (custo !== null && custo < 0) error = 'custo não pode ser negativo';
    else if (imposto !== null && (Number.isNaN(imposto) || imposto < 0 || imposto > 100)) error = 'imposto fora de 0 a 100';
    rows.push({ line: i + 2, sku, custoUnit: custo !== null && custo > 0 ? custo : null, impostoPct: imposto ?? 0, error });
  });
  return { rows, headerError: null };
}
