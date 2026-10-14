import type { Database } from '../../../shared/infrastructure/database.js';
import { ValidationError } from '../../../shared/kernel/errors.js';
import type { MlIntegrationService, MlRawApi } from '../../mercado-livre/index.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export type Deposit = 'vendavel' | 'avaria';
export interface StockMove {
  sku: string | null;
  itemId?: string | null;
  variationId?: string | null;
  deposit: Deposit;
  delta: number; // entrada positiva, saída negativa
  origin: 'devolucao' | 'retorno_full';
  reference: string;
  operatorName: string | null;
}

/**
 * Para onde vai o estoque que volta, sem ERP ligado: produto vendável volta para o estoque do próprio anúncio no
 * Mercado Livre (na variação do SKU); avaria — e vendável sem anúncio próprio fora do Full — vai para o estoque
 * virtual do sistema. Retorna onde foi parar, para a tela mostrar.
 */
export class ReturnStock {
  constructor(
    private readonly db: Database,
    private readonly ml: MlIntegrationService,
    private readonly api: MlRawApi | null,
  ) {}

  async move(tenantId: string, m: StockMove): Promise<string> {
    if (m.deposit === 'vendavel') {
      const onMl = await this.adjustListing(tenantId, m);
      if (onMl) return onMl;
    }
    return this.virtual(tenantId, m);
  }

  private async virtual(tenantId: string, m: StockMove): Promise<string> {
    const sku = m.sku ?? (m.itemId ? `anúncio ${m.itemId}` : null);
    if (!sku) throw new ValidationError('Produto sem SKU nem anúncio: não dá para lançar no estoque virtual.');
    const saldo = await this.db.withTenant(tenantId, async (db) => {
      await db.query(
        `INSERT INTO virtual_stock_moves (tenant_id, sku, deposit, quantity, origin, reference, operator_name) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [tenantId, sku, m.deposit, m.delta, m.origin, m.reference, m.operatorName],
      );
      const { rows } = await db.query<{ n: number }>('SELECT coalesce(sum(quantity), 0)::int AS n FROM virtual_stock_moves WHERE sku = $1 AND deposit = $2', [sku, m.deposit]);
      return rows[0]!.n;
    });
    return `Estoque virtual · ${m.deposit === 'avaria' ? 'avaria' : 'vendável'} ${sku} (saldo ${saldo})`;
  }

  /** null = não há anúncio próprio (fora do Full) para esse produto: fica no estoque virtual. */
  private async adjustListing(tenantId: string, m: StockMove): Promise<string | null> {
    if (!this.api) return null;
    const listing = await this.db.withTenant(tenantId, async (db) => {
      // o anúncio vendido, se não for Full; senão outro anúncio próprio do mesmo SKU (ativo primeiro)
      const { rows } = await db.query<{ external_id: string; account_id: string }>(
        `SELECT external_id, account_id FROM listings
          WHERE marketplace = 'mercado_livre' AND coalesce(logistic_type, '') <> 'fulfillment' AND status IN ('active', 'paused')
            AND (external_id = $1 OR ($2::text IS NOT NULL AND (upper(sku) = upper($2) OR upper($2) = ANY(SELECT upper(x) FROM unnest(variation_skus) x))))
          ORDER BY (external_id = $1) DESC, (status = 'active') DESC, updated_at DESC LIMIT 1`,
        [m.itemId ?? '', m.sku],
      );
      return rows[0] ?? null;
    });
    if (!listing) return null;
    const conn = (await this.ml.status(tenantId)).connections.find((c) => c.status === 'active' && c.accountId === listing.account_id);
    if (!conn) throw new ValidationError('A conta do Mercado Livre deste anúncio não está conectada: reconecte e lance de novo.');
    const { token } = await this.ml.accessToken(tenantId, conn.id);
    const item = await this.api.rawGet<Json>(token, `/items/${listing.external_id}`);
    if (!item || item.shipping?.logistic_type === 'fulfillment') return null; // virou Full: o ML controla o estoque
    const id = listing.external_id;
    if (item.variations?.length) {
      const sameItem = m.itemId === id;
      const skuOf = (v: Json) => v.seller_custom_field ?? v.attributes?.find((a: Json) => a.id === 'SELLER_SKU')?.value_name ?? null;
      const v = item.variations.find((x: Json) => sameItem && m.variationId && String(x.id) === String(m.variationId))
        ?? item.variations.find((x: Json) => m.sku && String(skuOf(x) ?? '').toUpperCase() === m.sku.toUpperCase());
      if (!v) throw new ValidationError(`Não achei a variação do SKU ${m.sku ?? '?'} no anúncio ${id}: ajuste o estoque pelo painel do ML.`);
      const before = Number(v.available_quantity ?? 0);
      const after = Math.max(0, before + m.delta);
      await this.api.rawPut(token, `/items/${id}/variations/${v.id}`, { available_quantity: after });
      return `Mercado Livre ${id} · variação ${v.id} (estoque ${before} → ${after})`;
    }
    const before = Number(item.available_quantity ?? 0);
    const after = Math.max(0, before + m.delta);
    await this.api.rawPut(token, `/items/${id}`, { available_quantity: after });
    await this.db.withTenant(tenantId, (db) => db.query('UPDATE listings SET available_quantity = $2 WHERE external_id = $1', [id, after]));
    return `Mercado Livre ${id} (estoque ${before} → ${after})`;
  }
}
