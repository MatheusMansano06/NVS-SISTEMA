import type { ReturnCheckInput } from '@nvs/shared';
import type { Database, Queryable } from '../../../shared/infrastructure/database.js';
import { AppError, NotFoundError, ValidationError } from '../../../shared/kernel/errors.js';
import { ACTED, FULL } from './returns-enrichment.js';
import { CHARGES, addDays, cycle, keyOfDay, lastKeys, utcDay } from '../domain/invoice.js';
import type { PgReturnsRepository, ReturnRow } from '../infrastructure/pg-returns-repository.js';
import { toRow, type ReturnActor, type ReturnsService } from './returns-service.js';
import type { ReturnsSync } from './returns-sync.js';
import type { ReturnStock } from './return-stock.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

/**
 * Central de Devoluções com o mesmo contrato do NOVAES-ESTOQUE (rotas /central/*, campos em português, datas UTC sem
 * fuso). As telas originais rodam sem mudança em cima das tabelas de devoluções do NVS. Só Mercado Livre: Shopee e Olist
 * aparecem como não conectadas, como no original quando elas estão fora do ar.
 */
const PLATAFORMAS = ['mercado_livre', 'shopee'] as const;
const STATUS = ['a_caminho', 'aguardando_conferencia', 'precisa_acao', 'em_mediacao', 'com_a_plataforma', 'resolvida', 'finalizada'];
const ENVIOS = ['aguardando_postagem', 'postado', 'sem_info'];
const RESOLVIDAS = new Set(['resolvida', 'finalizada']);
const DECLARADO_QUEBRADO = new Set(['danificado', 'defeito']);
const MOTIVOS_LOGISTICA = ['diferente', 'defeito', 'nao_serviu'];
const SEGMENTOS: [string, string, string][] = [
  ['bancada', 'B', 'Conferido na bancada: avariado, sem condição de venda'],
  ['bancada', 'C', 'Conferido na bancada: voltou produto diferente do vendido'],
  ['motivo', 'danificado', 'Motivo da devolução: chegou danificado'],
  ['motivo', 'defeito', 'Motivo da devolução: produto com defeito'],
];
const CARENCIA_FECHAMENTO_DIAS = 7;
const OLIST_OFF = { erro: 'Olist não conectada a esta empresa: confira o pedido e a NF pelo painel do marketplace.', pedidos: [] };
const TIPOS_EVIDENCIA: Record<string, ['foto' | 'video', number]> = {
  'image/jpeg': ['foto', 15], 'image/png': ['foto', 15], 'image/webp': ['foto', 15],
  'video/mp4': ['video', 50], 'video/webm': ['video', 50], 'video/quicktime': ['video', 50],
};
const ETIQUETA_FULL = /^[A-Z]{4}\d{5}$/;
const DIA = /^\d{4}-\d{2}-\d{2}$/;

const r2 = (v: number) => Math.round(v * 100) / 100;
const r1 = (v: number) => Math.round(v * 10) / 10;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
/** O Cadastro de SKUs e o ML nem sempre escrevem o SKU igual (maiúsculas, espaços): a ligação ignora isso. */
const chaveSku = (sku: string) => sku.trim().toUpperCase();

export class Travada extends AppError {
  constructor(message: string) {
    super(message, 'RETURN_LOCKED', 409);
  }
}

interface Item { item_id: string | null; variation_id: string | null; sku: string | null; quantidade: number; nome: string | null; imagem?: string | null }
interface Conf {
  classe: 'A' | 'B' | 'C';
  lancamentos: { sku: string; deposito: string; tipo: string }[];
  estoque_lancado_em: Date | null;
  contestar: boolean;
  chamado_manual: boolean;
  chamado_aberto_em: Date | null;
  chamado_protocolo: string | null;
  perda_produto: number | null;
  frete_reverso: number | null;
  conferida_em: Date | null;
  erro_nosso: boolean;
  sku_recebido: string | null;
}
export interface Linha {
  id: string;
  plataforma: string;
  id_externo: string;
  pedido: string;
  pacote: string | null;
  rastreio: string | null;
  etapa: string;
  status_plataforma: string;
  em_mediacao: boolean;
  pode_contestar: boolean;
  motivo: string;
  motivo_plataforma: string;
  responsavel: string;
  destino: string;
  valor_reembolso: number | null;
  custo_plataforma: number | null;
  afeta_reputacao: boolean | null;
  condicao_produto: string | null;
  resultado_mediacao: string | null;
  cobertura_aplicada: boolean | null;
  prazo_vendedor: Date | null;
  itens: Item[];
  aberta_em: Date;
  atualizada_em: Date;
  aguarda_revisao: boolean;
  conferencia: Conf | null;
  contestada: boolean;
  status: string;
  pendencias: string[];
  envio: string | null;
  envio_plataforma: string | null;
}
interface Extra { logistica: string | null; aberta_por: string | null; acoes: string | null }

/** Custo vigente por SKU e data (histórico do Cadastro de SKUs), carregado uma vez por consulta. */
class Custos {
  constructor(
    private readonly hist: Map<string, { custo: number | null; desde: string }[]>,
    private readonly atual: Map<string, number>,
  ) {}

  static async load(db: Queryable) {
    const h = await db.query<{ sku: string; custo_unit: string | null; desde: string }>(
      `SELECT sku, custo_unit, to_char(vigente_desde, 'YYYY-MM-DD') AS desde FROM sku_cost_history ORDER BY sku, vigente_desde, registrado_em`,
    );
    const a = await db.query<{ sku: string; custo_unit: string }>('SELECT sku, custo_unit FROM sku_costs');
    const hist = new Map<string, { custo: number | null; desde: string }[]>();
    for (const r of h.rows) hist.set(chaveSku(r.sku), [...(hist.get(chaveSku(r.sku)) ?? []), { custo: num(r.custo_unit), desde: r.desde }]);
    return new Custos(hist, new Map(a.rows.map((r) => [chaveSku(r.sku), Number(r.custo_unit)])));
  }

  /** Antes do primeiro registro vale o primeiro (o histórico começa "desde sempre"). */
  na(sku: string | null | undefined, quando: Date): number | null {
    if (!sku) return null;
    const vs = this.hist.get(chaveSku(sku));
    if (!vs?.length) return this.atual.get(chaveSku(sku)) ?? null;
    const dia = utcDay(quando);
    let escolhido = vs[0]!;
    for (const v of vs) if (v.desde <= dia) escolhido = v;
    return escolhido.custo;
  }

  de(sku: string | null | undefined): number | null {
    return sku ? (this.atual.get(chaveSku(sku)) ?? null) : null;
  }
}

function conf(r: ReturnRow): Conf | null {
  if (!r.c_class) return null;
  return {
    classe: r.c_class,
    lancamentos: (r.c_stock_moves ?? []).map((m: Json) => ({ sku: m.sku, deposito: m.deposit, tipo: m.type })),
    estoque_lancado_em: r.c_stock_done_at,
    contestar: Boolean(r.c_dispute),
    chamado_manual: Boolean(r.c_manual_ticket),
    chamado_aberto_em: r.c_ticket_opened_at,
    chamado_protocolo: r.c_ticket_protocol,
    perda_produto: num(r.c_product_loss),
    frete_reverso: num(r.c_reverse_freight),
    conferida_em: r.c_checked_at,
    erro_nosso: Boolean(r.c_our_error),
    sku_recebido: r.c_sku_received,
  };
}

function linha(r: ReturnRow): Linha {
  const row = toRow(r);
  return {
    id: r.id,
    plataforma: 'mercado_livre',
    id_externo: r.external_id,
    pedido: r.order_id,
    pacote: r.pack_id,
    rastreio: r.tracking,
    etapa: r.stage,
    status_plataforma: r.platform_status,
    em_mediacao: r.in_mediation,
    pode_contestar: r.can_dispute,
    motivo: r.reason,
    motivo_plataforma: r.reason_platform,
    responsavel: r.responsible,
    destino: r.destination,
    valor_reembolso: null,
    custo_plataforma: num(r.platform_cost),
    afeta_reputacao: r.affects_reputation,
    condicao_produto: r.product_condition,
    resultado_mediacao: r.mediation_result,
    cobertura_aplicada: r.coverage_applied,
    prazo_vendedor: r.seller_deadline,
    itens: (r.items ?? []).map((i) => ({ item_id: i.itemId, variation_id: i.variationId ?? null, sku: i.sku, quantidade: i.qty, nome: i.name })),
    aberta_em: r.opened_at,
    atualizada_em: r.updated_at,
    aguarda_revisao: r.awaiting_review,
    conferencia: conf(r),
    contestada: r.disputed,
    status: row.status,
    pendencias: row.pending,
    envio: row.shipping,
    envio_plataforma: row.status === 'a_caminho' ? r.platform_status : null,
  };
}

/** Só os campos de `Devolucao` (sem o que a operação calcula): é o que o original chama de `publico`. */
function publico(l: Linha) {
  const { conferencia: _c, contestada: _ct, status: _s, pendencias: _p, envio: _e, envio_plataforma: _ep, ...d } = l;
  return d;
}

function aCaminhoPorPlataforma(ls: Linha[]) {
  const saida: Record<string, Record<string, number>> = Object.fromEntries(PLATAFORMAS.map((p) => [p, Object.fromEntries(ENVIOS.map((e) => [e, 0]))]));
  for (const l of ls) if (l.status === 'a_caminho' && saida[l.plataforma] && l.envio) saida[l.plataforma]![l.envio]!++;
  return saida;
}

