import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  WMS_MARKETPLACES,
  wmsInboundSchema,
  wmsLifecycleSchema,
  wmsLinkBarcodeSchema,
  wmsNotesSchema,
  wmsOutOfStockSchema,
  wmsPrintSchema,
  wmsProductCodeSchema,
  wmsProductCreateSchema,
  wmsProductClearSchema,
  wmsProductImportSchema,
  wmsProductUpdateSchema,
  wmsScanSchema,
  wmsShortageSchema,
  wmsShortageStatusSchema,
  wmsSkuSchema,
} from '@nvs/shared';
import { z } from 'zod';
import { ValidationError } from '../../../shared/kernel/errors.js';
import { readPerson } from '../../operation/index.js';
import type { Actor, WmsService } from '../application/wms-service.js';
import type { AgentSocket, PrintHub } from '../infrastructure/print-hub.js';

function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw new ValidationError('Revise os dados informados', r.error.flatten());
  return r.data;
}

const id = z.object({ id: z.string().uuid() });
const mpQuery = z.object({ marketplace: z.enum(WMS_MARKETPLACES).default('ml') });

/**
 * Supervisão Full. Toda rota exige a sessão da empresa + a pessoa da equipe (nome + PIN):
 * Visão Geral e Listas valem na Análise e na Operação; Processamento e ações de supervisor, só Análise/MASTER.
 */
