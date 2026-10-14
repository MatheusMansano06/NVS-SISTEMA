import type { FastifyInstance, FastifyRequest } from 'fastify';
import { NotFoundError, ValidationError } from '../../../shared/kernel/errors.js';
import { readPerson } from '../../operation/index.js';
import type { CentralService } from '../application/central-service.js';
import type { ReturnActor } from '../application/returns-service.js';
import { INVOICE_KEY } from '../domain/invoice.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVIDENCE_BODY_LIMIT = 60 * 2 ** 20;

/** Datas como o servidor original grava: UTC sem fuso ("2026-10-14T12:00:00.000"); a tela acrescenta o "Z". */
function naiveDates(this: unknown, key: string, value: unknown) {
  const original = (this as Record<string, unknown>)[key];
  return original instanceof Date ? original.toISOString().slice(0, -1) : value;
}

type Query = Record<string, string | undefined>;

function q<T extends 'str' | 'int' | 'float' | 'bool'>(
  req: FastifyRequest,
  name: string,
  kind: T,
  fallback: (T extends 'str' ? string : T extends 'bool' ? boolean : number) | undefined,
  min?: number,
  max?: number,
) {
  const raw = (req.query as Query)[name];
  if (raw === undefined || raw === '') return fallback;
  let v: string | number | boolean = raw;
  if (kind === 'bool') v = ['1', 'true', 'sim'].includes(raw.toLowerCase());
  else if (kind !== 'str') {
    v = Number(raw);
    if (!Number.isFinite(v) || (kind === 'int' && !Number.isInteger(v))) throw new ValidationError(`Parâmetro ${name} inválido: '${raw}'`);
    if ((min !== undefined && v < min) || (max !== undefined && v > max)) throw new ValidationError(`Parâmetro ${name} fora do intervalo [${min}, ${max}]`);
  }
  return v as T extends 'str' ? string : T extends 'bool' ? boolean : number;
}

function fatura(req: FastifyRequest): string | null {
  const f = q(req, 'fatura', 'str', undefined);
  if (f && !INVOICE_KEY.test(f)) throw new ValidationError(`Parâmetro fatura inválido: '${f}'`);
  return f ?? null;
}

/**
 * Central de Devoluções com o contrato do NOVAES-ESTOQUE (as telas originais rodam sem mudança). Leitura pede a sessão
 * da empresa; toda ação pede também a pessoa da equipe (nome + PIN), que fica registrada.
 */
