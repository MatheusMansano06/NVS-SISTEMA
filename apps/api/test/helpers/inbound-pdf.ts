/** PDF mínimo no formato do envio Full do ML (texto posicionado), para testes sem dados reais. */
export function inboundPdf(items: { sku: string; mlCode: string; ean?: string; description: string; qty: number }[], ref = '123456'): Buffer {
  const total = items.reduce((s, i) => s + i.qty, 0);
  const lines: [number, number, string][] = [
    [510, 784, `Frete #${ref}`],
    [427, 770, `Produtos do envio: ${items.length} | Total de unidades: ${total}`],
    [38, 640, 'PRODUTO'],
    [220, 640, 'UNIDADES'],
    [291, 640, 'IDENTIFIÇÃO'],
  ];
  let y = 603;
  for (const i of items) {
    lines.push([38, y, `Código ML: ${i.mlCode} Código universal: ${i.ean ?? 'N/A'} SKU:`], [220, y, String(i.qty)], [291, y, 'Etiquetagem']);
    lines.push([38, y - 9, i.sku], [38, y - 21, i.description]);
    y -= 61;
  }
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const stream = lines.map(([x, yy, t]) => `BT /F1 6 Tf ${x} ${yy} Td (${esc(t)}) Tj ET`).join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