export function wmsRoutes(
  service: WmsService,
  opts: {
    isMaster: (tenantId: string, operatorId: string) => Promise<boolean>;
    /** Senha da conta da empresa (ações destrutivas). */
    checkPassword: (tenantId: string, userId: string, password: string) => Promise<boolean>;
    inboundPerMinute?: number;
  },
) {
  return async (app: FastifyInstance) => {
    const auth = { preHandler: app.authenticate };
    const actor = async (req: FastifyRequest): Promise<Actor> => {
      const p = readPerson(app, req);
      return { tenantId: req.user.tenantId, operatorId: p.sub, mode: p.mode, master: await opts.isMaster(req.user.tenantId, p.sub) };
    };
    const person = async (req: FastifyRequest) => (await actor(req)).tenantId;
    const params = (req: FastifyRequest) => parse(id, req.params).id;

    // ---- Visão geral, lotes e listas
    app.get('/wms/overview', auth, async (req) => service.overview(await person(req), parse(mpQuery, req.query).marketplace));
    app.get('/wms/ranking', auth, async (req) => {
      const q = parse(mpQuery.extend({ batchId: z.string().uuid().optional() }), req.query);
      return service.ranking(await person(req), q.marketplace, q.batchId);
    });
    app.get('/wms/batches', auth, async (req) => service.batches(await person(req), parse(mpQuery, req.query).marketplace));
    app.get('/wms/batches/:id', auth, async (req) => service.batch(await person(req), params(req)));
    app.patch('/wms/batches/:id/lifecycle', auth, async (req, reply) => {
      await service.setLifecycle(await actor(req), params(req), parse(wmsLifecycleSchema, req.body).lifecycle);
      return reply.code(204).send();
    });
    app.post('/wms/batches/:id/archive', auth, async (req, reply) => {
      await service.archive(await actor(req), params(req), parse(z.object({ archived: z.boolean() }), req.body).archived);
      return reply.code(204).send();
    });
    app.delete('/wms/batches/:id', auth, async (req, reply) => {
      await service.deleteBatch(await actor(req), params(req));
      return reply.code(204).send();
    });
    app.get('/wms/lists', auth, async (req) => service.lists(await person(req), parse(mpQuery, req.query).marketplace));
    app.get('/wms/lists/:id', auth, async (req) => service.detail(await person(req), params(req)));
    app.post('/wms/lists/:id/claim', auth, async (req, reply) => {
      await service.claim(await actor(req), params(req));
      return reply.code(204).send();
    });
    app.post('/wms/lists/:id/release', auth, async (req, reply) => {
      await service.release(await actor(req), params(req));
      return reply.code(204).send();
    });
    app.delete('/wms/lists/:id', auth, async (req, reply) => {
      await service.deleteList(await actor(req), params(req));
      return reply.code(204).send();
    });
    // Relatório de Faltas (Análise e Operação): ver, marcar como resolvida e tirar do relatório
    app.get('/wms/shortages', auth, async (req) => service.shortages(await person(req)));
    app.patch('/wms/shortages/:id/status', auth, async (req, reply) => {
      await service.setShortageStatus(await person(req), params(req), parse(wmsShortageStatusSchema, req.body).status);
      return reply.code(204).send();
    });
    app.delete('/wms/shortages/:id', auth, async (req, reply) => {
      await service.removeShortages(await person(req), params(req));
      return reply.code(204).send();
    });
    app.delete('/wms/shortages', auth, async (req) => ({ removed: await service.removeShortages(await person(req)) }));

    // ---- Operador: bipar, faltas, transferência
    const fast = { preHandler: app.authenticate, config: { rateLimit: { max: 600, timeWindow: '1 minute' } } };
    app.post('/wms/lists/:id/scan', fast, async (req) => service.scan(await actor(req), params(req), parse(wmsScanSchema, req.body)));
    app.post('/wms/lists/:id/undo', fast, async (req) => service.undo(await actor(req), params(req), parse(wmsSkuSchema, req.body).sku));
    app.post('/wms/lists/:id/shortage', fast, async (req) => service.shortage(await actor(req), params(req), parse(wmsShortageSchema, req.body)));
    app.post('/wms/lists/:id/out-of-stock', fast, async (req) => service.outOfStock(await actor(req), params(req), parse(wmsOutOfStockSchema, req.body)));
    app.post('/wms/lists/:id/reset-item', fast, async (req) => service.resetItem(await actor(req), params(req), parse(wmsSkuSchema, req.body).sku));
    app.post('/wms/lists/:id/manual-pick', fast, async (req) => {
      const b = parse(wmsSkuSchema.extend({ mode: z.enum(['unit', 'box']).default('box') }), req.body);
      return service.manualPick(await actor(req), params(req), b.sku, b.mode);
    });
    app.post('/wms/items/:id/transfer', fast, async (req) => service.transfer(await actor(req), params(req)));
    app.patch('/wms/items/:id/notes', auth, async (req, reply) => {
      await service.setNotes(await actor(req), params(req), parse(wmsNotesSchema, req.body).notes);
      return reply.code(204).send();
    });
    app.post('/wms/barcodes', fast, async (req, reply) => {
      const b = parse(wmsLinkBarcodeSchema, req.body);
      await service.linkBarcode(await actor(req), b.barcode, b.sku);
      return reply.code(204).send();
    });
    app.get('/wms/find', fast, async (req) => {
      const q = parse(mpQuery.extend({ q: z.string().trim().min(1).max(200) }), req.query);
      return service.find(await actor(req), q.marketplace, q.q);
    });
    app.get('/wms/pending', auth, async (req) => service.pending(await person(req), parse(mpQuery, req.query).marketplace));

    // ---- Etiquetas
    app.post('/wms/lists/:id/print', fast, async (req) => {
      const b = parse(wmsPrintSchema, req.body);
      return service.print(await actor(req), params(req), b.sku, b.qty);
    });
    app.get('/wms/lists/:id/print', auth, async (req) => service.printStatus(await person(req), params(req), parse(wmsSkuSchema, req.query).sku));
    app.get('/wms/lists/:id/zpl', auth, async (req, reply) => {
      const q = parse(wmsSkuSchema.extend({ qty: z.coerce.number().int().min(1).max(5000).optional() }), req.query);
      const zpl = await service.zpl(await person(req), params(req), q.sku, q.qty);
      return reply
        .header('content-type', 'text/plain; charset=utf-8')
        .header('content-disposition', `attachment; filename="etiquetas-${q.sku.replace(/[^\w-]/g, '_')}.zpl"`)
        .send(zpl);
    });
    app.get('/wms/agent', auth, async (req) => service.agentStatus(await person(req)));
    // conferência da impressora na tela do operador (agente ligado + etiqueta de teste do dia)
    app.get('/wms/printer', auth, async (req) => service.printerStatus(await person(req)));
    app.post('/wms/printer/test', fast, async (req) => service.printTest(await actor(req)));
    app.post('/wms/printer/confirm', auth, async (req, reply) => {
      await service.confirmPrinter(await actor(req));
      return reply.code(204).send();
    });
    app.post('/wms/agent/key', auth, async (req) => service.newAgentKey(await actor(req)));

    // ---- Master Data
    const sku = (req: FastifyRequest) => parse(z.object({ sku: z.string().trim().min(1).max(100) }), req.params).sku;
    app.get('/wms/products', auth, async (req) => {
      const q = parse(z.object({ q: z.string().max(100).default(''), page: z.coerce.number().int().min(1).max(10_000).default(1) }), req.query);
      return service.products(await person(req), q.q, q.page);
    });
    app.post('/wms/products', auth, async (req, reply) => reply.code(201).send(await service.createProduct(await actor(req), parse(wmsProductCreateSchema, req.body))));
    app.patch('/wms/products/:sku', auth, async (req) => service.updateProduct(await actor(req), sku(req), parse(wmsProductUpdateSchema, req.body)));
    app.delete('/wms/products/:sku', auth, async (req, reply) => {
      await service.deleteProduct(await actor(req), sku(req));
      return reply.code(204).send();
    });
    app.post('/wms/products/:sku/codes', auth, async (req) => service.addProductCode(await actor(req), sku(req), parse(wmsProductCodeSchema, req.body).barcode));
    app.delete('/wms/products/:sku/codes/:barcode', auth, async (req) => {
      const p = parse(z.object({ sku: z.string().min(1).max(100), barcode: z.string().min(1).max(200) }), req.params);
      return service.removeProductCode(await actor(req), p.sku, p.barcode);
    });
    app.post('/wms/products/import', { preHandler: app.authenticate, bodyLimit: 6_000_000 }, async (req) => {
      const b = parse(wmsProductImportSchema, req.body);
      return service.importProducts(await actor(req), b.csv, b.onlyListings);
    });
    app.post('/wms/products/clear', { preHandler: app.authenticate, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
      const a = await actor(req);
      const { password } = parse(wmsProductClearSchema, req.body);
      if (!(await opts.checkPassword(req.user.tenantId, req.user.sub, password))) {
        throw new ValidationError('Senha incorreta', { fieldErrors: { password: ['Senha da conta incorreta'] } });
      }
      return service.clearProducts(a);
    });

    // ---- Processamento (PDF do envio, até ~10 MB)
    app.post('/wms/inbound', { preHandler: app.authenticate, bodyLimit: 15_000_000, config: { rateLimit: { max: opts.inboundPerMinute ?? 20, timeWindow: '1 minute' } } }, async (req) =>
      service.inbound(await actor(req), parse(wmsInboundSchema, req.body)),
    );
  };
}

