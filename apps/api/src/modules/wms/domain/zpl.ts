/**
 * Etiquetas do Full (ZPL para Zebra), idênticas às do NVS-WMS (Picking.jsx + golden test):
 * 2 etiquetas lado a lado por bloco; quantidade ímpar fecha com um bloco simples; ajuste de −15 dots na esquerda.
 * ML: código de barras Code128 com o Código ML. Shopee: QR com o código.
 */
const clean = (s: string | null | undefined, max: number) => (s ?? '').replace(/\^/g, ' ').replace(/~/g, ' ').slice(0, max);

function mlPair(mlCode: string, description: string, sku: string): string {
  const d = clean(description, 120);
  return (
    '^XA^CI28\n^LH0,0\n' +
    `^FO30,15^BY2,,0^BCN,54,N,N^FD${mlCode}^FS\n` +
    `^FO105,75^A0N,20,25^FH^FD${mlCode}^FS\n` +
    `^FO105,76^A0N,20,25^FH^FD${mlCode}^FS\n` +
    `^FO16,115^A0N,18,18^FB300,2,2,L^FH^FD${d}^FS\n` +
    '^FO16,153^A0N,18,18^FB300,1,0,L^FH^FD^FS\n' +
    '^FO15,153^A0N,18,18^FB300,1,0,L^FH^FD^FS\n' +
    `^FO16,172^A0N,18,18^FH^FDSKU: ${sku}^FS\n` +
    '^CI28\n^LH0,0\n' +
    `^FO350,15^BY2,,0^BCN,54,N,N^FD${mlCode}^FS\n` +
    `^FO425,75^A0N,20,25^FH^FD${mlCode}^FS\n` +
    `^FO425,76^A0N,20,25^FH^FD${mlCode}^FS\n` +
    `^FO346,115^A0N,18,18^FB300,2,2,L^FH^FD${d}^FS\n` +
    '^FO346,153^A0N,18,18^FB300,1,0,L^FH^FD^FS\n' +
    '^FO345,153^A0N,18,18^FB300,1,0,L^FH^FD^FS\n' +
    `^FO346,172^A0N,18,18^FH^FDSKU: ${sku}^FS\n^XZ`
  );
}

function mlSingle(mlCode: string, description: string, sku: string): string {
  const d = clean(description, 120);
  return (
    '^XA^CI28\n^LH0,0\n' +
    `^FO30,15^BY2,,0^BCN,54,N,N^FD${mlCode}^FS\n` +
    `^FO105,75^A0N,20,25^FH^FD${mlCode}^FS\n` +
    `^FO105,76^A0N,20,25^FH^FD${mlCode}^FS\n` +
    `^FO16,115^A0N,18,18^FB300,2,2,L^FH^FD${d}^FS\n` +
    `^FO16,172^A0N,18,18^FH^FDSKU: ${sku}^FS\n^XZ`
  );
}

function shopeeName(description: string) {
  let n = clean(description, 1000);
  if (n.length > 40) {
    const sub = n.slice(0, 40);
    const sp = sub.lastIndexOf(' ');
    n = sp > 0 ? sub.slice(0, sp) : sub;
  }
  return n;
}

function shopeeHalf(x: number, code: string, name: string, sku: string) {
  return (
    `^FO${x + 10},5^A0N,18,18^FD${name}^FS\n` +
    `^FO${x + 90},27^BQN,2,3^FDQA,${code}^FS\n` +
    `^FO${x + 10},135^A0N,18,18^FDseller sku: ${sku}^FS\n` +
    `^FO${x + 10},155^A0N,18,18^FDbarcode: ${code}^FS\n` +
    `^FO${x + 10},175^A0N,18,18^FDwhs skuid: ${code}^FS\n`
  );
}

/** ZPL das `qty` etiquetas de um item. */
export function buildLabelsZpl(p: { marketplace: 'ml' | 'shopee'; code: string; description: string; sku: string; qty: number }): string {
  const code = clean(p.code, 60);
  const sku = clean(p.sku, 60);
  const pairs = Math.floor(p.qty / 2);
  const odd = p.qty % 2 === 1;
  const blocks: string[] = [];
  if (p.marketplace === 'shopee') {
    const name = shopeeName(p.description);
    for (let i = 0; i < pairs; i++) blocks.push(`^XA^CI28\n^LH0,0\n${shopeeHalf(0, code, name, sku)}^CI28\n^LH0,0\n${shopeeHalf(340, code, name, sku)}^XZ`);
    if (odd) blocks.push(`^XA^CI28\n^LH0,0\n${shopeeHalf(0, code, name, sku)}^XZ`, '^XA^XZ');
  } else {
    for (let i = 0; i < pairs; i++) blocks.push(mlPair(code, p.description, sku));
    if (odd) blocks.push(mlSingle(code, p.description, sku));
  }
  // ajuste fino de −15 dots (≈1,8 mm) à esquerda em todas as posições
  return blocks.join('\n').replace(/\^FO(\d+),/g, (_m, x: string) => `^FO${Math.max(0, Number(x) - 15)},`);
}
