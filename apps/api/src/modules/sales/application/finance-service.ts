import {
  DEFAULT_LOW_MARGIN_PCT,
  marginBand,
  type LowMarginDto,
  type FinanceCards,
  type FinanceLineDto,
  type FinanceLinesDto,
  type FinanceLinesQuery,
  type FinanceQuery,
  type FinanceSummaryDto,
  type LogisticBucketId,
  type SaleStatus,
  type TaxImpactDto,
  type TaxImpactItemDto,
} from '@nvs/shared';
import type { Cache } from '../../../shared/kernel/cache.js';
import type { Database, Queryable } from '../../../shared/infrastructure/database.js';
import { contributionMargin, keepsBuyerFreight } from '../domain/contribution.js';
import type { DreSales } from '../domain/dre.js';
import { TIMEZONE } from '../domain/period.js';

interface Row {
  id: string;
  external_id: string;
  status: 'paid' | 'cancelled' | 'returned';
  day: string;
  produto: string;
  tarifa: string;
  fc: string;
  fv: string;
  cupom: string;
  devolucao: string;
  custo: string;
  imposto: string;
  cost_known: boolean;
  bucket: LogisticBucketId;
  listing_type: string | null;
  freight_uncertain: boolean;
  enriched: boolean;
  items: { sku: string; title: string; qty: number; price: number; listing_id: string | null; known: boolean }[];
  pictures: Record<string, string> | null;
}

interface Computed {
  row: Row;
  status: SaleStatus;
  certified: boolean;
  produto: number;
  fc: number;
  fv: number;
  tarifa: number;
  cupom: number;
  devolucao: number;
  custo: number;
  imposto: number;
  mc: number;
  mcPct: number;
  faturamentoLinha: number;
}

const n = Number;
const q2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Preço unitário que devolve a margem % de antes já com a alíquota nova.
 * Imposto e tarifa crescem junto com o preço (mesma proporção de hoje); custo e frete ficam fixos.
 * null quando nenhum preço chega lá (imposto + tarifa + margem ≥ 100%).
 */
function precoParaMargem(produto: number, base: number, tarifa: number, mcAntes: number, mcDepois: number, para: number, unidades: number) {
  if (produto <= 0 || unidades <= 0) return null;
  const variavel = ((base * para) / 100 + tarifa) / produto;
  const fixo = produto * (1 - variavel) - mcDepois;
  const sobra = 1 - variavel - mcAntes / produto;
  return sobra > 0.01 && fixo > 0 ? q2(fixo / sobra / unidades) : null;
}
const CACHE_TTL = 30;

/**
 * Análise Financeira (port do NVS-WMS financeiro_ml.aggregator):
 * - aprovada / cancelada / devolução parcial;
 * - MC só com vendas que têm custo (as demais aparecem em "ficaram fora por falta de custo");
 * - frete vendedor conta em aprovadas, canceladas e devoluções; frete comprador só nas aprovadas;
 * - composição (custo, imposto, tarifa, frete, MC) sobre a base da MC.
 */
export class FinanceService {
  constructor(
    private readonly db: Database,
    private readonly cache: Cache,
  ) {}