function periodo(dias: number, fatura: string | null): [string, string, string, string] {
  if (fatura) {
    const [ini, fim] = cycle(fatura);
    const [iniAnt, fimAnt] = cycle(keyOfDay(addDays(ini, -1)));
    return [ini, fim, iniAnt, fimAnt];
  }
  const fim = utcDay(new Date());
  const ini = addDays(fim, -(dias - 1));
  return [ini, fim, addDays(ini, -dias), addDays(ini, -1)];
}

const entre = (l: Linha, ini: string, fim: string) => {
  const d = utcDay(l.aberta_em);
  return ini <= d && d <= fim;
};

export interface CentralDeps {
  saveCost: (tenantId: string, userId: string, sku: string, custo: number, since: string, byName: string | null) => Promise<number>;
  today: () => string; // dia de São Paulo
  stock: ReturnStock;
}

export class CentralService {
  constructor(
    private readonly db: Database,
    private readonly repo: PgReturnsRepository,
    private readonly returns: ReturnsService,
    private readonly sync: ReturnsSync | null,
    private readonly deps: CentralDeps,
  ) {}

  // ================= base: todas as devoluções com o status de operação calculado
  private async carregar(db: Queryable, where = 'TRUE', params: unknown[] = []) {
    const rows = await this.repo.rows(db, where, params);
    const extra = new Map<string, Extra>(rows.map((r) => [r.id, { logistica: r.sale_logistic, aberta_por: r.mediation_opened_by, acoes: r.mediation_actions }]));
    const linhas = rows.map(linha);
    // pedido sem SKU (anúncio sem variação): vale o SKU do anúncio, para ligar o custo do Cadastro de SKUs
    const semSku = [...new Set(linhas.flatMap((l) => l.itens.filter((i) => !i.sku && i.item_id).map((i) => i.item_id!)))];
    if (semSku.length) {
      const { rows: an } = await db.query<{ item_id: string; sku: string }>(
        `SELECT external_id AS item_id, sku FROM listings WHERE external_id = ANY($1) AND sku IS NOT NULL AND cardinality(variation_skus) <= 1
         UNION ALL SELECT item_id, sku FROM ml_item_pictures WHERE item_id = ANY($1) AND sku IS NOT NULL`,
        [semSku],
      );
      const skuDe = new Map(an.map((a) => [a.item_id, a.sku]));
      for (const l of linhas) for (const i of l.itens) if (!i.sku && i.item_id) i.sku = skuDe.get(i.item_id) ?? null;
    }
    // o prejuízo da bancada acompanha o Cadastro de SKUs: custo cadastrado depois da conferência já entra na conta
    const custos = await Custos.load(db);
    for (const l of linhas) {
      const c = l.conferencia;
      if (!c || c.classe === 'A') continue;
      const perdido = c.classe === 'B' && c.erro_nosso ? c.sku_recebido : l.itens.find((i) => i.sku)?.sku;
      const unit = custos.na(perdido, c.conferida_em ?? l.aberta_em);
      if (unit !== null) c.perda_produto = r2(unit * (sum(l.itens.map((i) => i.quantidade || 0)) || 1));
    }
    return { linhas, extra, custos };
  }

  private async fotos(db: Queryable, itemIds: (string | null | undefined)[], skus: (string | null | undefined)[] = []) {
    const ids = [...new Set(itemIds.filter((x): x is string => Boolean(x)))];
    const ss = [...new Set(skus.filter((x): x is string => Boolean(x)))];
    if (!ids.length && !ss.length) return { porItem: new Map<string, string>(), porSku: new Map<string, string>() };
    const { rows } = await db.query<{ external_id: string; sku: string | null; picture_url: string }>(
      `SELECT external_id, sku, picture_url FROM listings WHERE (external_id = ANY($1) OR sku = ANY($2)) AND picture_url IS NOT NULL
       UNION ALL SELECT item_id, sku, url FROM ml_item_pictures WHERE (item_id = ANY($1) OR sku = ANY($2)) AND url IS NOT NULL`,
      [ids, ss],
    );
    return {
      porItem: new Map(rows.map((r) => [r.external_id, r.picture_url])),
      porSku: new Map(rows.filter((r) => r.sku).map((r) => [r.sku!, r.picture_url])),
    };
  }

  // ================= operação
  async operacao(tenantId: string, q: { status?: string; plataforma?: string; motivo?: string; destino?: string | null; pagina: number; por_pagina: number; envio?: string }) {
    return this.db.withTenant(tenantId, async (db) => {
      const { linhas } = await this.carregar(db);
      const base = linhas.filter((l) => (!q.motivo || l.motivo === q.motivo) && (!q.destino || l.destino === q.destino));
      const a_caminho = aCaminhoPorPlataforma(base);
      let filtradas = base.filter((l) => !q.plataforma || l.plataforma === q.plataforma);
      const contagens: Record<string, number> = Object.fromEntries(STATUS.map((s) => [s, 0]));
      for (const l of filtradas) contagens[l.status] = (contagens[l.status] ?? 0) + 1;
      if (q.status) {
        const quer = new Set(q.status.split(','));
        filtradas = filtradas.filter((l) => quer.has(l.status));
      }
      if (q.envio) filtradas = filtradas.filter((l) => l.envio === q.envio);
      // prazo que ainda dá para cumprir, o mais apertado primeiro; o resto (vencido ou sem prazo), mais recente primeiro
      const agora = Date.now();
      const chave = (l: Linha): [number, number] =>
        l.prazo_vendedor && l.prazo_vendedor.getTime() > agora ? [0, l.prazo_vendedor.getTime()] : [1, -l.atualizada_em.getTime()];
      filtradas.sort((a, b) => {
        const [ka, va] = chave(a);
        const [kb, vb] = chave(b);
        return ka - kb || va - vb;
      });
      const pagina = filtradas.slice((q.pagina - 1) * q.por_pagina, q.pagina * q.por_pagina);
      const { porItem } = await this.fotos(db, pagina.map((l) => l.itens[0]?.item_id));
      const itens = pagina.map((l) => {
        const item = l.itens[0];
        const c = l.conferencia;
        return {
          ...l,
          produto: item?.nome ?? null,
          imagem: (item?.item_id && porItem.get(item.item_id)) || null,
          prejuizo: c ? r2((c.frete_reverso ?? 0) + (c.perda_produto ?? 0)) : l.custo_plataforma,
        };
      });
      return { total: filtradas.length, contagens, a_caminho, itens };
    });
  }

  async atencao(tenantId: string) {
    const linhas = await this.db.withTenant(tenantId, async (db) => (await this.carregar(db)).linhas);
    const agora = Date.now();
    const abertas = linhas.filter((l) => l.status !== 'finalizada' && l.status !== 'com_a_plataforma');
    return {
      contestar: abertas.filter((l) => l.pendencias.includes('contestar')).length,
      chamados_manuais: abertas.filter((l) => l.pendencias.includes('chamado_manual')).length,
      lancar_estoque: abertas.filter((l) => l.pendencias.includes('lancar_estoque')).length,
      aguardando_conferencia: abertas.filter((l) => l.status === 'aguardando_conferencia').length,
      prazo_em_24h: abertas.filter((l) => l.prazo_vendedor && agora <= l.prazo_vendedor.getTime() && l.prazo_vendedor.getTime() <= agora + 86_400_000).length,
    };
  }

  async ultimas(tenantId: string, limite: number) {
    const linhas = await this.db.withTenant(tenantId, async (db) => (await this.carregar(db)).linhas);
    return linhas
      .sort((a, b) => b.atualizada_em.getTime() - a.atualizada_em.getTime())
      .slice(0, limite)
      .map((l) => ({
        id: l.id, plataforma: l.plataforma, pedido: l.pedido, pacote: l.pacote, rastreio: l.rastreio, id_externo: l.id_externo,
        status: l.status, itens: l.itens, atualizada_em: l.atualizada_em, motivo: l.motivo,
      }));
  }

  async devolucoes(tenantId: string, q: { plataforma?: string; etapa?: string; destino?: string; limit: number }) {
    if (q.plataforma && q.plataforma !== 'mercado_livre') return [];
    return this.db.withTenant(tenantId, async (db) => {
      const { linhas } = await this.carregar(db);
      return linhas
        .filter((l) => (!q.etapa || l.etapa === q.etapa) && (!q.destino || l.destino === q.destino))
        .sort((a, b) => b.atualizada_em.getTime() - a.atualizada_em.getTime())
        .slice(0, q.limit)
        .map(publico);
    });
  }

  async porRastreio(tenantId: string, codigo: string) {
    return this.db.withTenant(tenantId, async (db) => (await this.carregar(db, 'r.tracking = $1', [codigo.trim()])).linhas.map(publico));
  }

  // ================= B.I
  private perda(l: Linha, custos: Custos): [string | null, number | null] {
    const c = l.conferencia;
    if (c) return c.classe !== 'A' ? ['bancada', c.perda_produto] : [null, 0];
    if (DECLARADO_QUEBRADO.has(l.motivo) && l.etapa !== 'cancelada') return ['motivo', this.cmv(l, custos)];
    return [null, 0];
  }

