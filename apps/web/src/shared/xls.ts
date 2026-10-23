/**
 * Leitor mínimo de .xls (Excel 97–2003, BIFF8), sem dependências: primeira aba → linhas de células em texto.
 * O .xls é um arquivo composto (OLE2/CFB) com o stream "Workbook"; lemos os registros de célula
 * (texto compartilhado, número, RK, fórmula com resultado) e ignoramos formatação.
 */

const ENDOFCHAIN = -2;

function cfbStream(buf: ArrayBuffer, wanted: string[]): Uint8Array {
  const v = new DataView(buf);
  const bytes = new Uint8Array(buf);
  if (v.getUint32(0, true) !== 0xe011cfd0) throw new Error('não é .xls');
  const sec = 1 << v.getUint16(0x1e, true);
  const mini = 1 << v.getUint16(0x20, true);
  const cutoff = v.getUint32(0x38, true);
  const at = (id: number) => (id + 1) * sec;

  // FAT: setores listados no DIFAT (109 no cabeçalho + cadeia de setores DIFAT)
  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i++) {
    const id = v.getInt32(0x4c + i * 4, true);
    if (id >= 0) fatSectors.push(id);
  }
  for (let d = v.getInt32(0x44, true), n = v.getUint32(0x48, true); d >= 0 && n-- > 0; ) {
    for (let i = 0; i < sec / 4 - 1; i++) {
      const id = v.getInt32(at(d) + i * 4, true);
      if (id >= 0) fatSectors.push(id);
    }
    d = v.getInt32(at(d) + sec - 4, true);
  }
  const fat: number[] = [];
  for (const s of fatSectors) for (let i = 0; i < sec / 4; i++) fat.push(v.getInt32(at(s) + i * 4, true));

  const chain = (start: number, table: number[], size: number, read: (id: number) => Uint8Array) => {
    const parts: Uint8Array[] = [];
    for (let id = start, guard = 0; id !== ENDOFCHAIN && id >= 0 && guard < table.length + 1; id = table[id]!, guard++) parts.push(read(id));
    const out = new Uint8Array(parts.length * size);
    parts.forEach((p, i) => out.set(p, i * size));
    return out;
  };
  const big = (start: number) => chain(start, fat, sec, (id) => bytes.subarray(at(id), at(id) + sec));

  const dir = big(v.getInt32(0x30, true));
  const dv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
  let rootStart = -1;
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const type = dir[o + 0x42];
    const nameLen = dv.getUint16(o + 0x40, true);
    const name = String.fromCharCode(...new Uint16Array(dir.slice(o, o + Math.max(0, nameLen - 2)).buffer));
    const start = dv.getInt32(o + 0x74, true);
    const size = dv.getUint32(o + 0x78, true);
    if (type === 5) rootStart = start;
    if (type !== 2 || !wanted.includes(name)) continue;
    if (size >= cutoff) return big(start).subarray(0, size);
    const miniFat: number[] = [];
    const mf = big(v.getInt32(0x3c, true));
    for (let i = 0; i + 4 <= mf.length; i += 4) miniFat.push(new DataView(mf.buffer).getInt32(i, true));
    const stream = big(rootStart);
    return chain(start, miniFat, mini, (id) => stream.subarray(id * mini, id * mini + mini)).subarray(0, size);
  }
  throw new Error('planilha sem a aba de dados');
}

/** Lê bytes que podem atravessar registros CONTINUE (strings longas da tabela de textos). */
class Cursor {
  seg = 0;
  pos = 0;
  constructor(private readonly segs: Uint8Array[]) {}
  private ensure() {
    while (this.seg < this.segs.length && this.pos >= this.segs[this.seg]!.length) {
      this.seg++;
      this.pos = 0;
    }
  }
  u8() {
    this.ensure();
    return this.segs[this.seg]![this.pos++]!;
  }
  u16() {
    return this.u8() | (this.u8() << 8);
  }
  u32() {
    return (this.u16() | (this.u16() << 16)) >>> 0;
  }
  skip(n: number) {
    for (let i = 0; i < n; i++) this.u8();
  }
  /** XLUnicodeRichExtendedString: ao cruzar um CONTINUE, o novo trecho começa com o byte de flags. */
  str() {
    const cch = this.u16();
    let flags = this.u8();
    const runs = flags & 0x08 ? this.u16() : 0;
    const ext = flags & 0x04 ? this.u32() : 0;
    let s = '';
    for (let i = 0; i < cch; i++) {
      this.ensure();
      if (this.pos === 0 && this.seg > 0 && i > 0) flags = this.u8();
      s += String.fromCharCode(flags & 0x01 ? this.u16() : this.u8());
    }
    this.skip(runs * 4 + ext);
    return s;
  }
}