export function centralRoutes(service: CentralService) {
  return async (app: FastifyInstance) => {
    app.setReplySerializer((payload) => JSON.stringify(payload, naiveDates));
    // evidência vem em multipart (campo "arquivo"); o corpo é lido inteiro e decodificado na rota
    app.addContentTypeParser('multipart/form-data', { parseAs: 'buffer', bodyLimit: EVIDENCE_BODY_LIMIT }, (_req, body, done) => done(null, body));

    const auth = { preHandler: app.authenticate };
    const tenant = (req: FastifyRequest) => req.user.tenantId;
    const actor = (req: FastifyRequest): ReturnActor => ({ tenantId: req.user.tenantId, operatorId: readPerson(app, req).sub });
    const id = (req: FastifyRequest) => {
      const v = (req.params as { id: string }).id;
      if (!UUID.test(v)) throw new NotFoundError(`Devolução ${v} não existe`);
      return v;
    };
    const param = (req: FastifyRequest, name: string) => (req.params as Record<string, string>)[name]!;
    const body = (req: FastifyRequest) => {
      if (req.body !== undefined && (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body))) {
        throw new ValidationError('Corpo JSON deve ser um objeto');
      }
      return (req.body ?? {}) as Record<string, unknown>;
    };

    // ---------- devoluções
    app.get('/central/devolucoes', auth, async (req) =>
      service.devolucoes(tenant(req), {
        plataforma: q(req, 'plataforma', 'str', undefined), etapa: q(req, 'etapa', 'str', undefined),
        destino: q(req, 'destino', 'str', undefined), limit: q(req, 'limit', 'int', 100, 1, 1000)!,
      }),
    );
    app.get('/central/devolucoes/rastreio/:codigo', auth, async (req) => service.porRastreio(tenant(req), param(req, 'codigo')));
    app.get('/central/triagens-full', auth, async (req) => service.triagensFull(tenant(req)));

    // ---------- conferência
    app.get('/central/conferencia/evidencias/:id', auth, async (req, reply) => {
      const f = await service.evidencia(tenant(req), id(req));
      return reply.header('content-type', f.mime).header('cache-control', 'private, max-age=3600').send(f.bytes);
    });
    app.get('/central/conferencia/:codigo', { preHandler: app.authenticate, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) =>
      service.buscar(tenant(req), param(req, 'codigo'), q(req, 'etiqueta', 'str', undefined)),
    );
    app.post('/central/conferencia/:id', auth, async (req) => service.registrar(actor(req), id(req), body(req)));
    app.post('/central/conferencia/:id/lancar-estoque', auth, async (req) => service.lancarEstoque(actor(req), id(req)));
    app.post('/central/conferencia/:id/chamado-manual', auth, async (req) => service.chamadoManual(actor(req), id(req)));
    app.post('/central/conferencia/:id/chamado-manual/aberto', auth, async (req) => service.chamadoAberto(actor(req), id(req), body(req)));
    app.post('/central/conferencia/:id/evidencias', { preHandler: app.authenticate, bodyLimit: EVIDENCE_BODY_LIMIT }, async (req) => {
      const a = actor(req);
      const ct = String(req.headers['content-type'] ?? '');
      if (!ct.startsWith('multipart/form-data') || !Buffer.isBuffer(req.body)) throw new ValidationError("Envie o arquivo no campo 'arquivo'");
      const form = await new Response(req.body, { headers: { 'content-type': ct } }).formData().catch(() => null);
      const arquivo = form?.get('arquivo');
      if (!arquivo || typeof arquivo === 'string') throw new ValidationError("Envie o arquivo no campo 'arquivo'");
      return service.salvarEvidencia(a, id(req), arquivo.type, Buffer.from(await arquivo.arrayBuffer()));
    });
    app.delete('/central/conferencia/evidencias/:id', auth, async (req) => {
      actor(req);
      return service.excluirEvidencia(tenant(req), id(req));
    });

    // ---------- mediações
    app.get('/central/mediacoes/pendentes-revisao', auth, async (req) => service.pendentesRevisao(tenant(req), q(req, 'dias', 'int', 30, 1, 120)!));
    app.get('/central/mediacoes/:id/motivos', auth, async (req) => service.motivos(tenant(req), id(req)));
    app.post('/central/mediacoes/:id/contestar', { preHandler: app.authenticate, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) =>
      service.contestar(actor(req), id(req), body(req)),
    );
    app.post('/central/mediacoes/:id/aceitar', { preHandler: app.authenticate, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) =>
      service.aceitar(actor(req), id(req)),
    );
    app.get('/central/mediacoes/:id', auth, async (req) => service.historicoMediacao(tenant(req), id(req)));

    // ---------- plataformas
    app.post('/central/mercado-livre/sincronizar', { preHandler: app.authenticate, config: { rateLimit: { max: 4, timeWindow: '1 minute' } } }, async (req) =>
      service.sincronizarMl(tenant(req), q(req, 'dias', 'float', 30, 0, 365)!, q(req, 'todas_abertas', 'bool', false)!),
    );

    // ---------- operação / B.I
    app.get('/central/operacao', auth, async (req) => {
      const destino = (req.query as Query).destino;
      return service.operacao(tenant(req), {
        status: q(req, 'status', 'str', undefined), plataforma: q(req, 'plataforma', 'str', undefined), motivo: q(req, 'motivo', 'str', undefined),
        destino: destino === undefined ? 'vendedor' : destino || null, pagina: q(req, 'pagina', 'int', 1, 1)!,
        por_pagina: q(req, 'por_pagina', 'int', 8, 1, 100)!, envio: q(req, 'envio', 'str', undefined),
      });
    });
    app.get('/central/operacao/atencao', auth, async (req) => service.atencao(tenant(req)));
    app.get('/central/operacao/ultimas', auth, async (req) => service.ultimas(tenant(req), q(req, 'limite', 'int', 6, 1, 50)!));
    app.get('/central/operadores/atividade', auth, async (req) => service.atividade(tenant(req), q(req, 'dia', 'str', undefined)));
    app.get('/central/produtos-quebrados', auth, async (req) => service.produtosQuebrados(tenant(req), q(req, 'dias', 'int', 30, 1, 365)!, fatura(req)));
    app.get('/central/bi/quebrados', auth, async (req) => service.quebradosLista(tenant(req), q(req, 'dias', 'int', 30, 1, 365)!, fatura(req)));
    app.get('/central/custos/:sku/historico', auth, async (req) => service.custoHistorico(tenant(req), param(req, 'sku')));
    app.post('/central/custos/:sku', auth, async (req) => service.registrarCusto({ ...actor(req), userId: req.user.sub }, param(req, 'sku'), body(req)));

    app.get('/central/respostas-prontas', auth, async (req) => service.respostas(tenant(req)));
    app.post('/central/respostas-prontas', auth, async (req) => service.criarResposta(tenant(req), body(req).texto));
    app.put('/central/respostas-prontas/:id', auth, async (req) => service.editarResposta(tenant(req), id(req), body(req).texto));
    app.delete('/central/respostas-prontas/:id', auth, async (req) => service.excluirResposta(tenant(req), id(req)));

    app.get('/central/bi/resumo', auth, async (req) => service.biResumo(tenant(req), q(req, 'dias', 'int', 30, 1, 365)!, fatura(req)));
    app.get('/central/bi/mensal', auth, async (req) => service.biMensal(tenant(req), q(req, 'meses', 'int', 3, 1, 12)!));
    app.post('/central/bi/mensal/:fatura/refazer', auth, async (req) => {
      const f = param(req, 'fatura');
      if (!INVOICE_KEY.test(f)) throw new ValidationError(`Fatura inválida: '${f}'`);
      return service.refazerMes(tenant(req), f);
    });

    // ---------- retorno do Full
    app.get('/central/retiradas-full', auth, async (req) => service.retornosFull(tenant(req), q(req, 'dias', 'int', 30, 1, 365)!, fatura(req)));
    app.get('/central/retirada-full/:codigo', auth, async (req) => service.identificarFull(tenant(req), param(req, 'codigo')));
    app.post('/central/retirada-full/:codigo/entrada', auth, async (req) => service.entradaFull(actor(req), param(req, 'codigo'), body(req).quantidade));

    // ---------- estoque virtual
    app.get('/central/estoque-virtual', auth, async (req) => service.estoqueVirtual(tenant(req)));
    app.post('/central/estoque-virtual/ajuste', auth, async (req) => service.ajusteVirtual(actor(req), body(req)));

    // ---------- sincronização
    app.get('/central/sincronizacao', auth, async (req) => service.sincronizacao(tenant(req)));
    app.get('/central/sincronizacao/progresso', auth, async (req) => service.progresso(tenant(req)));
  };
}