  private cmv(l: Linha, custos: Custos): number | null {
    if (!l.itens.length) return null;
    let total = 0;
    for (const i of l.itens) {
      const c = custos.na(i.sku, l.aberta_em);
      if (c === null) return null;
      total += c * (i.quantidade || 1);
    }
    return r2(total);
  }

  private recuperado(l: Linha, custos: Custos): number {
    if (l.resultado_mediacao !== 'ganha') return 0;
    return r2((l.custo_plataforma ?? 0) + (l.cobertura_aplicada ? (this.cmv(l, custos) ?? 0) : 0));
  }

  private dinheiro(ls: Linha[], custos: Custos) {
    const d: Record<string, number> = {
      frete_reverso: 0, frete_cobrado: 0, frete_em_mediacao: 0, frete_estornado: 0, perda_bancada: 0, perda_motivo: 0, recuperado: 0,
    };
    let sem_custo = 0;
    for (const l of ls) {
      const frete = l.custo_plataforma ?? 0;
      d.frete_reverso! += frete;
      // em mediação = ainda pode cair; ganha = estornado; o resto já está sendo cobrado
      d[l.resultado_mediacao === 'em_andamento' ? 'frete_em_mediacao' : l.resultado_mediacao === 'ganha' ? 'frete_estornado' : 'frete_cobrado']! += frete;
      const [origem, valor] = this.perda(l, custos);
      if (origem && valor === null) sem_custo++;
      else if (origem) d[`perda_${origem}`]! += valor ?? 0;
      d.recuperado! += this.recuperado(l, custos);
    }
    // frete de mediação ganha não é pago: fica fora do custo (e fora do recuperado, senão desconta duas vezes)
    const bruto = d.frete_reverso! + d.perda_bancada! + d.perda_motivo!;
    const custo = bruto - d.frete_estornado!;
    return {
      ...Object.fromEntries(Object.entries(d).map(([k, v]) => [k, r2(v)])),
      custo_total: r2(custo),
      prejuizo_liquido: r2(custo - (d.recuperado! - d.frete_estornado!)),
      taxa_recuperacao: bruto ? r1((100 * d.recuperado!) / bruto) : 0,
      sem_custo,
    } as Record<string, number>;
  }

  private quebrados(ls: Linha[], custos: Custos) {
    const celulas = new Map<string, Map<string, { quantidade: number; valor: number; sem_custo: number }>>();
    for (const l of ls) {
      const [origem, valor] = this.perda(l, custos);
      if (!origem) continue;
      const tipo = origem === 'bancada' ? l.conferencia!.classe : l.motivo;
      const k = `${origem}|${tipo}`;
      const por = celulas.get(k) ?? new Map();
      const c = por.get(l.plataforma) ?? { quantidade: 0, valor: 0, sem_custo: 0 };
      c.quantidade++;
      if (valor === null) c.sem_custo++;
      else c.valor += valor;
      por.set(l.plataforma, c);
      celulas.set(k, por);
    }
    const soma = (cs: { quantidade: number; valor: number; sem_custo: number }[]) => ({
      quantidade: sum(cs.map((c) => c.quantidade)), valor: r2(sum(cs.map((c) => c.valor))), sem_custo: sum(cs.map((c) => c.sem_custo)),
    });
    const vazio = () => ({ quantidade: 0, valor: 0, sem_custo: 0 });
    const segmentos = SEGMENTOS.map(([origem, tipo, nome]) => {
      const por = Object.fromEntries(PLATAFORMAS.map((p) => [p, celulas.get(`${origem}|${tipo}`)?.get(p) ?? vazio()]));
      return {
        origem, tipo, nome,
        por_plataforma: Object.fromEntries(Object.entries(por).map(([p, c]) => [p, { ...c, valor: r2(c.valor) }])),
        ...soma(Object.values(por)),
      };
    });
    const de = (o?: string) => [...celulas.entries()].filter(([k]) => !o || k.startsWith(`${o}|`)).flatMap(([, ps]) => [...ps.values()]);
    return { segmentos, por_origem: { bancada: soma(de('bancada')), motivo: soma(de('motivo')) }, total: soma(de()) };
  }

  private contarLogistica(ls: Linha[], extra: Map<string, Extra>) {
    const por: Record<string, Record<string, number>> = Object.fromEntries(PLATAFORMAS.map((p) => [p, { full: 0, organica: 0, sem_info: 0 }]));
    for (const l of ls) {
      const t = extra.get(l.id)?.logistica;
      por[l.plataforma]![t == null ? 'sem_info' : FULL.has(t) ? 'full' : 'organica']!++;
    }
    return por;
  }

  async biResumo(tenantId: string, diasPedidos: number, fatura: string | null) {
    return this.db.withTenant(tenantId, async (db) => {
      const [ini, fimDia, iniAnt, fimAnt] = periodo(diasPedidos, fatura);
      const { linhas: todas, extra, custos } = await this.carregar(db);
      const atual = todas.filter((l) => entre(l, ini, fimDia));
      const anterior = todas.filter((l) => entre(l, iniAnt, fimAnt));
      const dias = Math.round((Date.parse(fimDia) - Date.parse(ini)) / 86_400_000) + 1;
      const hoje = utcDay(new Date());
      const fim = fimDia < hoje ? fimDia : hoje;
      const diasSerie = Math.round((Date.parse(fim) - Date.parse(ini)) / 86_400_000) + 1;

      const serie = new Map<string, Record<string, number>>();
      for (let n = diasSerie - 1; n >= 0; n--) serie.set(addDays(fim, -n), { total: 0, resolvidas: 0, em_aberto: 0, custo: 0, recuperado: 0 });
      const porPlataforma = new Map<string, Linha[]>();
      const motivos = new Map<string, number>();
      const produtos = new Map<string, Json>();
      const mediacoes = new Map<string, number>();
      const origens = new Map<string, number>();
      const atuacoes = new Map<string, number>();
      const mediacoesPlataforma: Record<string, Map<string, number>> = Object.fromEntries(PLATAFORMAS.map((p) => [p, new Map()]));
      const inc = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
      for (const l of atual) {
        porPlataforma.set(l.plataforma, [...(porPlataforma.get(l.plataforma) ?? []), l]);
        inc(motivos, l.motivo);
        const resultado = l.resultado_mediacao;
        if (resultado) {
          const x = extra.get(l.id);
          const quem = x?.aberta_por ?? 'sem_info';
          inc(origens, quem);
          // o gráfico é das mediações em que a empresa ATUOU (abriu, mandou prova ao mediador ou contestou a revisão)
          const atuou = x?.acoes == null ? undefined : x.acoes.split(',').some((a) => ACTED.has(a));
          const empresa = quem === 'vendedor' || atuou || l.contestada || Boolean(l.conferencia?.chamado_aberto_em);
          inc(atuacoes, empresa ? 'atuou' : x?.acoes == null ? 'sem_info' : 'nao_atuou');
          if (empresa) {
            inc(mediacoes, resultado);
            inc(mediacoesPlataforma[l.plataforma]!, resultado);
          }
        }
        const [, valor] = this.perda(l, custos);
        const custoLinha = (l.custo_plataforma ?? 0) + (valor ?? 0);
        const p = serie.get(utcDay(l.aberta_em));
        if (p) {
          p.total!++;
          p[RESOLVIDAS.has(l.status) ? 'resolvidas' : 'em_aberto']!++;
          p.custo! += custoLinha;
          p.recuperado! += this.recuperado(l, custos);
        }
        for (const i of l.itens) {
          const k = i.sku ?? i.item_id;
          if (!k) continue;
          const item = produtos.get(`${l.plataforma}|${k}`) ?? {
            sku: i.sku, nome: i.nome, imagem: i.imagem ?? null, item_id: i.item_id, plataforma: l.plataforma, quantidade: 0, prejuizo: 0,
          };
          item.quantidade++;
          item.prejuizo = r2(item.prejuizo + custoLinha);
          item.nome = item.nome ?? i.nome;
          produtos.set(`${l.plataforma}|${k}`, item);
        }
      }
      const top = Object.fromEntries(
        PLATAFORMAS.map((p) => [p, [...produtos.values()].filter((x) => x.plataforma === p).sort((a, b) => b.quantidade - a.quantidade || b.prejuizo - a.prejuizo).slice(0, 5)]),
      );
      const { porItem } = await this.fotos(db, Object.values(top).flat().map((x: Json) => x.item_id));
      for (const x of Object.values(top).flat() as Json[]) x.imagem = x.imagem ?? porItem.get(x.item_id) ?? null;
      const total = atual.length || 1;
      const dinheiroAtual = this.dinheiro(atual, custos);
      const porLogistica = MOTIVOS_LOGISTICA.map((m) => {
        const doMotivo = atual.filter((l) => l.motivo === m);
        return { motivo: m, quantidade: doMotivo.length, pct: r1((100 * doMotivo.length) / total), por_plataforma: this.contarLogistica(doMotivo, extra) };
      });
      const status: Record<string, number> = {};
      for (const l of atual) status[l.status] = (status[l.status] ?? 0) + 1;
      const pick = (m: Map<string, number>, ks: string[]) => Object.fromEntries(ks.map((k) => [k, m.get(k) ?? 0]));
      const RES = ['ganha', 'perdida', 'parcial', 'em_andamento'];
      return {
        dias, inicio: ini, fim: fimDia,
        total: atual.length,
        total_anterior: anterior.length,
        dinheiro: dinheiroAtual,
        dinheiro_anterior: this.dinheiro(anterior, custos),
        quebrados: this.quebrados(atual, custos),
        por_logistica: porLogistica,
        logistica_total: this.contarLogistica(atual, extra),
        a_caminho: aCaminhoPorPlataforma(atual),
        serie: [...serie.entries()].map(([dia, p]) => ({ dia, ...Object.fromEntries(Object.entries(p).map(([k, v]) => [k, r2(v)])) })),
        por_plataforma: Object.fromEntries([...porPlataforma.entries()].map(([k, v]) => [k, { devolucoes: v.length, ...this.dinheiro(v, custos) }])),
        status,
        motivos: [...motivos.entries()].sort((a, b) => b[1] - a[1]).map(([motivo, quantidade]) => ({ motivo, quantidade, pct: r1((100 * quantidade) / total) })),
        produtos: Object.fromEntries(
          Object.entries(top).map(([p, t]) => [p, (t as Json[]).map((x) => ({ ...x, pct: r1((100 * x.quantidade) / (porPlataforma.get(p)?.length || 1)) }))]),
        ),
        mediacoes: {
          ...pick(mediacoes, RES),
          recuperado: dinheiroAtual.recuperado,
          abertas_por: pick(origens, ['vendedor', 'comprador', 'plataforma', 'desconhecido', 'sem_info']),
          atuacao: pick(atuacoes, ['atuou', 'nao_atuou', 'sem_info']),
          por_plataforma: Object.fromEntries(PLATAFORMAS.map((p) => [p, pick(mediacoesPlataforma[p]!, RES)])),
        },
      };
    });
  }

