import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { buildApp } from '../src/app.js';
import { inboundPdf } from './helpers/inbound-pdf.js';

try {
  process.loadEnvFile(resolve(import.meta.dirname, '../../../.env'));
} catch {
  /* CI */
}
const TEST_DB = process.env.TEST_DATABASE_URL;

function randomCnpj(): string {
  const b = Array.from({ length: 12 }, () => randomInt(0, 10));
  const dv = (n: number[]) => {
    const w = n.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const r = n.reduce((a, x, i) => a + x * w[i]!, 0) % 11;
    return r < 2 ? 0 : 11 - r;
  };
  b.push(dv(b));
  b.push(dv(b));
  const c = b.join('');
  return /^(\d)\1+$/.test(c) ? randomCnpj() : c;
}
const cookieOf = (res: { cookies: { name: string; value: string }[] }, name: string) => res.cookies.find((c) => c.name === name)!.value;
type Cookies = Record<string, string>;

describe.skipIf(!TEST_DB)('Supervisão Full', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ env: loadEnv({ ...process.env, DATABASE_URL: TEST_DB, AUTH_RATE_LIMIT_MAX: '1000' }) });
  });
  afterAll(() => app.close());

  /** Empresa com Ana (Análise, MASTER) e João (Operação); devolve os cookies de cada um. */
  async function company() {
    const cnpj = randomCnpj();
    const email = `wms-${cnpj}@teste.dev`;
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, phone: '11912345678', cnpj, team: [{ name: 'Ana', area: 'analise', master: true }, { name: 'João', area: 'operacao' }] },
    });
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: cnpj } });
    const base = { nvs_session: cookieOf(res, 'nvs_session') };
    const team = (await app.inject({ method: 'GET', url: '/api/v1/team', cookies: base })).json();
    const enter = async (name: string, mode: string) => {
      const m = team.members.find((x: { name: string }) => x.name === name);
      const r = await app.inject({ method: 'POST', url: '/api/v1/team/login', cookies: base, payload: { operatorId: m.id, pin: '1234', mode } });
      return { ...base, nvs_person: cookieOf(r, 'nvs_person') };
    };
    return { base, ana: await enter('Ana', 'analise'), joao: await enter('João', 'operacao') };
  }
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, cookies: Cookies, payload?: object) =>
    app.inject({ method, url: `/api/v1${url}`, cookies, ...(payload ? { payload: payload as Record<string, unknown> } : {}) });

  const PDF = inboundPdf([
    { sku: 'PROTENIS', mlCode: 'IBFJ71702', ean: '7891234567895', description: 'Protetor de Tênis Moto', qty: 3 },
    { sku: 'VARAL', mlCode: 'YTHH93028', description: 'Varal De Chão Slim', qty: 2 },
  ]);
  const inbound = (c: Cookies, extra: object = {}) =>
    call('POST', '/wms/inbound', c, { marketplace: 'ml', fullDate: '2026-10-14', pdfBase64: PDF.toString('base64'), ...extra });

  it('Processamento é da Análise: PDF vira lote + lista, e os códigos entram no Master Data', async () => {
    const { ana, joao, base } = await company();
    expect((await inbound(joao)).statusCode).toBe(403);
    expect((await inbound(base)).statusCode).toBe(401); // sem a pessoa (PIN)
    const r = await inbound(ana);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({ status: 'ok', units: 5, declaredUnits: 5 });
    expect(body.batch).toMatchObject({ name: '14/10/2026', inboundRef: '123456', lifecycle: 'pendente', totalItems: 5, pct: 0 });
    expect(body.batch.lists.map((l: { code: string }) => l.code)).toEqual(['ML-14-10-2026']);

    const products = (await call('GET', '/wms/products?q=PROTENIS', ana)).json();
    expect(products.items[0]).toMatchObject({ sku: 'PROTENIS', description: 'Protetor de Tênis Moto' });
    expect(products.items[0].codes.sort()).toEqual(['7891234567895', 'IBFJ71702']);

    // 2º envio no mesmo dia: lote nº2 com código -B
    const second = (await inbound(ana)).json();
    expect(second.batch.name).toBe('14/10/2026 · nº2');
    expect(second.batch.lists[0].code).toBe('ML-14-10-2026-B');
  });

  it('operador bipa (unidade e caixa), conclui o item e a etiqueta vai para a fila com o Código ML', async () => {
    const { ana, joao } = await company();
    const listId = (await inbound(ana)).json().batch.lists[0].id as string;

    // SKU digitado não vale; código desconhecido; bipagem normal pelo Código ML
    expect((await call('POST', `/wms/lists/${listId}/scan`, joao, { barcode: 'PROTENIS' })).json().status).toBe('unknown_barcode');
    expect((await call('POST', `/wms/lists/${listId}/scan`, joao, { barcode: '000' })).json()).toMatchObject({ status: 'unknown_barcode', canLink: false });
    const s1 = (await call('POST', `/wms/lists/${listId}/scan`, joao, { barcode: 'IBFJ71702' })).json();
    expect(s1).toMatchObject({ status: 'ok', item: { sku: 'PROTENIS', qtyPicked: 1, status: 'in_progress' } });

    // a lista ficou com o João: Ana bipando é oferecida a transferência
    const other = (await call('POST', `/wms/lists/${listId}/scan`, ana, { barcode: '7891234567895' })).json();
    expect(other).toMatchObject({ status: 'transfer_available', ownerName: 'João' });

    // EAN também vale; completa e a etiqueta entra na fila
    await call('POST', `/wms/lists/${listId}/scan`, joao, { barcode: '7891234567895' });
    const done = (await call('POST', `/wms/lists/${listId}/scan`, joao, { barcode: 'IBFJ71702' })).json();
    expect(done).toMatchObject({ status: 'complete', item: { qtyPicked: 3, status: 'complete', labelsReady: true } });
    expect(done.print).toMatchObject({ sku: 'PROTENIS', labels: 3, status: 'PENDING' });
    expect((await call('POST', `/wms/lists/${listId}/scan`, joao, { barcode: 'IBFJ71702' })).json().status).toBe('excess');

    const zpl = await call('GET', `/wms/lists/${listId}/zpl?sku=PROTENIS`, joao);
    expect(zpl.body).toContain('^BCN,54,N,N^FDIBFJ71702^FS');
    expect(zpl.body.match(/\^XA/g)).toHaveLength(2); // 1 par + 1 simples

    // modo caixa: achou só 1 de 2 → parcial, falta de 1 no relatório; lista concluída
    const box = (await call('POST', `/wms/lists/${listId}/scan`, joao, { barcode: 'YTHH93028', mode: 'box', qty: 1 })).json();
    expect(box).toMatchObject({ status: 'complete', item: { status: 'partial', qtyPicked: 1, shortageQty: 1 } });
    const detail = (await call('GET', `/wms/lists/${listId}`, joao)).json();
    expect(detail.list).toMatchObject({ status: 'completed', operatorName: 'João', itemsPicked: 4, itemsTotal: 5 });
    expect((await call('GET', '/wms/shortages', ana)).json()).toEqual([
      { sku: 'VARAL', description: 'Varal De Chão Slim', listCode: 'ML-14-10-2026', qty: 1, notes: null },
    ]);

    const ov = (await call('GET', '/wms/overview', joao)).json();
    expect(ov).toMatchObject({ lists: { total: 1, completed: 1 }, units: { total: 5, picked: 4 }, shortage: { units: 1, skus: 1 } });
    const rank = (await call('GET', '/wms/ranking', ana)).json();
    expect(rank.operators).toEqual([{ name: 'João', total: 4 }]);
    const batch = (await call('GET', '/wms/batches', ana)).json().batches[0];
    expect(batch.lifecycle).toBe('em_andamento');
  });

  it('busca do operador, transferência (EXT-) e vínculo de código novo', async () => {
    const { ana, joao } = await company();
    const listId = (await inbound(ana)).json().batch.lists[0].id as string;
    await call('POST', `/wms/lists/${listId}/scan`, ana, { barcode: 'YTHH93028' }); // lista fica com a Ana

    const found = (await call('GET', '/wms/find?q=7891234567895', joao)).json();
    expect(found).toMatchObject({ action: 'transfer_available', sku: 'PROTENIS', match: { operatorName: 'Ana' } });
    const t = (await call('POST', `/wms/items/${found.match.itemId}/transfer`, joao)).json();
    expect(t.code).toMatch(/^EXT-ML-14-10-2026-\d{4}$/);
    const ext = (await call('GET', `/wms/lists/${t.listId}`, joao)).json();
    expect(ext).toMatchObject({ list: { operatorName: 'João' }, items: [{ sku: 'PROTENIS' }] });

    // pendentes e título
    expect((await call('GET', '/wms/pending', joao)).json().map((p: { sku: string }) => p.sku)).toEqual(['PROTENIS']);
    expect((await call('GET', '/wms/find?q=varal', joao)).json()).toMatchObject({ action: 'in_progress_other', sku: 'VARAL' });

    // código novo: operador não vincula a SKU que já tem código; Análise pode
    expect((await call('POST', '/wms/barcodes', joao, { barcode: '999', sku: 'PROTENIS' })).statusCode).toBe(403);
    expect((await call('POST', '/wms/barcodes', ana, { barcode: '999', sku: 'PROTENIS' })).statusCode).toBe(204);
    expect((await call('POST', `/wms/lists/${t.listId}/scan`, joao, { barcode: '999' })).json().status).toBe('ok');
  });

  it('Master Data: cadastrar, corrigir código vinculado errado, sem código físico; operador só lê', async () => {
    const { ana, joao } = await company();
    const p = await call('POST', '/wms/products', ana, { sku: 'kit2', description: 'Kit 2', codes: ['111', '222'] });
    expect(p.statusCode).toBe(201);
    expect(p.json()).toMatchObject({ sku: 'KIT2', codes: ['111', '222'] });
    expect((await call('POST', '/wms/products', ana, { sku: 'KIT2' })).statusCode).toBe(409);
    expect((await call('POST', '/wms/products', joao, { sku: 'X' })).statusCode).toBe(403);

    await call('POST', '/wms/products', ana, { sku: 'OUTRO' });
    const dup = (await call('POST', '/wms/products/OUTRO/codes', ana, { barcode: '111' })).json();
    expect(dup.alsoOn).toEqual(['KIT2']); // avisa que o código já está em outro SKU
    const fixed = (await call('DELETE', '/wms/products/OUTRO/codes/111', ana)).json();
    expect(fixed.codes).toEqual([]);

    const upd = (await call('PATCH', '/wms/products/KIT2', ana, { noPhysicalBarcode: true, description: 'Kit 2 peças' })).json();
    expect(upd).toMatchObject({ noPhysicalBarcode: true, description: 'Kit 2 peças' });
    const imp = (
      await call('POST', '/wms/products/import', ana, {
        csv: '\uFEFFSKU;Descrição;EAN1;EAN2\nNOVO;Novo item;7890000000001;N/A\nKIT2;;333\nsodesc;Só descrição\nMUITOS;;1;2;3;4;5',
      })
    ).json();
    // linha só com descrição não vira código; mais de 3 códigos entram todos
    expect(imp).toEqual({ products: 4, codes: 7 });
    expect((await call('GET', '/wms/products?q=SODESC', ana)).json().items[0]).toMatchObject({ description: 'Só descrição', codes: [] });
    // sem cabeçalho e 2 colunas: SKU;EAN (formato antigo)
    expect((await call('POST', '/wms/products/import', ana, { csv: 'DOIS;999' })).json()).toEqual({ products: 1, codes: 1 });
    expect((await call('GET', '/wms/products', joao)).json().total).toBe(6);
    expect((await call('DELETE', '/wms/products/NOVO', ana)).statusCode).toBe(204);
  });

  it('PDF da Shopee: detectado sozinho, vira lote SH com listas de até 1.000 un. e etiqueta com o código da Shopee', async () => {
    const { ana, joao } = await company();
    const pdf = readFileSync(new URL('../src/modules/wms/domain/__fixtures__/FBSINBR2026042800054.pdf', import.meta.url));
    const r = (await call('POST', '/wms/inbound', ana, { fullDate: '2026-05-06', pdfBase64: pdf.toString('base64') })).json();
    expect(r).toMatchObject({ status: 'ok', units: 11820, declaredUnits: 11820, batch: { marketplace: 'shopee', inboundRef: 'INBRFSP12604290170', totalItems: 11820 } });
    expect(r.batch.lists.length).toBeGreaterThanOrEqual(12);
    expect(r.batch.lists.every((l: { code: string; itemsTotal: number; skuCount: number }) => l.code.startsWith('SH-06-05-2026-L') && (l.itemsTotal <= 1000 || l.skuCount === 1))).toBe(true);
    // fica separado do ML
    expect((await call('GET', '/wms/batches?marketplace=ml', ana)).json().batches).toEqual([]);
    const ov = (await call('GET', '/wms/overview?marketplace=shopee', joao)).json();
    expect(ov.units.total).toBe(11820);

    // bipa pelo Shopee SKU ID (vira código no Master Data) e a etiqueta sai com QR
    const found = (await call('GET', '/wms/find?marketplace=shopee&q=25147029740_243914807565', joao)).json();
    expect(found).toMatchObject({ action: 'open', sku: 'VEOX' });
    const done = (await call('POST', `/wms/lists/${found.match.listId}/scan`, joao, { barcode: '25147029740_243914807565', mode: 'box' })).json();
    expect(done).toMatchObject({ status: 'complete', item: { sku: 'VEOX', qtyPicked: 200 } });
    const zpl = (await call('GET', `/wms/lists/${found.match.listId}/zpl?sku=VEOX&qty=1`, joao)).body;
    expect(zpl).toContain('^BQN,2,3^FDQA,25147029740_243914807565^FS');
  });

  it('PDF da Shopee de julho (EAN do armazém quebrado em 2 linhas) fecha 4.073', async () => {
    const { ana } = await company();
    const pdf = readFileSync(new URL('../src/modules/wms/domain/__fixtures__/FBSINBR2026072103635.pdf', import.meta.url));
    const r = await call('POST', '/wms/inbound', ana, { fullDate: '2026-07-22', pdfBase64: pdf.toString('base64') });
    expect(r.json()).toMatchObject({ status: 'ok', units: 4073 });
  });

  it('lotes: limite de ativos pede para arquivar; outra empresa não vê nada', async () => {
    const { ana } = await company();
    for (let i = 0; i < 10; i++) await inbound(ana);
    const pending = (await inbound(ana)).json();
    expect(pending).toMatchObject({ status: 'needs_archive', oldest: { name: '14/10/2026', pending: 2 } });
    const ok = (await inbound(ana, { archiveOldestId: pending.oldest.id })).json();
    expect(ok.status).toBe('ok');
    const all = (await call('GET', '/wms/batches', ana)).json().batches;
    expect(all.filter((b: { status: string }) => b.status === 'archived')).toHaveLength(1);

    const other = await company();
    expect((await call('GET', '/wms/batches', other.ana)).json().batches).toEqual([]);
    expect((await call('GET', `/wms/lists/${ok.batch.lists[0].id}`, other.ana)).statusCode).toBe(404);
    expect((await call('GET', '/wms/products', other.ana)).json().total).toBe(0);
  });

  it('agente Zebra: chave da empresa no MACHINE_ID; chave errada é recusada', async () => {
    const { ana, joao } = await company();
    expect((await call('POST', '/wms/agent/key', joao)).statusCode).toBe(403);
    const { key } = (await call('POST', '/wms/agent/key', ana)).json();
    expect(key).toMatch(/^nvsk_[a-f0-9]{40}$/);
    await app.ready();
    const bad = await app.injectWS('/ws/zebra-agent/nvsk_' + '0'.repeat(40));
    const closed = await new Promise<number>((r) => bad.on('close', (code: number) => r(code)));
    expect(closed).toBe(4401);

    const listId = (await inbound(ana)).json().batch.lists[0].id as string;
    const ws = await app.injectWS(`/ws/zebra-agent/${key}.CAIXA1`);
    const msgs: Record<string, unknown>[] = [];
    const next = () => new Promise<Record<string, unknown>>((r) => ws.once('message', (d: Buffer) => r(JSON.parse(String(d)))));
    let wait = next();
    ws.send(JSON.stringify({ type: 'hello', printer: 'ZDesigner', agent_version: '3.0' }));
    msgs.push(await wait);
    expect(msgs[0]).toMatchObject({ type: 'connected', machine_id: 'CAIXA1' });

    wait = next();
    const job = (await call('POST', `/wms/lists/${listId}/print`, joao, { sku: 'VARAL', qty: 2 })).json();
    const sent = await wait;
    expect(sent).toMatchObject({ type: 'print_job', id: job.id, sku: 'VARAL' });
    expect(String(sent.zpl_content)).toContain('^FDYTHH93028^FS');
    ws.send(JSON.stringify({ type: 'print_result', job_id: job.id, job_token: sent.job_token, status: 'ok', printer: 'ZDesigner' }));
    await new Promise((r) => setTimeout(r, 150));
    expect((await call('GET', `/wms/lists/${listId}/print?sku=VARAL`, joao)).json()).toMatchObject({ status: 'PRINTED', printerName: 'ZDesigner' });
    expect((await call('GET', '/wms/agent', ana)).json().connected).toEqual([{ machine: 'CAIXA1', printer: 'ZDesigner', hostname: null, version: '3.0' }]);
    ws.terminate();
  });
});
