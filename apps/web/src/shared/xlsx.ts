/**
 * Leitor mínimo de .xlsx (primeira aba → CSV com ";"), sem dependências:
 * o .xlsx é um ZIP; lemos o diretório central, descompactamos com DecompressionStream
 * (nativo do navegador) e extraímos as células do XML.
 */
async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzip(buf: ArrayBuffer): Promise<Map<string, string>> {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66_000); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Arquivo .xlsx inválido');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const files = new Map<string, string>();
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!/^xl\/(sharedStrings\.xml|worksheets\/sheet1\.xml)$/.test(name)) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + size);
    files.set(name, dec.decode(method === 0 ? raw : await inflate(raw)));
  }
  return files;
}

const unescape = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const texts = (xml: string) => [...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescape(m[1] ?? '')).join('');
const colIndex = (ref: string) => [...(ref.match(/^[A-Z]+/)?.[0] ?? 'A')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

export async function xlsxToCsv(buf: ArrayBuffer): Promise<string> {
  const files = await unzip(buf);
  const sheet = files.get('xl/worksheets/sheet1.xml');
  if (!sheet) throw new Error('Planilha sem a primeira aba');
  const shared = [...(files.get('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1] ?? ''));
  const lines: string[] = [];
  for (const row of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const c of (row[1] ?? '').matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1] ?? '';
      const ref = attrs.match(/r="([A-Z]+\d+)"/)?.[1] ?? 'A1';
      const type = attrs.match(/t="(\w+)"/)?.[1];
      const body = c[2] ?? '';
      const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      const value = type === 's' ? (shared[Number(v)] ?? '') : type === 'inlineStr' ? texts(body) : unescape(v ?? '');
      cells[colIndex(ref)] = value;
    }
    const out = Array.from(cells, (v) => {
      const s = v ?? '';
      return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    });
    if (out.some(Boolean)) lines.push(out.join(';'));
  }
  return lines.join('\n');
}