  private async faturas(db: Queryable) {
    const { rows } = await db.query<{ invoice: string; kind: string; amount: string }>('SELECT invoice, kind, amount FROM ml_billing_returns');
    const saida = new Map<string, { cobrado: number; estornado: number; por_tipo: Map<string, number> }>();
    for (const t of rows) {
      const f = saida.get(t.invoice) ?? { cobrado: 0, estornado: 0, por_tipo: new Map() };
      const v = Number(t.amount);
      if (v >= 0) {
        f.cobrado += v;
        f.por_tipo.set(t.kind, (f.por_tipo.get(t.kind) ?? 0) + v);
      } else f.estornado -= v;
      saida.set(t.invoice, f);
    }
    return new Map(
      [...saida.entries()].map(([k, v]) => [k, {
        cobrado: r2(v.cobrado), estornado: r2(v.estornado), liquido: r2(v.cobrado - v.estornado),
        por_tipo: [...v.por_tipo.entries()].map(([tipo, valor]) => ({ tipo: CHARGES[tipo] ?? tipo, valor: r2(valor) })),
      }]),
    );
  }

  private calcularMes(chave: string, todas: Linha[], faturas: Map<string, Json>, custos: Custos) {
    const [ini, fim] = cycle(chave);
    const doCiclo = todas.filter((l) => entre(l, ini, fim));
    const v = { frete_shopee: 0, quebrado_bancada: 0, quebrado_motivo: 0 };
    let sem_custo = 0;
    for (const l of doCiclo) {
      if (l.plataforma === 'shopee') v.frete_shopee += l.custo_plataforma ?? 0;
      const [origem, valor] = this.perda(l, custos);
      if (origem && valor === null) sem_custo++;
      else if (origem) v[`quebrado_${origem}` as 'quebrado_bancada'] += valor ?? 0;
    }
    const ml = faturas.get(chave) ?? { cobrado: 0, estornado: 0, liquido: 0, por_tipo: [] };
    return {
      fatura: chave, inicio: ini, fim, aberto: fim >= utcDay(new Date()),
      frete_ml: ml, fatura_lida: faturas.has(chave),
      frete_shopee: r2(v.frete_shopee), quebrado_bancada: r2(v.quebrado_bancada), quebrado_motivo: r2(v.quebrado_motivo),
      sem_custo, total: r2(ml.liquido + v.frete_shopee + v.quebrado_bancada + v.quebrado_motivo),
      devolucoes: Object.fromEntries(PLATAFORMAS.map((p) => [p, doCiclo.filter((l) => l.plataforma === p).length])),
    };
  }

  /**
   * Quanto as devoluções custaram por ciclo da fatura do ML (13 ao 12). Ciclo fechado há mais de 7 dias com a fatura
   * lida vira fechamento gravado e é lido de lá (não recalcula).
   */
  async biMensal(tenantId: string, meses: number) {
    return this.db.withTenant(tenantId, async (db) => {
      const hoje = utcDay(new Date());
      const chaves = lastKeys(hoje, meses);
      const { rows } = await db.query<{ invoice: string; data: Json }>('SELECT invoice, data FROM return_month_close WHERE invoice = ANY($1)', [chaves]);
      const gravados = new Map(rows.map((r) => [r.invoice, r.data]));
      let base: { todas: Linha[]; faturas: Map<string, Json>; custos: Custos } | null = null;
      const saida = [];
      for (const chave of [...chaves].reverse()) {
        const g = gravados.get(chave);
        if (g) {
          saida.push({ ...g, fechado: true });
          continue;
        }
        base ??= { todas: (await this.carregar(db)).linhas, faturas: await this.faturas(db), custos: await Custos.load(db) };
        const mes = this.calcularMes(chave, base.todas, base.faturas, base.custos);
        const podeFechar = mes.fatura_lida && (Date.parse(hoje) - Date.parse(cycle(chave)[1])) / 86_400_000 > CARENCIA_FECHAMENTO_DIAS;
        if (podeFechar) await this.gravarMes(db, tenantId, chave, mes);
        saida.push({ ...mes, fechado: podeFechar });
      }
      return { meses: saida };
    });
  }

  private async gravarMes(db: Queryable, tenantId: string, chave: string, mes: Json) {
    await db.query(
      `INSERT INTO return_month_close (tenant_id, invoice, data) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, invoice) DO UPDATE SET data = EXCLUDED.data, closed_at = now()`,
      [tenantId, chave, JSON.stringify(mes)],
    );
  }

  /** "Refazer leitura" de um mês: relê as reclamações do ciclo e a fatura e regrava o fechamento, em segundo plano. */
  refazerMes(tenantId: string, fatura: string) {
    if (!this.sync) throw new ValidationError('Integração com o Mercado Livre não configurada neste ambiente');
    if (this.sync.isRunning(tenantId)) throw new ValidationError('Já tem uma sincronização rodando: espere terminar e tente de novo.');
    const dias = Math.max(1, (Date.now() - Date.parse(`${cycle(fatura)[0]}T00:00:00Z`)) / 86_400_000 + 1);
    const after = async () => {
      await this.db.withTenant(tenantId, async (db) => {
        const mes = this.calcularMes(fatura, (await this.carregar(db)).linhas, await this.faturas(db), await Custos.load(db));
        await this.gravarMes(db, tenantId, fatura, mes);
      });
    };
    void this.sync.syncTenant(tenantId, { days: dias, allOpen: false, redo: fatura, after }).catch(() => undefined);
    return { iniciado: true, fatura };
  }

  // ================= quebrados
  async produtosQuebrados(tenantId: string, dias: number, fatura: string | null) {
    return this.db.withTenant(tenantId, async (db) => {
      const [ini, fim] = periodo(dias, fatura);
      const { linhas, custos } = await this.carregar(db);
      const skus = new Map<string, Json>();
      for (const l of linhas.filter((x) => entre(x, ini, fim))) {
        const c = l.conferencia;
        if (!c || c.classe !== 'B') continue;
        const quando = c.conferida_em ?? l.aberta_em;
        // produto enviado por engano que voltou estragado conta no SKU que chegou — é ele que vai para a avaria
        const pecas: [string, Partial<Item>, number][] = c.erro_nosso && c.sku_recebido
          ? [[c.sku_recebido, {}, sum(l.itens.map((i) => i.quantidade || 0)) || 1]]
          : l.itens.map((i) => [i.sku ?? `anúncio ${i.item_id}`, i, i.quantidade || 1]);
        for (const [sku, item, qtd] of pecas) {
          const s = skus.get(sku) ?? {
            sku, nome: null, imagem: null, item_id: null, quantidade: 0, valor: 0, sem_custo: 0,
            ...Object.fromEntries(PLATAFORMAS.map((p) => [p, { quantidade: 0, valor: 0 }])),
          };
          s.nome = s.nome ?? item.nome ?? null;
          s.item_id = s.item_id ?? item.item_id ?? null;
          const custo = custos.na(sku, quando);
          s[l.plataforma].quantidade += qtd;
          s.quantidade += qtd;
          if (custo === null) s.sem_custo += qtd;
          else {
            s[l.plataforma].valor = r2(s[l.plataforma].valor + custo * qtd);
            s.valor = r2(s.valor + custo * qtd);
          }
          skus.set(sku, s);
        }
      }
      const lista = [...skus.values()].sort((a, b) => b.quantidade - a.quantidade || b.valor - a.valor);
      const { porItem, porSku } = await this.fotos(db, lista.map((s) => s.item_id), lista.map((s) => s.sku));
      for (const s of lista) {
        s.imagem = porSku.get(s.sku) ?? (s.item_id ? porItem.get(s.item_id) : null) ?? null;
        s.custo_atual = custos.de(s.sku);
      }
      return {
        inicio: ini, fim, produtos: lista,
        total: {
          quantidade: sum(lista.map((s) => s.quantidade)), valor: r2(sum(lista.map((s) => s.valor))), sem_custo: sum(lista.map((s) => s.sem_custo)),
          ...Object.fromEntries(PLATAFORMAS.map((p) => [p, { quantidade: sum(lista.map((s) => s[p].quantidade)), valor: r2(sum(lista.map((s) => s[p].valor))) }])),
        },
      };
    });
  }