  async summary(tenantId: string, q: FinanceQuery): Promise<FinanceSummaryDto> {
    const orders = await this.computed(tenantId, q);
    const adSpend = await this.adSpend(tenantId, q);
    const c = { aprov: 0, canc: 0, dev: 0, qA: 0, qC: 0, qD: 0, units: 0, fc: 0, fv: 0, tarifa: 0, cupom: 0 };
    const cert = { custo: 0, imposto: 0, mc: 0, base: 0, qtd: 0, tarifa: 0, fv: 0 };
    const sem = { qtd: 0, valor: 0, skus: new Set<string>() };
    const buckets = new Map<LogisticBucketId, number>();
    const days = new Map<string, { aprovadas: number; mc: number; certified: number }>();
    let freteIncerto = 0;
    let pendente = 0;

    for (const o of orders) {
      const card = o.produto - o.cupom - (o.status === 'devolucao' ? o.devolucao : 0);
      const units = o.row.items.reduce((s, i) => s + i.qty, 0);
      if (o.row.freight_uncertain) freteIncerto++;
      if (!o.row.enriched) pendente++;
      c.fv += o.fv; // frete vendedor é custo real mesmo em cancelado/devolvido
      if (o.status === 'cancelada') {
        c.canc += card;
        c.cupom += o.cupom;
        c.qC++;
        continue;
      }
      c.fc += o.fc;
      c.tarifa += o.tarifa;
      c.cupom += o.cupom;
      if (o.status === 'devolucao') {
        c.dev += card;
        c.qD++;
      } else {
        c.aprov += card;
        c.qA++;
        c.units += units;
        buckets.set(o.row.bucket, (buckets.get(o.row.bucket) ?? 0) + card);
      }
      const d = days.get(o.row.day) ?? { aprovadas: 0, mc: 0, certified: 0 };
      if (o.status === 'aprovada') d.aprovadas += card;
      if (o.certified) {
        cert.custo += o.custo;
        cert.imposto += o.imposto;
        cert.mc += o.mc;
        d.mc += o.mc;
        d.certified++;
        if (o.status === 'aprovada') {
          cert.base += card;
          cert.qtd++;
          cert.tarifa += o.tarifa;
          cert.fv += o.fv;
        }
      } else {
        sem.qtd++;
        sem.valor += card;
        for (const it of o.row.items) if (!it.known) sem.skus.add(it.sku);
      }
      days.set(o.row.day, d);
    }

    const anyCertified = cert.qtd > 0 || orders.some((o) => o.certified && o.status !== 'cancelada');
    const cards: FinanceCards = {
      vendasAprovadas: q2(c.aprov),
      vendasCanceladas: q2(c.canc),
      devolucoesParciais: q2(c.dev),
      faturamento: q2(c.aprov + c.canc + c.dev),
      custoTotal: anyCertified ? q2(cert.custo) : null,
      impostoTotal: anyCertified ? q2(cert.imposto) : null,
      tarifa: q2(c.tarifa),
      freteComprador: q2(c.fc),
      freteVendedor: q2(c.fv),
      cupomSeller: q2(c.cupom),
      mcTotal: anyCertified ? q2(cert.mc) : null,
      mcPct: cert.base > 0 ? q2((cert.mc / cert.base) * 100) : null,
      ticketMedio: c.qA ? q2(c.aprov / c.qA) : 0,
      ticketMc: cert.qtd ? q2(cert.mc / cert.qtd) : null,
      qtdAprovadas: c.qA,
      qtdCanceladas: c.qC,
      qtdDevolucoes: c.qD,
      unidades: c.units,
    };
    const pct = (v: number) => (cert.base > 0 ? q2((v / cert.base) * 100) : 0);
    // composição só com vendas que têm custo: as fatias somam 100% da base da MC
    const composicao: FinanceSummaryDto['composicao'] =
      cert.base > 0
        ? [
            { key: 'custo', label: 'Custo', valor: q2(cert.custo), pct: pct(cert.custo) },
            { key: 'imposto', label: 'Imposto', valor: q2(cert.imposto), pct: pct(cert.imposto) },
            { key: 'tarifa', label: 'Tarifa', valor: q2(cert.tarifa), pct: pct(cert.tarifa) },
            { key: 'frete', label: 'Frete', valor: q2(cert.fv), pct: pct(cert.fv) },
            { key: 'mc', label: 'MC', valor: q2(cert.mc), pct: pct(cert.mc) },
          ]
        : [];

    return {
      range: { from: q.from, to: q.to },
      cards,
      composicao,
      series: fillDays(q.from, q.to).map((day) => {
        const d = days.get(day);
        return { day, aprovadas: q2(d?.aprovadas ?? 0), mc: d && d.certified ? q2(d.mc) : null };
      }),
      semCusto: { qtd: sem.qtd, valor: q2(sem.valor), skus: [...sem.skus].slice(0, 30) },
      breakdown: [...buckets.entries()].map(([bucket, valor]) => ({ bucket, valor: q2(valor) })).sort((a, b) => b.valor - a.valor),
      adSpend: q2(adSpend),
      freteIncerto,
      enriquecimentoPendente: pendente,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Totais do mês para o DRE, com as mesmas regras da MC: canceladas só pesam no frete do vendedor; o frete comprador
   * entra na receita quando o vendedor recebe e paga o frete. Vendas sem custo: custo e imposto estimados pela
   * proporção média das vendas com custo.
   */
  async dreSales(tenantId: string, q: FinanceQuery): Promise<DreSales> {
    const s: DreSales = {
      receitaBruta: 0, cupom: 0, devolucao: 0, imposto: 0, custo: 0, custoEstimado: 0, impostoEstimado: 0,
      tarifa: 0, freteVendedor: 0, pedidos: 0, unidades: 0, semCustoQtd: 0, semCustoValor: 0,
      canceladasQtd: 0, canceladasValor: 0, produtoTotal: 0,
    };
    const cert = { produto: 0, custo: 0, imposto: 0 };
    const semCusto = { produto: 0, semImposto: 0 };
    for (const o of await this.computed(tenantId, q)) {
      s.freteVendedor += o.fv;
      s.produtoTotal += o.produto;
      if (o.status === 'cancelada') {
        s.canceladasQtd++;
        s.canceladasValor += o.produto;
        continue;
      }
      s.receitaBruta += o.produto + (keepsBuyerFreight(o.row.bucket, q.considerarFreteComprador) ? o.fc : 0);
      s.cupom += o.cupom;
      s.devolucao += o.devolucao;
      s.tarifa += o.tarifa;
      s.pedidos++;
      s.unidades += o.row.items.reduce((a, i) => a + i.qty, 0);
      if (o.certified) {
        s.custo += o.custo;
        s.imposto += o.imposto;
        cert.produto += o.produto;
        cert.custo += o.custo;
        cert.imposto += o.imposto;
      } else {
        s.imposto += o.imposto; // a alíquota pode existir mesmo sem custo
        s.semCustoQtd++;
        s.semCustoValor += o.produto - o.cupom - o.devolucao;
        semCusto.produto += o.produto;
        if (o.imposto === 0) semCusto.semImposto += o.produto;
      }
    }
    if (cert.produto > 0) {
      s.custoEstimado = (cert.custo / cert.produto) * semCusto.produto;
      s.impostoEstimado = (cert.imposto / cert.produto) * semCusto.semImposto;
    }
    for (const k of Object.keys(s) as (keyof DreSales)[]) s[k] = q2(s[k]);
    return s;
  }

  /** Alerta do Dashboard: vendas aprovadas com custo e margem de contribuição abaixo do mínimo da empresa. */
  async lowMargin(tenantId: string, q: FinanceQuery, limit = 50): Promise<LowMarginDto> {
    const minPct = await this.lowMarginPct(tenantId);
    const orders = await this.computed(tenantId, q);
    const approved = orders.filter((o) => o.status === 'aprovada');
    const low = approved.filter((o) => o.certified && o.mcPct < minPct).sort((a, b) => a.mcPct - b.mcPct);
    const gap = low.reduce((s, o) => s + Math.max(0, (minPct / 100) * o.produto - o.mc), 0);
    return {
      minPct,
      total: low.length,
      gap: q2(gap),
      semCusto: approved.filter((o) => !o.certified).length,
      items: low.slice(0, limit).map((o) => {
        const first = o.row.items[0];
        return {
          orderId: o.row.external_id,
          date: o.row.day,
          title: first ? (o.row.items.length > 1 ? `${first.title} (+${o.row.items.length - 1})` : first.title) : '—',
          sku: first?.sku ?? '—',
          pictureUrl: (first?.listing_id && o.row.pictures?.[first.listing_id]) || null,
          bucket: o.row.bucket,
          faturamento: q2(o.faturamentoLinha),
          mc: q2(o.mc),
          mcPct: o.mcPct,
        };
      }),
    };
  }

  /**
   * Simulador de imposto por produto: refaz a MC das vendas aprovadas com custo trocando a alíquota "de" pela "para".
   * O imposto incide sobre produto − cupom (mesma base do recálculo da alíquota). Valores do pedido rateados pela quantidade.
   */
  async taxImpact(tenantId: string, q: FinanceQuery, sim: { de?: number; para?: number }): Promise<TaxImpactDto> {
    const { rows: rates } = await this.db.withTenant(tenantId, (db) =>
      db.query<{ rate_pct: string }>('SELECT rate_pct FROM tax_rate_history ORDER BY vigente_desde DESC, registrado_em DESC LIMIT 20'),
    );
    const atual = rates[0] ? n(rates[0].rate_pct) : null;
    const anterior = rates.map((r) => n(r.rate_pct)).find((r) => r !== atual) ?? atual ?? 0;
    const para = sim.para ?? atual ?? 0;
    const de = sim.de ?? anterior;

    const orders = (await this.computed(tenantId, q)).filter((o) => o.status === 'aprovada');
    const bySku = new Map<string, TaxImpactItemDto & { produto: number; tarifa: number }>();
    for (const o of orders.filter((x) => x.certified)) {
      const base = Math.max(o.produto - o.cupom, 0);
      const semImposto = o.mc + o.imposto;
      const antes = semImposto - (base * de) / 100;
      const depois = semImposto - (base * para) / 100;
      const units = Math.max(1, o.row.items.reduce((s, i) => s + i.qty, 0));
      for (const it of o.row.items) {
        const share = it.qty / units;
        const cur = bySku.get(it.sku) ?? {
          sku: it.sku, title: it.title, pictureUrl: null, unidades: 0, vendas: 0, faturamento: 0, produto: 0, tarifa: 0,
          mcAntes: 0, mcDepois: 0, mcPctAntes: 0, mcPctDepois: 0, impacto: 0, precoMedio: 0, precoSugerido: null,
        };
        cur.pictureUrl ??= (it.listing_id && o.row.pictures?.[it.listing_id]) || null;
        cur.unidades += it.qty;
        cur.vendas++;
        cur.faturamento += base * share;
        cur.produto += o.produto * share;
        cur.tarifa += o.tarifa * share;
        cur.mcAntes += antes * share;
        cur.mcDepois += depois * share;
        bySku.set(it.sku, cur);
      }
    }
    const items = [...bySku.values()].map(({ produto, tarifa, ...i }) => ({
      ...i,
      precoMedio: q2(produto / i.unidades),
      precoSugerido: precoParaMargem(produto, i.faturamento, tarifa, i.mcAntes, i.mcDepois, para, i.unidades),
      faturamento: q2(i.faturamento),
      mcAntes: q2(i.mcAntes),
      mcDepois: q2(i.mcDepois),
      mcPctAntes: produto > 0 ? q2((i.mcAntes / produto) * 100) : 0,
      mcPctDepois: produto > 0 ? q2((i.mcDepois / produto) * 100) : 0,
      impacto: q2(i.mcDepois - i.mcAntes),
    }));
    items.sort((a, b) => a.impacto - b.impacto);
    const sum = (k: 'faturamento' | 'mcAntes' | 'mcDepois') => q2(items.reduce((s, i) => s + i[k], 0));
    return {
      de,
      para,
      atual,
      resumo: {
        faturamento: sum('faturamento'),
        mcAntes: sum('mcAntes'),
        mcDepois: sum('mcDepois'),
        produtos: items.length,
        viraramPrejuizo: items.filter((i) => i.mcAntes >= 0 && i.mcDepois < 0).length,
      },
      items,
      semCusto: orders.filter((o) => !o.certified).length,
    };
  }

  async lowMarginPct(tenantId: string): Promise<number> {
    const { rows } = await this.db.withTenant(tenantId, (db) =>
      db.query<{ pct: string }>('SELECT low_margin_pct AS pct FROM dashboard_settings'),
    );
    return rows[0] ? Number(rows[0].pct) : DEFAULT_LOW_MARGIN_PCT;
  }

  async setLowMarginPct(tenantId: string, pct: number): Promise<{ pct: number }> {
    await this.db.withTenant(tenantId, (db) =>
      db.query(
        `INSERT INTO dashboard_settings (tenant_id, low_margin_pct) VALUES ($1, $2)
         ON CONFLICT (tenant_id) DO UPDATE SET low_margin_pct = EXCLUDED.low_margin_pct, updated_at = now()`,
        [tenantId, pct],
      ),
    );
    return { pct };
  }

  /** Tabela linha a linha (item de pedido), com valores do pedido rateados pela quantidade. */
  async lines(tenantId: string, q: FinanceQuery, f: FinanceLinesQuery): Promise<FinanceLinesDto> {
    const all = this.toLines(await this.computed(tenantId, q));
    const term = f.q?.toLowerCase();
    const sku = f.sku?.toLowerCase();
    const pedido = f.pedido?.toUpperCase();
    const custo = f.custo ?? (f.semCusto ? 'sem_custo' : undefined);
    const filtered = all.filter(
      (l) =>
        (!f.status || l.status === f.status) &&
        (!f.bucket || l.bucket === f.bucket) &&
        (!f.listingType || l.listingType === f.listingType) &&
        (!custo || (custo === 'sem_custo' ? l.mc === null : l.mc !== null)) &&
        (!sku || l.sku.toLowerCase().includes(sku)) &&
        (!pedido || l.orderId.includes(pedido) || (l.listingId ?? '').toUpperCase().includes(pedido)) &&
        (!f.margem || (l.mcPct !== null && marginBand(l.mcPct) === f.margem)) &&
        (!term || l.sku.toLowerCase().includes(term) || l.title.toLowerCase().includes(term) || l.orderId.includes(term)),
    );
    if (f.ordem) {
      const dir = f.ordem === 'mc_desc' ? -1 : 1;
      filtered.sort((a, b) => (a.mcPct === null ? 1 : b.mcPct === null ? -1 : dir * (a.mcPct - b.mcPct)));
    }
    return { items: filtered.slice(f.offset, f.offset + f.limit), total: filtered.length };
  }

  async exportCsv(tenantId: string, q: FinanceQuery, f: FinanceLinesQuery): Promise<string> {
    const { items } = await this.lines(tenantId, q, { ...f, offset: 0, limit: 1_000_000 });
    const br = (v: number | null) => (v === null ? '' : v.toFixed(2).replace('.', ','));
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const out = ['pedido;data;status;frete;sku;titulo;valor_unit;qtd;faturamento;cupom;custo;imposto;tarifa;frete_comprador;frete_vendedor;mc;mc_pct'];
    for (const l of items) {
      out.push(
        [esc(l.orderId), l.date, l.status, l.bucket, esc(l.sku), esc(l.title), br(l.valorUnit), l.qtd, br(l.faturamento),
          br(l.cupom), br(l.custo), br(l.imposto), br(l.tarifa), br(l.freteComprador), br(l.freteVendedor), br(l.mc), br(l.mcPct)].join(';'),
      );
    }
    return '﻿' + out.join('\r\n');
  }

  private toLines(orders: Computed[]): FinanceLineDto[] {
    const lines: FinanceLineDto[] = [];
    for (const o of orders) {
      const units = Math.max(1, o.row.items.reduce((s, i) => s + i.qty, 0));
      for (const it of o.row.items) {
        const share = it.qty / units;
        lines.push({
          orderId: o.row.external_id,
          listingId: it.listing_id,
          listingType: o.row.listing_type,
          date: o.row.day,
          status: o.status,
          bucket: o.row.bucket,
          sku: it.sku,
          title: it.title,
          pictureUrl: (it.listing_id && o.row.pictures?.[it.listing_id]) || null,
          valorUnit: q2(it.price),
          qtd: it.qty,
          faturamento: q2(o.faturamentoLinha * share),
          cupom: q2(o.cupom * share),
          custo: o.certified ? q2(o.custo * share) : null,
          imposto: o.certified ? q2(o.imposto * share) : null,
          tarifa: q2(o.tarifa * share),
          freteComprador: q2(o.fc * share),
          freteVendedor: q2(o.fv * share),
          mc: o.certified ? q2(o.mc * share) : null,
          mcPct: o.certified ? o.mcPct : null,
        });
      }
    }
    return lines;
  }

  /** Investido em Mercado Ads no período (só Mercado Livre; respeita o filtro de conta), igual ao Dashboard. */
  private async adSpend(tenantId: string, q: FinanceQuery): Promise<number> {
    if (q.marketplace && q.marketplace !== 'mercado_livre') return 0;
    const { rows } = await this.db.withTenant(tenantId, (db) =>
      db.query<{ cost: string }>(
        `SELECT coalesce(sum(cost), 0) AS cost FROM ad_spend_daily
          WHERE day BETWEEN $1::date AND $2::date AND ($3::uuid IS NULL OR account_id = $3)`,
        [q.from, q.to, q.accountId ?? null],
      ),
    );
    return n(rows[0]?.cost ?? 0);
  }

  /** Pedidos do período com MC calculada (cache curto, invalidado quando custos mudam). */
  private async computed(tenantId: string, q: FinanceQuery): Promise<Computed[]> {
    const version = (await this.cache.get<number>(`dash-version:${tenantId}`)) ?? 0;
    const key = `fin:${tenantId}:${version}:${q.from}:${q.to}:${q.marketplace ?? '*'}:${q.accountId ?? '*'}:${q.considerarFreteComprador ? 'fc' : ''}`;
    if (!q.fresh) {
      const hit = await this.cache.get<Computed[]>(key);
      if (hit) return hit;
    }
    const rows = await this.db.withTenant(tenantId, (db) => this.fetch(db, q));
    const result = rows.map((row): Computed => {
      const status: SaleStatus =
        row.status === 'cancelled' ? 'cancelada' : row.status === 'returned' || n(row.devolucao) > 0 ? 'devolucao' : 'aprovada';
      const v = {
        produto: n(row.produto),
        freteComprador: n(row.fc),
        freteVendedor: n(row.fv),
        custo: n(row.custo),
        imposto: n(row.imposto),
        tarifa: n(row.tarifa),
        cupom: n(row.cupom),
        devolucao: status === 'devolucao' ? n(row.devolucao) : 0,
        bucket: row.bucket,
      };
      const m = contributionMargin(v, q.considerarFreteComprador);
      return {
        row,
        status,
        certified: row.cost_known,
        produto: v.produto,
        fc: v.freteComprador,
        fv: v.freteVendedor,
        tarifa: v.tarifa,
        cupom: v.cupom,
        devolucao: v.devolucao,
        custo: v.custo,
        imposto: v.imposto,
        ...m,
      };
    });
    await this.cache.set(key, result, CACHE_TTL);
    return result;
  }

  private async fetch(db: Queryable, q: FinanceQuery): Promise<Row[]> {
    const { rows } = await db.query<Row>(
      `SELECT o.id, o.external_id, o.status,
              to_char((o.ordered_at AT TIME ZONE '${TIMEZONE}')::date, 'YYYY-MM-DD') AS day,
              o.gross_amount AS produto, o.marketplace_fee AS tarifa, o.buyer_shipping AS fc, o.shipping_cost AS fv,
              o.coupon_seller AS cupom, o.refund_partial AS devolucao, o.product_cost AS custo, o.tax_amount AS imposto,
              o.cost_known OR o.source = 'demo' AS cost_known, o.logistic_bucket AS bucket, o.listing_type, o.freight_uncertain,
              (o.finance_enriched_at IS NOT NULL OR o.source = 'demo') AS enriched,
              coalesce(json_agg(json_build_object('sku', i.sku, 'title', i.title, 'qty', i.quantity, 'price', i.unit_price,
                         'listing_id', i.listing_id, 'known', i.unit_cost IS NOT NULL OR o.source = 'demo'))
                         FILTER (WHERE i.id IS NOT NULL), '[]') AS items,
              (SELECT json_object_agg(l.external_id, l.picture_url) FROM listings l
                WHERE l.external_id = ANY(array_agg(i.listing_id)) AND l.picture_url IS NOT NULL) AS pictures
         FROM orders o LEFT JOIN order_items i ON i.order_id = o.id
        WHERE o.ordered_at >= ($1::date)::timestamp AT TIME ZONE '${TIMEZONE}'
          AND o.ordered_at <  ($2::date + 1)::timestamp AT TIME ZONE '${TIMEZONE}'
          AND ($3::text IS NULL OR o.marketplace = $3)
          AND ($4::uuid IS NULL OR o.account_id = $4)
        GROUP BY o.id
        ORDER BY o.ordered_at DESC`,
      [q.from, q.to, q.marketplace ?? null, q.accountId ?? null],
    );
    return rows;
  }
}

function fillDays(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end && out.length < 400) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
