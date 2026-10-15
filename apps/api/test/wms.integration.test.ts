import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { buildApp } from '../src/app.js';
import { Database } from '../src/shared/infrastructure/database.js';
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
  let admin: Database;
  beforeAll(async () => {
    app = await buildApp({ env: loadEnv({ ...process.env, DATABASE_URL: TEST_DB, AUTH_RATE_LIMIT_MAX: '1000' }) });
    admin = new Database(TEST_DB!);
  });
  afterAll(async () => {
    await admin.close();
    await app.close();
  });

  /**
   * Empresa com Ana (Análise, MASTER) e João (Operação); devolve os cookies de cada um. Por padrão com o Full
   * liberado e imprimindo pelo agente Zebra (o fluxo original); `navegador` = etiquetas em PDF.
   */
  async function company(opts: { full?: boolean; print?: 'agente_zebra' | 'navegador' } = {}) {
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
    const ip = `10.${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(1, 255)}`;
    const enter = async (name: string, mode: string) => {
      const m = team.members.find((x: { name: string }) => x.name === name);
      // IP próprio por empresa: o login da equipe tem limite de 20/min por IP
      const r = await app.inject({ method: 'POST', url: '/api/v1/team/login', remoteAddress: ip, cookies: base, payload: { operatorId: m.id, pin: '1234', mode } });
      if (r.statusCode !== 200) throw new Error(`team/login ${r.statusCode} ${r.body}`);
      return { ...base, nvs_person: cookieOf(r, 'nvs_person') };
    };
    const tenantId = res.json().tenant.id as string;
    if (opts.full !== false) await admin.query(`UPDATE tenants SET features = array_append(features, 'full') WHERE id = $1`, [tenantId]);
    await admin.withTenant(tenantId, (db) =>
      db.query(`INSERT INTO wms_settings (tenant_id, print_mode, label_format, label_width_mm, label_height_mm) VALUES ($1, $2, 'rolo_2col', 40, 25)`, [
        tenantId,
        opts.print ?? 'agente_zebra',
      ]),
    );
    return { base, cnpj, tenantId, ana: await enter('Ana', 'analise'), joao: await enter('João', 'operacao') };
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
    // Relatório de Faltas: quem marcou, quando, lista e marketplace
    const faltas = (await call('GET', '/wms/shortages', ana)).json();
    expect(faltas).toEqual([
      expect.objectContaining({
        sku: 'VARAL', description: 'Varal De Chão Slim', listCode: 'ML-14-10-2026', listId, marketplace: 'ml', qty: 1, notes: null,
        operatorName: 'João', status: 'pendente',
      }),
    ]);
    expect(faltas[0].at).toBeTruthy();

    const ov = (await call('GET', '/wms/overview', joao)).json();
    expect(ov).toMatchObject({ lists: { total: 1, completed: 1 }, units: { total: 5, picked: 4 }, shortage: { units: 1, skus: 1 } });
    // resolvida sai da conta da Visão Geral; tirar do relatório não mexe no picking
    expect((await call('PATCH', `/wms/shortages/${faltas[0].itemId}/status`, joao, { status: 'concluido' })).statusCode).toBe(204);
    expect((await call('GET', '/wms/shortages', ana)).json()[0].status).toBe('concluido');
    expect((await call('GET', '/wms/overview', joao)).json().shortage).toEqual({ units: 0, skus: 0 });
    expect((await call('PATCH', `/wms/shortages/${faltas[0].itemId}/status`, joao, { status: 'pendente' })).statusCode).toBe(204);
    expect((await call('DELETE', `/wms/shortages/${faltas[0].itemId}`, ana)).statusCode).toBe(204);
    expect((await call('GET', '/wms/shortages', ana)).json()).toEqual([]);
    expect((await call('GET', `/wms/lists/${listId}`, joao)).json().list).toMatchObject({ itemsPicked: 4 });
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
    expect(imp).toEqual({ products: 4, codes: 7, skipped: 0 });
    expect((await call('GET', '/wms/products?q=SODESC', ana)).json().items[0]).toMatchObject({ description: 'Só descrição', codes: [] });
    // sem cabeçalho e 2 colunas: SKU;EAN (formato antigo)
    expect((await call('POST', '/wms/products/import', ana, { csv: 'DOIS;999' })).json()).toEqual({ products: 1, codes: 1, skipped: 0 });
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

  it('Master Data: importar só o que é anúncio do ML e apagar tudo com a senha da conta', async () => {
    const { ana, joao, tenantId, cnpj } = await company();
    const db = new Database(TEST_DB!);
    await db.withTenant(tenantId, async (c) => {
      const acc = await c.query(
        `INSERT INTO marketplace_accounts (tenant_id, marketplace, nickname, external_id) VALUES ($1, 'mercado_livre', 'Loja', $2) RETURNING id`,
        [tenantId, `acc-${cnpj}`],
      );
      const add = (id: string, sku: string | null, title: string, variations: string[] = []) =>
        c.query(
          `INSERT INTO listings (tenant_id, account_id, marketplace, external_id, title, status, sku, variation_skus)
           VALUES ($1, $2, 'mercado_livre', $3, $4, 'active', $5, $6)`,
          [tenantId, acc.rows[0].id, id, title, sku, variations],
        );
      await add('MLB1', 'VEOX', 'Viseira Ebf New Spark');
      await add('MLB2', null, 'Kit com variações', ['farol-a']);
    });
    await db.close();

    const csv = 'SKU;Descrição;EAN1;EAN2\nVEOX;;KRKY38598KRKY38598;789\nFAROL-A;Farol A;111\nLIXO;;222\n-;;';
    const r = (await call('POST', '/wms/products/import', ana, { csv, onlyListings: true })).json();
    expect(r).toEqual({ products: 2, codes: 3, skipped: 2 });
    const veox = (await call('GET', '/wms/products?q=VEOX', ana)).json().items[0];
    // sem descrição → título do anúncio; código colado pela leitura dupla vira o código uma vez
    expect(veox).toMatchObject({ description: 'Viseira Ebf New Spark', codes: expect.arrayContaining(['KRKY38598', '789']) });
    expect((await call('GET', '/wms/products?q=LIXO', ana)).json().total).toBe(0);

    // apagar tudo: operador não; senha errada não; senha da conta sim
    expect((await call('POST', '/wms/products/clear', joao, { password: cnpj })).statusCode).toBe(403);
    expect((await call('POST', '/wms/products/clear', ana, { password: 'errada' })).statusCode).toBe(400);
    expect((await call('POST', '/wms/products/clear', ana, { password: cnpj })).json()).toEqual({ products: 2, codes: 3 });
    expect((await call('GET', '/wms/products', ana)).json().total).toBe(0);
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

    // conferência do dia na tela do operador: agente pronto, Full em andamento, ainda não conferido
    expect((await call('GET', '/wms/printer', joao)).json()).toMatchObject({ ready: true, fullRunning: true, checkedToday: null, lastTest: null });
    wait = next();
    const test = (await call('POST', '/wms/printer/test', joao)).json();
    const testJob = await wait;
    expect(testJob).toMatchObject({ type: 'print_job', id: test.id, sku: 'TESTE-IMPRESSORA' });
    expect(String(testJob.zpl_content)).toContain('ETIQUETA DE TESTE NVS');
    ws.send(JSON.stringify({ type: 'print_result', job_id: test.id, job_token: testJob.job_token, status: 'ok', printer: 'ZDesigner' }));
    await new Promise((r) => setTimeout(r, 150));
    expect((await call('GET', '/wms/printer', joao)).json().lastTest).toMatchObject({ id: test.id, status: 'PRINTED' });
    expect((await call('POST', '/wms/printer/confirm', joao)).statusCode).toBe(204);
    const checked = (await call('GET', '/wms/printer', ana)).json(); // vale para todos do turno
    expect(checked.checkedToday).toMatchObject({ machine: 'CAIXA1', printer: 'ZDesigner' });
    ws.terminate();
    await new Promise((r) => setTimeout(r, 100));
    expect((await call('GET', '/wms/printer', joao)).json().ready).toBe(false); // agente fechou
    expect((await call('POST', '/wms/printer/confirm', joao)).statusCode).toBe(400);
  });

  it('sem o recurso Full liberado, a API do Full é recusada', async () => {
    const { ana } = await company({ full: false });
    const r = await call('GET', '/wms/batches', ana);
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('FEATURE_LOCKED');
    expect((await inbound(ana)).statusCode).toBe(403);
  });

  it('impressão pelo navegador: sem agente, etiquetas em PDF no formato da empresa e o operador confirma', async () => {
    const { ana, joao } = await company({ print: 'navegador' });
    // configuração: só a Análise muda; vale o formato salvo
    expect((await call('GET', '/wms/settings', joao)).json()).toMatchObject({ printMode: 'navegador', labelFormat: 'rolo_2col' });
    const settings = { printMode: 'navegador', labelFormat: 'rolo_1col', labelWidthMm: 50, labelHeightMm: 25 };
    expect((await app.inject({ method: 'PUT', url: '/api/v1/wms/settings', cookies: joao, payload: settings })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/api/v1/wms/settings', cookies: ana, payload: { ...settings, labelWidthMm: 5 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/v1/wms/settings', cookies: ana, payload: settings })).json()).toEqual(settings);

    // pronto sem agente nenhum
    expect((await call('GET', '/wms/printer', joao)).json()).toMatchObject({ ready: true, settings: { printMode: 'navegador' } });

    const listId = (await inbound(ana)).json().batch.lists[0].id as string;
    // nada separado ainda: lista inteira não tem etiqueta
    expect((await call('GET', `/wms/lists/${listId}/labels.pdf`, joao)).statusCode).toBe(400);
    await call('POST', `/wms/lists/${listId}/scan`, joao, { barcode: 'IBFJ71702', mode: 'box' });
    const done = (await call('GET', `/wms/lists/${listId}`, joao)).json();
    const item = done.items.find((i: { sku: string }) => i.sku === 'PROTENIS');
    expect(item).toMatchObject({ status: 'complete', labelsPrinted: false });
    // nada vai para a fila do agente
    expect((await call('GET', `/wms/lists/${listId}/print?sku=PROTENIS`, joao)).json()).toBeNull();

    const pdf = await call('GET', `/wms/lists/${listId}/labels.pdf?sku=PROTENIS`, joao);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await call('GET', `/wms/lists/${listId}/labels.pdf`, joao)).statusCode).toBe(200); // lista inteira

    expect((await call('POST', `/wms/lists/${listId}/printed`, joao, { sku: 'PROTENIS' })).statusCode).toBe(204);
    const after = (await call('GET', `/wms/lists/${listId}`, joao)).json();
    expect(after.items.find((i: { sku: string }) => i.sku === 'PROTENIS').labelsPrinted).toBe(true);

    // teste e conferência do dia sem agente
    const test = await call('GET', '/wms/printer/test.pdf', joao);
    expect(test.headers['content-type']).toBe('application/pdf');
    expect((await call('POST', '/wms/printer/confirm', joao)).statusCode).toBe(204);
    expect((await call('GET', '/wms/printer', ana)).json().checkedToday).toMatchObject({ machine: 'navegador', printer: 'PDF 50 × 25 mm' });
  });
});