/**
 * WebSocket do agente Zebra (o mesmo ZebraAgent do NVS-WMS): BACKEND_URL=https://<site>/api e
 * MACHINE_ID=<chave da empresa>.<nome da máquina>. Fica fora de /api/v1 porque o agente deriva o
 * endereço tirando o "/api" do BACKEND_URL (→ wss://<site>/ws/zebra-agent/<MACHINE_ID>).
 */
export function wmsAgentSocket(hub: PrintHub) {
  return async (app: FastifyInstance) => {
    app.get('/ws/zebra-agent/:machineId', { websocket: true, config: { rateLimit: false } }, async (socket, req) => {
      const s = socket as unknown as AgentSocket & { on(ev: string, fn: (d: unknown) => void): void };
      // o agente manda o "hello" logo ao conectar: guarda as mensagens até validar a chave
      const early: string[] = [];
      let owner: { tenantId: string; machine: string } | null = null;
      s.on('message', (data) => {
        if (owner) void hub.onMessage(owner.tenantId, owner.machine, String(data)).catch(() => undefined);
        else if (early.length < 20) early.push(String(data));
      });
      s.on('close', () => owner && hub.unregister(owner.tenantId, owner.machine, s));
      const machineId = String((req.params as { machineId?: string }).machineId ?? '').slice(0, 200);
      owner = await hub.tenantForKey(machineId).catch(() => null);
      if (!owner) {
        s.close(4401, 'chave do agente inválida');
        return;
      }
      hub.register(owner.tenantId, owner.machine, s);
      for (const m of early.splice(0)) await hub.onMessage(owner.tenantId, owner.machine, m).catch(() => undefined);
    });
  };
}