  /** Devoluções que compõem o card Mercadoria quebrada (mesmo período e mesma regra): a soma bate com o card. */
  async quebradosLista(tenantId: string, dias: number, fatura: string | null) {
    return this.db.withTenant(tenantId, async (db) => {
      const [ini, fim] = periodo(dias, fatura);
      const { linhas, custos } = await this.carregar(db);
      const saida = [];
      for (const l of linhas.filter((x) => entre(x, ini, fim))) {
        const [origem, valor] = this.perda(l, custos);
        if (!origem) continue;
        saida.push({
          id: l.id, plataforma: l.plataforma, pedido: l.pedido, origem, motivo: l.motivo, valor, aberta_em: l.aberta_em,
          itens: l.itens.map((i) => ({ sku: i.sku, nome: i.nome, imagem: i.imagem ?? null, quantidade: i.quantidade || 1 })),
        });
      }
      saida.sort((a, b) => b.aberta_em.getTime() - a.aberta_em.getTime());
      return { inicio: ini, fim, devolucoes: saida };
    });
  }

  async custoHistorico(tenantId: string, sku: string) {
    return this.db.withTenant(tenantId, async (db) => {
      const { rows } = await db.query<{ custo: string | null; desde: string; registrado_em: Date; por: string | null }>(
        `SELECT h.custo_unit AS custo, to_char(h.vigente_desde, 'YYYY-MM-DD') AS desde, h.registrado_em,
                coalesce(h.registrado_por_nome, u.name) AS por
           FROM sku_cost_history h LEFT JOIN users u ON u.id = h.registrado_por
          WHERE upper(trim(h.sku)) = upper(trim($1)) AND h.custo_unit IS NOT NULL ORDER BY h.vigente_desde DESC, h.registrado_em DESC`,
        [sku.trim()],
      );
      // "desde sempre" no NVS é 1900-01-01; a tela marca "antes das mudanças" pelo 2000-01-01
      return rows.map((r) => ({ custo: Number(r.custo), vigente_desde: r.desde < '2000-01-01' ? '2000-01-01' : r.desde, registrado_em: r.registrado_em, registrado_por: r.por }));
    });
  }

  /** Custo novo do SKU valendo a partir de `desde`: as quebras de antes mantêm o custo antigo, as de depois são recalculadas. */
  async registrarCusto(a: ReturnActor & { userId: string }, sku: string, corpo: Json) {
    const custo = Number(corpo?.custo);
    if (corpo?.custo === null || corpo?.custo === undefined || corpo?.custo === '' || !Number.isFinite(custo)) throw new ValidationError('custo inválido');
    if (!(custo > 0 && custo < 1_000_000)) throw new ValidationError('custo deve ser maior que zero');
    const desde = this.diaValido(corpo?.desde || this.deps.today(), 'desde');
    const quem = await this.nomeOperador(a);
    // grava no SKU como ele está no Cadastro de SKUs (o da devolução pode vir com outra caixa de letra)
    const canonico = await this.db.withTenant(a.tenantId, async (db) =>
      (await db.query<{ sku: string }>('SELECT sku FROM sku_costs WHERE upper(trim(sku)) = upper(trim($1)) LIMIT 1', [sku])).rows[0]?.sku ?? sku.trim());
    const atual = await this.deps.saveCost(a.tenantId, a.userId, canonico, r2(custo), desde, quem);
    const recalculadas = await this.reprecificar(a.tenantId, canonico, desde);
    return { sku: canonico, custo_atual: atual, conferencias_recalculadas: recalculadas };
  }

  /** Refaz o prejuízo gravado das conferências feitas desde `desde` em que esse SKU é o que se perdeu. */
  private async reprecificar(tenantId: string, sku: string, desde: string) {
    return this.db.withTenant(tenantId, async (db) => {
      const inicio = new Date(`${desde}T00:00:00-03:00`);
      const { linhas } = await this.carregar(db, "c.checked_at >= $1 AND c.class IN ('B', 'C')", [inicio]);
      const custos = await Custos.load(db);
      let feitas = 0;
      for (const l of linhas) {
        const c = l.conferencia!;
        const perdido = c.classe === 'B' && c.erro_nosso ? c.sku_recebido : l.itens.find((i) => i.sku)?.sku;
        if (chaveSku(perdido ?? '') !== chaveSku(sku)) continue;
        const unit = custos.na(sku, c.conferida_em ?? new Date());
        const qtd = sum(l.itens.map((i) => i.quantidade || 0)) || 1;
        await db.query('UPDATE return_checks SET product_loss = $2 WHERE return_id = $1', [l.id, unit === null ? null : r2(unit * qtd)]);
        feitas++;
      }
      return feitas;
    });
  }

  // ================= conferência
  private async tela(db: Queryable, l: Linha) {
    const { porItem } = await this.fotos(db, l.itens.map((i) => i.item_id));
    const [c] = await this.repo.rows(db, 'r.id = $1', [l.id]);
    const ev = await db.query<{ id: string; kind: string; size: number; added_at: Date }>(
      'SELECT id, kind, size, added_at FROM return_evidence WHERE return_id = $1 ORDER BY added_at',
      [l.id],
    );
    const cf = l.conferencia;
    return {
      devolucao: publico(l),
      olist: OLIST_OFF,
      midia: {
        anuncio: l.itens.map((i) => ({ nome: i.nome, imagem: (i.item_id && porItem.get(i.item_id)) || null })),
        comprador: { fotos: [], videos: [] }, // no ML ficam na reclamação, atrás do login: vai pelo link
        link: `https://www.mercadolivre.com.br/vendas/${l.pacote ?? l.pedido}/detalhe`,
      },
      conferencia: cf && c && {
        id: l.id, devolucao_id: l.id, sku_recebido: c.c_sku_received, produto_correto: Boolean(c.c_product_correct), completo: Boolean(c.c_complete),
        sem_uso: Boolean(c.c_unused), revendavel: Boolean(c.c_resellable), erro_nosso: Boolean(c.c_our_error), observacao: c.c_note,
        classe: cf.classe, lancamentos: cf.lancamentos, contestar: cf.contestar, motivo: c.c_decision, conferida_em: cf.conferida_em,
        perda_produto: cf.perda_produto, frete_reverso: cf.frete_reverso, chamado_manual: cf.chamado_manual, chamado_aberto_em: cf.chamado_aberto_em,
        chamado_protocolo: cf.chamado_protocolo, estoque_lancado_em: cf.estoque_lancado_em, estoque_resultado: c.c_stock_result,
        evidencias_exigidas: cf.contestar || cf.chamado_manual ? ['foto'] : [],
      },
      evidencias: ev.rows.map((e) => ({ id: e.id, devolucao_id: l.id, tipo: e.kind, arquivo: e.id, tamanho: e.size, enviada_em: e.added_at })),
    };
  }

  /** Bipou: etiqueta, QR, DANFE, rastreio, pedido — o que vier. `etiqueta`: código não achado que fica vinculado. */
  async buscar(tenantId: string, codigo: string, etiqueta?: string) {
    const ids = await this.returns.resolveIds(tenantId, codigo, etiqueta);
    if (!ids.length) return [];
    return this.db.withTenant(tenantId, async (db) => {
      const { linhas } = await this.carregar(db, 'r.id = ANY($1)', [ids]);
      return Promise.all(linhas.map((l) => this.tela(db, l)));
    });
  }

