import {
  FREE_SHIPPING_MIN_PRICE,
  unitMargin,
  type CategoryInfoDto,
  type CategoryLevelDto,
  type CategoryNodeDto,
  type CategoryOptionDto,
  type FeeQuoteDto,
  type FreightQuoteDto,
  type PricingQuoteDto,
  type PricingSimulationDto,
} from '@nvs/shared';
import type { Database, Queryable } from '../../../shared/infrastructure/database.js';
import { AppError, NotFoundError } from '../../../shared/kernel/errors.js';
import { typeLabel } from '../domain/listing-margin.js';
import { MlApiError, type MlApi } from '../infrastructure/ml-api.js';
import type { CategoryRow, PgCategoryCache } from '../infrastructure/pg-category-cache.js';
import type { CachedMlLookups } from '../infrastructure/cached-ml-lookups.js';
import type { MlIntegrationService } from './ml-integration-service.js';

const round2 = (n: number) => Math.round(n * 100) / 100;
const STALE_MS = 7 * 86_400_000; // categorias e % de tarifa mudam pouco
const REF_PRICE = 100; // preço de referência para mostrar a % de cada categoria
const num = (v: string | null) => (v === null ? null : Number(v));

const toNode = (r: CategoryRow): CategoryNodeDto => ({
  id: r.category_id,
  name: r.name,
  leaf: r.leaf,
  feeClassic: num(r.fee_classic),
  feePremium: num(r.fee_premium),
});

/**
 * Precificador: tarifa real do ML (Clássico/Premium) para qualquer preço e categoria — com ou sem anúncio —
 * e simulações salvas por empresa.
 */
export class PricingService {
  constructor(
    private readonly db: Database,
    private readonly ml: MlIntegrationService,
    private readonly api: MlApi,
    private readonly cache: PgCategoryCache,
    private readonly lookups: CachedMlLookups,
  ) {}

  /** Token de qualquer conta ativa da empresa (as tarifas são as mesmas para o site MLB). */
  private async anyToken(tenantId: string) {
    return (await this.anySession(tenantId)).token;
  }

  private async anySession(tenantId: string) {
    const status = await this.ml.status(tenantId);
    const c = status.connections.find((x) => x.status === 'active');
    if (!c) throw new AppError('Conecte uma conta do Mercado Livre para consultar as tarifas.', 'LISTING_BLOCKED', 409);
    const { token, conn } = await this.ml.accessToken(tenantId, c.id);
    return { token, sellerId: conn.ml_user_id };
  }

  // ================= Categorias (cache global, 7 dias)

  /** Um nível da árvore: raiz (sem `parentId`) ou as filhas de uma categoria, com a % de tarifa de cada uma. */
  async categoryLevel(tenantId: string, parentId?: string): Promise<CategoryLevelDto> {
    const token = await this.anyToken(tenantId);
    let path: { id: string; name: string }[] = [];
    let children: { id: string; name: string }[];
    if (parentId) {
      const parent = await this.wrap(() => this.api.category(token, parentId));
      path = parent.path_from_root ?? [{ id: parent.id, name: parent.name }];
      children = parent.children_categories ?? [];
    } else {
      children = await this.wrap(() => this.api.siteCategories(token));
    }
    const items = await this.ensure(token, children.map((c) => c.id), children, parentId ?? null, path);
    return { path, items };
  }

  async categoryInfo(tenantId: string, id: string): Promise<CategoryInfoDto> {
    const token = await this.anyToken(tenantId);
    const [node] = await this.ensure(token, [id], [], null, null);
    const row = (await this.cache.get([id])).get(id)!;
    let dims = row.dims;
    if (!dims) {
      dims = await this.api.categoryDimensions(token, id).catch(() => null);
      if (dims) await this.cache.upsert({ ...row, dims });
    }
    return { ...node!, path: row.path, dims };
  }

  /**
   * Garante no cache (e devolve) as categorias pedidas: nome, caminho, se é folha e a % de tarifa.
   * Só consulta o ML para o que falta ou venceu; 4 chamadas por vez para respeitar o limite.
   */
  private async ensure(
    token: string,
    ids: string[],
    known: { id: string; name: string }[],
    parentId: string | null,
    parentPath: { id: string; name: string }[] | null,
  ): Promise<CategoryNodeDto[]> {
    const cached = await this.cache.get(ids);
    const fresh = (r: CategoryRow | undefined) =>
      r && r.leaf !== null && r.fee_classic !== null && Date.now() - r.fetched_at.getTime() < STALE_MS;
    const missing = ids.filter((id) => !fresh(cached.get(id)));
    const queue = [...missing];
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        const [cat, fees] = await Promise.all([
          this.api.category(token, id).catch(() => null),
          this.api.listingFees(token, REF_PRICE, id).catch(() => []),
        ]);
        const pctOf = (t: string) => fees.find((f) => f.listing_type_id === t)?.sale_fee_details?.percentage_fee ?? null;
        const name = cat?.name ?? known.find((k) => k.id === id)?.name ?? id;
        await this.cache.upsert({
          category_id: id,
          name,
          parent_id: parentId ?? cat?.path_from_root?.at(-2)?.id ?? null,
          path: cat?.path_from_root ?? [...(parentPath ?? []), { id, name }],
          leaf: cat ? !(cat.children_categories?.length ?? 0) : null,
          fee_classic: pctOf('gold_special') === null ? null : String(pctOf('gold_special')),
          fee_premium: pctOf('gold_pro') === null ? null : String(pctOf('gold_pro')),
          dims: null,
        });
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    const all = missing.length ? await this.cache.get(ids) : cached;
    return ids.flatMap((id) => {
      const r = all.get(id);
      return r ? [toNode(r)] : [];
    });
  }

