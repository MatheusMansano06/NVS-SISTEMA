import { unitMargin, type CategoryOptionDto, type FeeQuoteDto, type PricingQuoteDto, type PricingSimulationDto } from '@nvs/shared';
import type { Database, Queryable } from '../../../shared/infrastructure/database.js';
import { AppError, NotFoundError } from '../../../shared/kernel/errors.js';
import { typeLabel } from '../domain/listing-margin.js';
import { MlApiError, type MlApi } from '../infrastructure/ml-api.js';
import type { MlIntegrationService } from './ml-integration-service.js';

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Precificador: tarifa real do ML (Clássico/Premium) para qualquer preço e categoria — com ou sem anúncio —
 * e simulações salvas por empresa.
 */
export class PricingService {
  constructor(
    private readonly db: Database,
    private readonly ml: MlIntegrationService,
    private readonly api: MlApi,
  ) {}

  /** Token de qualquer conta ativa da empresa (as tarifas são as mesmas para o site MLB). */
  private async anyToken(tenantId: string) {
    const status = await this.ml.status(tenantId);
    const c = status.connections.find((x) => x.status === 'active');
    if (!c) throw new AppError('Conecte uma conta do Mercado Livre para consultar as tarifas.', 'LISTING_BLOCKED', 409);
    return (await this.ml.accessToken(tenantId, c.id)).token;
  }

  async quote(tenantId: string, price: number, categoryId?: string): Promise<PricingQuoteDto> {
    const token = await this.anyToken(tenantId);
    const fees = await this.wrap(() => this.api.listingFees(token, price, categoryId ?? null));
    const out: FeeQuoteDto[] = (['gold_special', 'gold_pro'] as const).flatMap((type) => {
      const f = fees.find((x) => x.listing_type_id === type);
      if (!f) return [];
      const pct = f.sale_fee_details?.percentage_fee ?? null;
      const fee = round2(f.sale_fee_amount);
      return [{ type, label: typeLabel(type)!, fee, feePct: pct, fixedFee: round2(f.sale_fee_details?.fixed_fee ?? (pct !== null ? Math.max(0, fee - (price * pct) / 100) : 0)) }];
    });
    return { price, categoryId: categoryId ?? null, fees: out };
  }

  async categories(tenantId: string, q: string): Promise<CategoryOptionDto[]> {
    const token = await this.anyToken(tenantId);
    const r = await this.wrap(() => this.api.searchCategories(token, q));
    return r.map((c) => ({ id: c.category_id, name: c.category_name, domain: c.domain_name ?? null }));
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