  async registrar(a: ReturnActor, id: string, dados: Json) {
    for (const campo of ['produto_correto', 'completo', 'sem_uso', 'revendavel']) {
      if (typeof dados?.[campo] !== 'boolean') throw new ValidationError(`${campo} é obrigatório (true/false)`);
    }
    const erroNosso = dados.erro_nosso ?? false;
    if (typeof erroNosso !== 'boolean') throw new ValidationError('erro_nosso deve ser true/false');
    for (const campo of ['sku_recebido', 'observacao']) {
      if (dados[campo] != null && typeof dados[campo] !== 'string') throw new ValidationError(`${campo} deve ser texto`);
    }
    const input: ReturnCheckInput = {
      productCorrect: dados.produto_correto, complete: dados.completo, unused: dados.sem_uso, resellable: dados.revendavel,
      ourError: erroNosso, skuReceived: dados.sku_recebido?.trim() || undefined, note: dados.observacao?.trim() || undefined,
    };
    await this.returns.check(a, id, input);
    const nome = await this.nomeOperador(a);
    return this.db.withTenant(a.tenantId, async (db) => {
      const { linhas } = await this.carregar(db, 'r.id = $1', [id]);
      const l = linhas[0]!;
      const c = l.conferencia!;
      const [row] = await this.repo.rows(db, 'r.id = $1', [id]);
      await db.query(
        `INSERT INTO return_check_log (tenant_id, return_id, operator_id, operator_name, platform, order_id, class, dispute, manual_ticket)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [a.tenantId, id, a.operatorId, nome ?? '—', l.plataforma, l.pedido, c.classe, c.contestar, c.chamado_manual],
      );
      return {
        classe: c.classe, lancamentos: c.lancamentos, contestar: c.contestar, chamado_manual: c.chamado_manual, motivo: row?.c_decision ?? '',
        evidencias_exigidas: c.contestar || c.chamado_manual ? ['foto'] : [], prazo: l.prazo_vendedor,
        perda_produto: c.perda_produto, frete_reverso: c.frete_reverso, plataforma: l.plataforma, pedido: l.pedido,
      };
    });
  }

  /**
   * Clique do operador: executa os lançamentos decididos na conferência. Sem ERP, o vendável volta para o estoque do
   * anúncio no Mercado Livre e a avaria vai para o estoque virtual do sistema (ver ReturnStock). O que já deu certo numa
   * tentativa anterior não repete; o estoque só fica "lançado" (e trava) quando tudo deu certo.
   */
  async lancarEstoque(a: ReturnActor, id: string, viaOlist: boolean) {
    if (viaOlist) throw new ValidationError('Olist não conectada a esta empresa: lance o estoque pela Central.');
    const [r] = await this.db.withTenant(a.tenantId, (db) => this.repo.rows(db, 'r.id = $1', [id]));
    if (!r?.c_class) throw new NotFoundError(`Devolução ${id} ainda não foi conferida`);
    if (r.c_stock_done_at) {
      const quando = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(r.c_stock_done_at);
      throw new Travada(`Estoque já lançado em ${quando}.`);
    }
    const nome = await this.nomeOperador(a);
    const qtd = sum((r.items ?? []).map((i) => i.qty || 0)) || 1;
    const vendido = (r.items ?? []).find((i) => i.sku) ?? r.items?.[0];
    const anteriores = (r.c_stock_result ?? []) as Json[];
    const resultado: Json[] = [];
    for (const [n, lanc] of (conf(r)?.lancamentos ?? []).entries()) {
      if (anteriores[n]?.ok) {
        resultado.push(anteriores[n]); // já feito numa tentativa anterior: não repetir
        continue;
      }
      const sku = lanc.sku === 'vendido' ? (vendido?.sku ?? null) : r.c_sku_received;
      const item = { ...lanc, sku_olist: sku ?? (vendido?.itemId ? `anúncio ${vendido.itemId}` : null), produto_id: null, quantidade: qtd, pela_olist: false };
      try {
        const destino = await this.deps.stock.move(a.tenantId, {
          sku, itemId: lanc.sku === 'vendido' ? vendido?.itemId : null, variationId: lanc.sku === 'vendido' ? vendido?.variationId : null,
          deposit: lanc.deposito as 'vendavel' | 'avaria', delta: lanc.tipo === 'E' ? qtd : -qtd, origin: 'devolucao', reference: id, operatorName: nome,
        });
        resultado.push({ ...item, ok: true, destino, feitos: [] });
      } catch (err) {
        resultado.push({ ...item, ok: false, erro: (err as Error).message.slice(0, 300), feitos: [] });
        break;
      }
    }
    const tudo = resultado.length === (conf(r)?.lancamentos.length ?? 0) && resultado.every((x) => x.ok);
    await this.db.withTenant(a.tenantId, (db) =>
      db.query(`UPDATE return_checks SET stock_result = $2, stock_done_at = CASE WHEN $3 THEN now() ELSE NULL END WHERE return_id = $1`, [id, JSON.stringify(resultado), tudo]),
    );
    return resultado;
  }

  async chamadoManual(a: ReturnActor, id: string) {
    await this.returns.manualTicket(a, id, { open: false });
    return null;
  }

  async chamadoAberto(a: ReturnActor, id: string, dados: Json) {
    for (const campo of ['protocolo', 'observacao']) {
      if (dados?.[campo] != null && typeof dados[campo] !== 'string') throw new ValidationError(`${campo} deve ser texto`);
    }
    const d = await this.returns.manualTicket(a, id, { open: true, protocol: dados?.protocolo ?? '', note: dados?.observacao ?? '' });
    return { chamado_aberto_em: d.row.check?.ticketOpenedAt ? new Date(d.row.check.ticketOpenedAt) : null, chamado_protocolo: d.row.check?.ticketProtocol ?? null };
  }

  async salvarEvidencia(a: ReturnActor, id: string, tipoConteudo: string, bytes: Buffer) {
    const tipo = TIPOS_EVIDENCIA[tipoConteudo];
    if (!tipo) throw new ValidationError(`Tipo não aceito: ${tipoConteudo}. Envie foto (jpg/png/webp) ou vídeo (mp4/webm/mov).`);
    if (bytes.length > tipo[1] * 2 ** 20) throw new ValidationError(`${tipo[0]} maior que ${tipo[1]} MB`);
    return this.db.withTenant(a.tenantId, async (db) => {
      if (!(await db.query('SELECT 1 FROM returns WHERE id = $1', [id])).rowCount) throw new NotFoundError(`Devolução ${id} não existe`);
      const { rows } = await db.query<{ id: string; added_at: Date }>(
        'INSERT INTO return_evidence (tenant_id, return_id, mime, bytes, size, kind, added_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, added_at',
        [a.tenantId, id, tipoConteudo, bytes, bytes.length, tipo[0], a.operatorId],
      );
      // varredura barata: devolução parada há mais de 30 dias não vai mais a disputa
      await db.query(`DELETE FROM return_evidence WHERE added_at < now() - interval '30 days'`);
      return { id: rows[0]!.id, devolucao_id: id, tipo: tipo[0], arquivo: rows[0]!.id, tamanho: bytes.length, enviada_em: rows[0]!.added_at };
    });
  }

  async evidencia(tenantId: string, id: string) {
    return this.returns.evidenceFile(tenantId, id);
  }

  async excluirEvidencia(tenantId: string, id: string) {
    await this.returns.deleteEvidence(tenantId, id);
    return { ok: true };
  }

  // ================= devoluções do Full triadas pelo CD
  async triagensFull(tenantId: string, dias = 120) {
    return this.db.withTenant(tenantId, async (db) => {
      const { rows } = await db.query<{ id: string; order_id: string; pack_id: string | null; reason: string; items: ReturnRow['items']; review: Json }>(
        `SELECT r.id, r.order_id, r.pack_id, r.reason, r.items, r.raw->'review' AS review FROM returns r
          WHERE r.destination = 'cd_plataforma' AND r.opened_at >= $1
            AND NOT EXISTS (SELECT 1 FROM return_checks c WHERE c.return_id = r.id)
          ORDER BY r.opened_at DESC`,
        [new Date(Date.now() - dias * 86_400_000)],
      );
      const linhas = [];
      for (const r of rows) {
        let destino: string | null = null;
        let condicao: string | null = null;
        let triada: string | null = null;
        for (const rv of r.review?.reviews ?? []) {
          const rr = (rv.resource_reviews ?? []).find((x: Json) => x.product_destination);
          if (rr) {
            [destino, condicao, triada] = [rr.product_destination, rr.product_condition ?? null, rv.date_created ?? null];
            break;
          }
        }
        // "seller" + vendável = volta pro estoque do Full; só o não vendável sai do CD e chega na bancada
        if (destino !== 'seller' || condicao === 'saleable') continue;
        linhas.push({
          id: r.id, pedido: r.order_id, pacote: r.pack_id, condicao, triada_em: triada, motivo: r.reason, imagem: null as string | null,
          itens: (r.items ?? []).map((i) => ({ nome: i.name, sku: i.sku, item_id: i.itemId, quantidade: i.qty })),
        });
      }
      const { porItem } = await this.fotos(db, linhas.flatMap((l) => l.itens.map((i) => i.item_id)));
      for (const l of linhas) l.imagem = l.itens.map((i) => i.item_id && porItem.get(i.item_id)).find(Boolean) ?? null;
      return linhas;
    });
  }

  // ================= mediações
  private contestacao(d: Json) {
    return {
      id: d.id, devolucao_id: d.return_id, motivo: d.reason, texto: d.message, ok: d.ok, caminho: d.path, anexos: d.attachments ?? [],
      aviso: d.warning, erro: d.error, enviada_em: d.sent_at,
    };
  }

  async historicoMediacao(tenantId: string, id: string) {
    return this.db.withTenant(tenantId, async (db) =>
      (await db.query('SELECT * FROM return_disputes WHERE return_id = $1 ORDER BY sent_at', [id])).rows.map((d) => this.contestacao(d)),
    );
  }

  private async ultimaContestacao(tenantId: string, id: string) {
    const h = await this.historicoMediacao(tenantId, id);
    return h[h.length - 1]!;
  }

  async motivos(tenantId: string, id: string) {
    return (await this.returns.disputeReasons(tenantId, id)).map((m) => ({ id: m.id, texto: m.text }));
  }

  async contestar(a: ReturnActor, id: string, dados: Json) {
    const motivo = dados?.motivo ?? '';
    const texto = dados?.texto;
    if (typeof motivo !== 'string' || typeof texto !== 'string' || texto.length < 10 || texto.length > 2000) {
      throw new ValidationError('texto deve ter entre 10 e 2000 caracteres');
    }
    await this.returns.dispute(a, id, { reason: motivo, message: texto });
    return this.ultimaContestacao(a.tenantId, id);
  }

  async aceitar(a: ReturnActor, id: string) {
    await this.returns.accept(a, id);
    return this.ultimaContestacao(a.tenantId, id);
  }

  /** Conferidas aqui, com o "Já revisei" ainda aberto no ML (última sincronização) e nada enviado pela Central. */
  async pendentesRevisao(tenantId: string, dias: number) {
    return this.db.withTenant(tenantId, async (db) => {
      const { linhas } = await this.carregar(db, 'c.checked_at >= $1', [new Date(Date.now() - dias * 86_400_000)]);
      const rows = new Map((await this.repo.rows(db, 'c.checked_at >= $1', [new Date(Date.now() - dias * 86_400_000)])).map((r) => [r.id, r]));
      return linhas
        .filter((l) => !l.contestada && !l.id_externo.startsWith('envio-') && l.aguarda_revisao)
        .map((l) => ({
          id: l.id, id_externo: l.id_externo, pedido: l.pedido, classe: l.conferencia!.classe, contestar: l.conferencia!.contestar,
          chamado_manual: l.conferencia!.chamado_manual, motivo: rows.get(l.id)?.c_decision ?? '', prazo_vendedor: l.prazo_vendedor,
          conferida_em: l.conferencia!.conferida_em,
        }));
    });
  }

  // ================= respostas prontas
  async respostas(tenantId: string) {
    return (await this.returns.replies(tenantId)).map((r) => ({ id: r.id, texto: r.text }));
  }

  private textoResposta(texto: unknown) {
    const t = typeof texto === 'string' ? texto.trim() : '';
    if (!t) throw new ValidationError('texto não pode ser vazio');
    if (t.length > 500) throw new ValidationError('texto deve ter até 500 caracteres');
    return t;
  }

  async criarResposta(tenantId: string, texto: unknown) {
    const r = await this.returns.addReply(tenantId, this.textoResposta(texto));
    return { id: r.id, texto: r.text };
  }

  async editarResposta(tenantId: string, id: string, texto: unknown) {
    const t = this.textoResposta(texto);
    return this.db.withTenant(tenantId, async (db) => {
      const { rows } = await db.query<{ id: string; text: string }>('UPDATE return_replies SET text = $2 WHERE id = $1 RETURNING id, text', [id, t]);
      if (!rows[0]) throw new NotFoundError(`Resposta pronta ${id} não existe`);
      return { id: rows[0].id, texto: rows[0].text };
    });
  }

  async excluirResposta(tenantId: string, id: string) {
    await this.db.withTenant(tenantId, (db) => db.query('DELETE FROM return_replies WHERE id = $1', [id]));
    return { ok: true };
  }

  // ================= operadores
  diaValido(texto: string, nome: string) {
    if (!DIA.test(texto ?? '')) throw new ValidationError(`Parâmetro ${nome} inválido: '${texto}'`);
    if (!('2000-01-02' <= texto && texto <= this.deps.today())) throw new ValidationError(`${nome} precisa ser uma data entre 2000 e hoje`);
    return texto;
  }

  /** Log de conferências do dia (de Brasília): quem fez, quando, de qual plataforma. O status vem ao vivo. */
  async atividade(tenantId: string, diaPedido: string | undefined) {
    const dia = this.diaValido(diaPedido || this.deps.today(), 'dia');
    const inicio = new Date(`${dia}T00:00:00-03:00`);
    return this.db.withTenant(tenantId, async (db) => {
      const { rows } = await db.query<{ operator_name: string; created_at: Date; return_id: string | null; platform: string; order_id: string | null; class: string; dispute: boolean }>(
        `SELECT operator_name, created_at, return_id, platform, order_id, class, dispute FROM return_check_log
          WHERE created_at >= $1 AND created_at < $2 ORDER BY created_at DESC`,
        [inicio, new Date(inicio.getTime() + 86_400_000)],
      );
      const status = rows.length ? new Map((await this.carregar(db)).linhas.map((l) => [l.id, l.status])) : new Map<string, string>();
      const por_operador: Record<string, { total: number; por_plataforma: Record<string, number> }> = {};
      const itens = rows.map((r) => {
        const o = (por_operador[r.operator_name] ??= { total: 0, por_plataforma: {} });
        o.total++;
        o.por_plataforma[r.platform] = (o.por_plataforma[r.platform] ?? 0) + 1;
        return {
          operador: r.operator_name, horario: r.created_at, plataforma: r.platform, pedido: r.order_id, classe: r.class, contestar: r.dispute,
          status: (r.return_id && status.get(r.return_id)) || r.class,
        };
      });
      return { dia, total: itens.length, por_operador, itens };
    });
  }

  private async nomeOperador(a: ReturnActor) {
    return this.db.withTenant(a.tenantId, async (db) => (await db.query<{ name: string }>('SELECT name FROM operators WHERE id = $1', [a.operatorId])).rows[0]?.name ?? null);
  }

  // ================= retirada do Full
  /** Etiqueta do Full (inventory_id do anúncio) → SKU pelo Master Data da Supervisão Full, anúncio e custo. */
  async identificarFull(tenantId: string, bruto: string) {
    const codigo = bruto.trim().toUpperCase();
    if (!ETIQUETA_FULL.test(codigo)) throw new ValidationError(`'${bruto}' não é uma etiqueta do Full (4 letras + 5 números).`);
    return this.db.withTenant(tenantId, async (db) => {
      const { rows } = await db.query<{ sku: string }>(
        `SELECT DISTINCT upper(sku) AS sku FROM (
           SELECT sku FROM wms_barcodes WHERE upper(barcode) = $1
           UNION ALL SELECT sku FROM wms_items WHERE upper(ml_code) = $1) x`,
        [codigo],
      );
      if (!rows.length) {
        throw new NotFoundError(`Etiqueta ${codigo} não bate com nenhum anúncio Full. Cadastre o código no Master Data da Supervisão Full e bipe de novo.`);
      }
      if (rows.length > 1) throw new ValidationError(`Etiqueta ${codigo} está ligada a mais de um SKU (${rows.map((r) => r.sku).join(', ')}): corrija no Master Data.`);
      const sku = rows[0]!.sku;
      const { rows: an } = await db.query<{ external_id: string; title: string; picture_url: string | null }>(
        `SELECT external_id, title, picture_url FROM listings WHERE upper(sku) = $1 OR $1 = ANY(variation_skus)
          ORDER BY (logistic_type = 'fulfillment') DESC NULLS LAST, (status = 'active') DESC, updated_at DESC LIMIT 1`,
        [sku],
      );
      const desc = an[0] ? null : (await db.query<{ description: string | null }>('SELECT description FROM wms_products WHERE upper(sku) = $1', [sku])).rows[0]?.description;
      const custo = (await db.query<{ c: string }>('SELECT custo_unit AS c FROM sku_costs WHERE upper(sku) = $1 LIMIT 1', [sku])).rows[0]?.c;
      return { codigo, item_id: an[0]?.external_id ?? null, titulo: an[0]?.title ?? desc ?? sku, thumbnail: an[0]?.picture_url ?? null, sku, produto_id: null, custo: num(custo) };
    });
  }

  async entradaFull(a: ReturnActor, codigo: string, quantidade: unknown) {
    if (typeof quantidade !== 'number' || !Number.isInteger(quantidade) || quantidade < 1 || quantidade > 999) {
      throw new ValidationError('Quantidade deve ser um número inteiro entre 1 e 999.');
    }
    const p = await this.identificarFull(a.tenantId, codigo);
    const nome = await this.nomeOperador(a);
    // volta para o anúncio orgânico (fora do Full) do mesmo SKU; sem ele, para o estoque virtual vendável
    const destino = await this.deps.stock.move(a.tenantId, {
      sku: p.sku, deposit: 'vendavel', delta: quantidade, origin: 'retorno_full', reference: p.codigo, operatorName: nome,
    });
    await this.db.withTenant(a.tenantId, (db) =>
      db.query(
        `INSERT INTO full_withdrawals (tenant_id, code, item_id, title, thumbnail, sku, quantity, unit_cost, operator_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [a.tenantId, p.codigo, p.item_id, p.titulo, p.thumbnail, p.sku, quantidade, p.custo, nome],
      ),
    );
    return { ...p, quantidade, lancados: [{ sku: p.sku, quantidade, destino }] };
  }

  /** Aba Retorno do Full: o que voltou no período (dia de Brasília), por produto e bipe a bipe. */
  async retornosFull(tenantId: string, dias: number, fatura: string | null) {
    const [ini, fim] = periodo(dias, fatura);
    return this.db.withTenant(tenantId, async (db) => {
      const { rows } = await db.query<Json>(
        `SELECT code, item_id, title, thumbnail, sku, quantity, unit_cost, operator_name, created_at FROM full_withdrawals
          WHERE created_at >= $1 AND created_at <= $2 ORDER BY created_at DESC`,
        [new Date(`${ini}T00:00:00-03:00`), new Date(`${fim}T23:59:59.999-03:00`)],
      );
      const bipes = rows.map((r) => ({
        codigo: r.code, item_id: r.item_id, titulo: r.title, thumbnail: r.thumbnail, sku: r.sku, quantidade: r.quantity,
        custo_unitario: num(r.unit_cost), operador: r.operator_name, criado_em: r.created_at,
      }));
      const produtos = new Map<string, Json>();
      for (const b of bipes) {
        // mais recente primeiro: o primeiro de cada SKU é o último retorno
        const p = produtos.get(b.sku) ?? { sku: b.sku, titulo: b.titulo, thumbnail: b.thumbnail, item_id: b.item_id, quantidade: 0, bipes: 0, valor: 0, sem_custo: 0, ultimo: b.criado_em };
        p.quantidade += b.quantidade;
        p.bipes++;
        if (b.custo_unitario === null) p.sem_custo += b.quantidade;
        else p.valor = r2(p.valor + b.custo_unitario * b.quantidade);
        produtos.set(b.sku, p);
      }
      const lista = [...produtos.values()].sort((a, b) => b.quantidade - a.quantidade || b.valor - a.valor);
      return {
        inicio: ini, fim, produtos: lista, bipes: bipes.slice(0, 200),
        total: { quantidade: sum(lista.map((p) => p.quantidade)), bipes: bipes.length, valor: r2(sum(lista.map((p) => p.valor))), skus: lista.length },
      };
    });
  }

  // ================= estoque virtual (sem ERP: avaria, divergente e vendável sem anúncio próprio)
  async estoqueVirtual(tenantId: string) {
    return this.db.withTenant(tenantId, async (db) => {
      const { rows } = await db.query<{ sku: string; vendavel: number; avaria: number; ultimo: Date }>(
        `SELECT sku, coalesce(sum(quantity) FILTER (WHERE deposit = 'vendavel'), 0)::int AS vendavel,
                coalesce(sum(quantity) FILTER (WHERE deposit = 'avaria'), 0)::int AS avaria, max(created_at) AS ultimo
           FROM virtual_stock_moves GROUP BY sku ORDER BY max(created_at) DESC`,
      );
      const skus = rows.map((r) => r.sku);
      const { rows: an } = await db.query<{ sku: string; title: string; picture_url: string | null }>(
        `SELECT DISTINCT ON (upper(sku)) upper(sku) AS sku, title, picture_url FROM listings
          WHERE upper(sku) = ANY(SELECT upper(x) FROM unnest($1::text[]) x) ORDER BY upper(sku), (status = 'active') DESC`,
        [skus],
      );
      const { rows: wp } = await db.query<{ sku: string; description: string | null }>(
        'SELECT upper(sku) AS sku, description FROM wms_products WHERE upper(sku) = ANY(SELECT upper(x) FROM unnest($1::text[]) x)',
        [skus],
      );
      const anuncio = new Map(an.map((a) => [a.sku, a]));
      const descricao = new Map(wp.map((w) => [w.sku, w.description]));
      const custos = await Custos.load(db);
      const lista = rows.map((r) => {
        const a = anuncio.get(r.sku.toUpperCase());
        const custo = custos.de(r.sku);
        return {
          sku: r.sku, nome: a?.title ?? descricao.get(r.sku.toUpperCase()) ?? null, imagem: a?.picture_url ?? null,
          vendavel: r.vendavel, avaria: r.avaria, custo,
          valor_vendavel: custo === null ? null : r2(custo * r.vendavel), valor_avaria: custo === null ? null : r2(custo * r.avaria), ultimo_em: r.ultimo,
        };
      });
      const { rows: mv } = await db.query<Json>(
        `SELECT id, sku, deposit, quantity, origin, reference, operator_name, created_at FROM virtual_stock_moves ORDER BY created_at DESC LIMIT 150`,
      );
      return {
        skus: lista.filter((x) => x.vendavel !== 0 || x.avaria !== 0),
        zerados: lista.filter((x) => x.vendavel === 0 && x.avaria === 0).length,
        total: {
          vendavel: sum(lista.map((x) => x.vendavel)), avaria: sum(lista.map((x) => x.avaria)),
          valor_vendavel: r2(sum(lista.map((x) => x.valor_vendavel ?? 0))), valor_avaria: r2(sum(lista.map((x) => x.valor_avaria ?? 0))),
          sem_custo: lista.filter((x) => x.custo === null && (x.vendavel || x.avaria)).length,
        },
        movimentos: mv.map((m: Json) => ({
          id: m.id, sku: m.sku, deposito: m.deposit, quantidade: m.quantity, origem: m.origin, referencia: m.reference,
          operador: m.operator_name, criado_em: m.created_at,
        })),
      };
    });
  }

  private async saldoVirtual(db: Queryable, sku: string, deposito: string) {
    return (await db.query<{ n: number }>('SELECT coalesce(sum(quantity), 0)::int AS n FROM virtual_stock_moves WHERE sku = $1 AND deposit = $2', [sku, deposito])).rows[0]!.n;
  }

  /** Ajuste manual (descarte, venda da avaria, contagem) ou transferência entre depósitos (ex.: consertou → vendável). */
  async ajusteVirtual(a: ReturnActor, dados: Json) {
    const sku = typeof dados?.sku === 'string' ? dados.sku.trim() : '';
    const motivo = typeof dados?.motivo === 'string' ? dados.motivo.trim() : '';
    const qtd = dados?.quantidade;
    const de = dados?.deposito;
    const para = dados?.para ?? null;
    if (!sku) throw new ValidationError('Informe o SKU.');
    if (!['vendavel', 'avaria'].includes(de) || (para !== null && (!['vendavel', 'avaria'].includes(para) || para === de))) throw new ValidationError('Depósito inválido.');
    if (typeof qtd !== 'number' || !Number.isInteger(qtd) || qtd === 0 || Math.abs(qtd) > 9999 || (para !== null && qtd < 0)) {
      throw new ValidationError('Quantidade deve ser um número inteiro diferente de zero.');
    }
    if (motivo.length < 3 || motivo.length > 200) throw new ValidationError('Diga o motivo do ajuste (3 a 200 letras).');
    const nome = await this.nomeOperador(a);
    const saida = para !== null ? -qtd : qtd;
    const saldo = await this.db.withTenant(a.tenantId, (db) => this.saldoVirtual(db, sku, de));
    if (saida < 0 && saldo + saida < 0) throw new ValidationError(`Saldo insuficiente de ${sku} no ${de === 'avaria' ? 'estoque de avaria' : 'estoque vendável'}.`);
    // transferência: o vendável volta para o anúncio próprio no ML quando existe (senão, vendável virtual).
    // Primeiro o destino: se o ML recusar, a avaria continua como estava.
    const destino = para === null ? null : await this.deps.stock.move(a.tenantId, {
      sku, deposit: para, delta: qtd, origin: 'ajuste', reference: motivo, operatorName: nome,
    });
    await this.db.withTenant(a.tenantId, (db) =>
      db.query(
        `INSERT INTO virtual_stock_moves (tenant_id, sku, deposit, quantity, origin, reference, operator_name) VALUES ($1,$2,$3,$4,'ajuste',$5,$6)`,
        [a.tenantId, sku, de, saida, motivo, nome],
      ),
    );
    return this.db.withTenant(a.tenantId, async (db) => ({
      sku, destino, vendavel: await this.saldoVirtual(db, sku, 'vendavel'), avaria: await this.saldoVirtual(db, sku, 'avaria'),
    }));
  }

  // ================= sincronização
  async sincronizacao(tenantId: string) {
    const estado = this.sync?.progress.state(tenantId) ?? {};
    const ml = estado.mercado_livre ?? (await this.ultimaSincronizacao(tenantId));
    return {
      ...estado,
      ...(ml ? { mercado_livre: ml } : {}),
      shopee: { ok: false, erro: 'Shopee não integrada ao NVS Tech', em: null, resultado: null },
    };
  }

  private async ultimaSincronizacao(tenantId: string) {
    const r = await this.db.withTenant(tenantId, (db) => db.query<{ last_sync: Date; last_result: Json }>('SELECT last_sync, last_result FROM return_sync_state'));
    const s = r.rows[0];
    return s ? { ok: true, erro: null, em: s.last_sync, resultado: s.last_result } : null;
  }

  async progresso(tenantId: string) {
    const estado = this.sync?.progress.state(tenantId) ?? {};
    const p = this.sync?.progress.get(tenantId);
    const base = p ?? { refazendo: null, varredura: false, rodando: false, tarefa: null, tarefas: [], feitas: 0, fracao: 0, iniciada_em: null, terminada_em: null };
    const terminada = base.terminada_em ?? (base.rodando ? null : (await this.ultimaSincronizacao(tenantId))?.em ?? null);
    // a barra mostra a hora com new Date(iso): vai com fuso (como o original), senão aparece em UTC
    return {
      ...base,
      iniciada_em: base.iniciada_em ? base.iniciada_em.toISOString() : null,
      terminada_em: terminada ? new Date(terminada).toISOString() : null,
      percentual: this.sync?.progress.percent(tenantId) ?? 0,
      erro: estado.mercado_livre && !estado.mercado_livre.ok ? estado.mercado_livre.erro : null,
      pendentes: Object.fromEntries(['mediacao_origem', 'mediacao_atuacao'].map((t) => [t, Number((estado[t]?.resultado as Json)?.faltam ?? 0)])),
    };
  }

  sincronizarMl(tenantId: string, dias: number, todasAbertas: boolean) {
    if (!this.sync) throw new ValidationError('Integração com o Mercado Livre não configurada neste ambiente');
    void this.sync.syncTenant(tenantId, { days: dias, allOpen: todasAbertas }).catch(() => undefined);
    return { iniciado: true };
  }
}