function inlineStr(d: Uint8Array, o: number) {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const cch = v.getUint16(o, true);
  const wide = d[o + 2]! & 0x01;
  let s = '';
  for (let i = 0; i < cch; i++) s += String.fromCharCode(wide ? v.getUint16(o + 3 + i * 2, true) : d[o + 3 + i]!);
  return s;
}

function rk(x: number) {
  let n: number;
  if (x & 0x02) n = x >> 2;
  else {
    const b = new DataView(new ArrayBuffer(8));
    b.setUint32(4, x & 0xfffffffc, true);
    n = b.getFloat64(0, true);
  }
  return x & 0x01 ? n / 100 : n;
}

/** Número como o brasileiro digita: inteiro fica "10", decimal vira "45,90". */
const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace('.', ','));

export async function xlsToRows(buf: ArrayBuffer): Promise<string[][]> {
  const wb = cfbStream(buf, ['Workbook', 'Book']);
  const v = new DataView(wb.buffer, wb.byteOffset, wb.byteLength);
  const records: { type: number; at: number; data: Uint8Array }[] = [];
  for (let o = 0; o + 4 <= wb.length; ) {
    const type = v.getUint16(o, true);
    const len = v.getUint16(o + 2, true);
    records.push({ type, at: o, data: wb.subarray(o + 4, o + 4 + len) });
    o += 4 + len;
  }

  let sheetAt = -1;
  const sst: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    if (r.type === 0x0085 && sheetAt < 0 && r.data[5] === 0) sheetAt = new DataView(r.data.buffer, r.data.byteOffset).getUint32(0, true);
    if (r.type === 0x00fc) {
      const segs = [r.data];
      for (let j = i + 1; records[j]?.type === 0x003c; j++) segs.push(records[j]!.data);
      const c = new Cursor(segs);
      c.u32();
      const unique = c.u32();
      for (let k = 0; k < unique; k++) sst.push(c.str());
    }
  }
  if (sheetAt < 0) throw new Error('planilha sem aba');

  const grid: string[][] = [];
  const put = (row: number, col: number, s: string) => {
    (grid[row] ??= [])[col] = s.trim();
  };
  let formulaCell: [number, number] | null = null;
  for (const r of records) {
    if (r.at < sheetAt) continue;
    if (r.type === 0x000a) break; // EOF da aba
    const d = new DataView(r.data.buffer, r.data.byteOffset, r.data.byteLength);
    const row = r.data.length >= 4 ? d.getUint16(0, true) : 0;
    const col = r.data.length >= 4 ? d.getUint16(2, true) : 0;
    switch (r.type) {
      case 0x00fd: put(row, col, sst[d.getUint32(6, true)] ?? ''); break; // LABELSST
      case 0x0203: put(row, col, num(d.getFloat64(6, true))); break; // NUMBER
      case 0x027e: put(row, col, num(rk(d.getUint32(6, true)))); break; // RK
      case 0x0204: put(row, col, inlineStr(r.data, 6)); break; // LABEL
      case 0x00bd: { // MULRK
        const last = d.getUint16(r.data.length - 2, true);
        for (let c = col, o = 4; c <= last; c++, o += 6) put(row, c, num(rk(d.getUint32(o + 2, true))));
        break;
      }
      case 0x0006: // FORMULA: resultado numérico ou texto no STRING seguinte
        formulaCell = null;
        if (d.getUint16(12, true) !== 0xffff) put(row, col, num(d.getFloat64(6, true)));
        else if (r.data[6] === 0) formulaCell = [row, col];
        break;
      case 0x0207:
        if (formulaCell) put(formulaCell[0], formulaCell[1], inlineStr(r.data, 0));
        formulaCell = null;
        break;
    }
  }
  return grid.filter(Boolean).map((r) => Array.from(r, (c) => c ?? '')).filter((r) => r.some((c) => c));
}