  /**
   * Frete do vendedor para as medidas informadas (com o desconto da reputação da conta). No Brasil o frete
   * grátis é obrigatório a partir de R$ 79; abaixo disso o comprador paga e o custo do vendedor é zero.
   */
  async freight(
    tenantId: string,
    q: { price: number; type: 'gold_special' | 'gold_pro'; height: number; width: number; length: number; weight: number; categoryId?: string },
  ): Promise<FreightQuoteDto> {
    const free = q.price >= FREE_SHIPPING_MIN_PRICE;
    if (!free) return { freight: 0, freeShipping: false, source: 'none' };
    const { token, sellerId } = await this.anySession(tenantId);
    const cost = await this.wrap(() =>
      this.lookups.freightByDimensions(token, tenantId, sellerId, {
        dimensions: `${Math.ceil(q.height)}x${Math.ceil(q.width)}x${Math.ceil(q.length)},${q.weight}`,
        price: q.price,
        type: q.type,
        freeShipping: true,
        categoryId: q.categoryId,
      }),
    );
    if (cost === null) throw new AppError('O Mercado Livre não calculou o frete para essas medidas.', 'MARKETPLACE_ERROR', 502);
    return { freight: round2(cost), freeShipping: true, source: 'ml' };
  }

  async quote(tenantId: string, price: number, categoryId?: string): Promise<PricingQuoteDto> {
    const token = await this.anyToken(tenantId);
    const fees = await this.wrap(() => this.lookups.listingFees(token, price, categoryId ?? null));
    const out: FeeQuoteDto[] = (['gold_special', 'gold_pro'] as const).flatMap((type) => {
      const f = fees.find((x) => x.listing_type_id === type);
      if (!f) return [];
      const pct = f.sale_fee_details?.percentage_fee ?? null;
      const fee = round2(f.sale_fee_amount);
      return [{ type, label: typeLabel(type)!, fee, feePct: pct, fixedFee: round2(f.sale_fee_details?.fixed_fee ?? (pct !== null ? Math.max(0, fee - (price * pct) / 100) : 0)) }];
    });
    return { price, categoryId: categoryId ?? null, fees: out };
  }

  async categories(tenantId: string, q: string): Promise<(CategoryOptionDto & CategoryNodeDto)[]> {
    const token = await this.anyToken(tenantId);
    const r = await this.wrap(() => this.api.searchCategories(token, q));
    const nodes = await this.ensure(token, r.map((c) => c.category_id), r.map((c) => ({ id: c.category_id, name: c.category_name })), null, null);
    return r.map((c) => {
      const n = nodes.find((x) => x.id === c.category_id);
      return {
        id: c.category_id,
        name: c.category_name,
        domain: c.domain_name ?? null,
        leaf: n?.leaf ?? true,
        feeClassic: n?.feeClassic ?? null,
        feePremium: n?.feePremium ?? null,
      };
    });
  }

  async simulations(tenantId: string): Promise<PricingSimulationDto[]> {
    return this.db.withTenant(tenantId, async (db: Queryable) => {
      const { rows } = await db.query<{
        id: string; listing_id: string | null; title: string; sku: string | null; listing_type: 'gold_special' | 'gold_pro';
        price: string; cost: string | null; freight: string; tax_pct: string; fee: string; margin: string | null;
        margin_pct: string | null; created_at: Date; current_price: string | null;
      }>(
        `SELECT s.*, l.price AS current_price
           FROM pricing_simulations s
           LEFT JOIN listings l ON l.external_id = s.listing_id AND l.marketplace = 'mercado_livre'
          ORDER BY s.created_at DESC LIMIT 200`,
      );
      const num = (v: string | null) => (v === null ? null : Number(v));
      return rows.map((r) => ({
        id: r.id,
        listingId: r.listing_id,
        title: r.title,
        sku: r.sku,
        listingType: r.listing_type,
        price: Number(r.price),
        cost: num(r.cost),
        freight: Number(r.freight),
        taxPct: Number(r.tax_pct),
        fee: Number(r.fee),
        margin: num(r.margin),
        marginPct: num(r.margin_pct),
        createdAt: r.created_at.toISOString(),
        currentPrice: num(r.current_price),
      }));
    });
  }

  async save(
    tenantId: string,
    userId: string,
    s: { listingId?: string; title: string; sku?: string; listingType: 'gold_special' | 'gold_pro'; price: number; cost: number | null; freight: number; taxPct: number; fee: number },
  ) {
    // a margem é recalculada aqui (mesma regra do resto do sistema), não confiada ao navegador
    const m = unitMargin({ price: s.price, fee: s.fee, freight: s.freight, cost: s.cost, taxPct: s.taxPct, source: 'live' });
    const id = await this.db.withTenant(tenantId, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO pricing_simulations (tenant_id, listing_id, title, sku, listing_type, price, cost, freight, tax_pct, fee, margin, margin_pct, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
        [tenantId, s.listingId ?? null, s.title, s.sku ?? null, s.listingType, s.price, s.cost, s.freight, s.taxPct, s.fee, m.amount, m.pct, userId],
      );
      return rows[0]!.id;
    });
    return { id, margin: m.amount, marginPct: m.pct };
  }

  async remove(tenantId: string, id: string) {
    const n = await this.db.withTenant(tenantId, async (db) => (await db.query('DELETE FROM pricing_simulations WHERE id = $1', [id])).rowCount);
    if (!n) throw new NotFoundError('Simulação não encontrada');
  }

  private async wrap<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof MlApiError) throw new AppError(`Mercado Livre: ${err.message}`, 'MARKETPLACE_ERROR', err.status === 401 ? 401 : 502);
      throw err;
    }
  }
}
