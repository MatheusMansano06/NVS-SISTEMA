import type {
  ListingDto,
  ListingListDto,
  ListingPricingDto,
  ListingSalesDto,
  ListingTab,
} from '@nvs/shared';
import type { Database } from '../../../shared/infrastructure/database.js';
import { AppError, NotFoundError } from '../../../shared/kernel/errors.js';
import { formatDimensions, logisticOf, typeLabel, unitMargin } from '../domain/listing-margin.js';
import { MlApiError, type MlApi } from '../infrastructure/ml-api.js';
import { PgListingRepository, toNumber, type ListingRow } from '../infrastructure/pg-listing-repository.js';
import type { MlIntegrationService } from './ml-integration-service.js';

const round2 = (n: number) => Math.round(n * 100) / 100;

class Blocked extends AppError {
  constructor(message: string) {
    super(message, 'LISTING_BLOCKED', 409);
  }
}

/** Aba Anúncios: leitura do catálogo local e ações no Mercado Livre (preço, estoque, status). */
export class ListingService {
  constructor(
    private readonly db: Database,
    private readonly repo: PgListingRepository,
    private readonly ml: MlIntegrationService,
    private readonly api: MlApi,
  ) {}

  private toDto(r: ListingRow, taxPct: number): ListingDto {
    const price = toNumber(r.price);
    // 1º: tarifa/frete salvos para o preço atual; 2º: média das vendas dos últimos 90 dias
    const saved = r.pricing_price !== null && price !== null && Math.abs(Number(r.pricing_price) - price) < 0.005;
    const fee = saved ? toNumber(r.fee_amount) : toNumber(r.avg_fee);
    const freight = saved ? toNumber(r.freight_cost) : toNumber(r.avg_freight);
    const hasSales = fee !== null && freight !== null;
    return {
      id: r.external_id,
      title: r.title,
      sku: r.sku,
      pictureUrl: r.picture_url,
      permalink: r.permalink,
      status: r.status,
      subStatus: r.sub_status,
      price,
      stock: r.available_quantity,
      sold: r.sold_quantity,
      type: typeLabel(r.listing_type_id),
      freeShipping: r.free_shipping,
      logistic: logisticOf(r.logistic_type),
      picturesCount: r.pictures_count,
      dimensions: formatDimensions(r.dimensions),
      listedAt: r.listed_at?.toISOString() ?? null,
      catalog: r.catalog_listing,
      cost: toNumber(r.custo_unit),
      margin: unitMargin({
        price,
        fee: fee === null ? null : round2(fee),
        freight: freight === null ? null : round2(freight),
        cost: toNumber(r.custo_unit),
        taxPct,
        source: !hasSales ? null : saved ? 'live' : 'sales',
      }),
      account: r.account_nickname,
    };
  }

  async list(tenantId: string, q: { status: ListingTab; q?: string; offset: number; limit: number }): Promise<ListingListDto> {
    const status = await this.ml.status(tenantId);
    return this.db.withTenant(tenantId, async (db) => {
      // mesmo client da transação: consultas em sequência
      const { rows, total } = await this.repo.list(db, q);
      const counts = await this.repo.counts(db);
      const taxPct = await this.repo.taxPct(db);
      return {
        items: rows.map((r) => this.toDto(r, taxPct)),
        total,
        counts,
        taxPct,
        connected: status.connections.length > 0,
      };
    });
  }

  async sales(tenantId: string, id: string, offset: number, limit: number): Promise<ListingSalesDto> {
    return this.db.withTenant(tenantId, async (db) => {
      const { rows, totals } = await this.repo.sales(db, id, offset, limit);
      return {
        items: rows.map((r) => ({
          orderId: r.order_id,
          orderedAt: r.ordered_at.toISOString(),
          status: r.status,
          quantity: r.quantity,
          unitPrice: Number(r.unit_price),
          gross: round2(r.quantity * Number(r.unit_price)),
        })),
        total: Number(totals.total),
        totals: { orders: Number(totals.orders), units: Number(totals.units), gross: round2(Number(totals.gross)) },
      };
    });
  }

  /** Conexão (e token) da conta dona do anúncio. */
  async session(tenantId: string, id: string) {
    const row = await this.db.withTenant(tenantId, (db) => this.repo.one(db, id));
    if (!row) throw new NotFoundError('Anúncio não encontrado');
    const status = await this.ml.status(tenantId);
    const conn = status.connections.find((c) => c.accountId === row.account_id);
    if (!conn || conn.status !== 'active') throw new Blocked('Conecte a conta do Mercado Livre para alterar este anúncio.');
    const { token, conn: c } = await this.ml.accessToken(tenantId, conn.id);
    return { row, token, mlUserId: c.ml_user_id, connectionId: conn.id };
  }

  /** Simula tarifa e frete reais para um preço (consulta ao vivo no marketplace). */
  async pricing(tenantId: string, id: string, price?: number, refresh = false): Promise<ListingPricingDto> {
    const row0 = await this.db.withTenant(tenantId, (db) => this.repo.one(db, id));
    if (!row0) throw new NotFoundError('Anúncio não encontrado');
    const current = toNumber(row0.price);
    const isCurrent = price === undefined || (current !== null && Math.abs(price - current) < 0.005);
    // já consultado para este preço: responde do banco, sem chamar o marketplace
    if (!refresh && isCurrent && row0.pricing_price !== null && current !== null && Math.abs(Number(row0.pricing_price) - current) < 0.005) {
      const taxPct = await this.db.withTenant(tenantId, (db) => this.repo.taxPct(db));
      const fee = toNumber(row0.fee_amount);
      const freight = toNumber(row0.freight_cost);
      return {
        price: current,
        fee,
        feePct: toNumber(row0.fee_pct),
        freight,
        margin: unitMargin({ price: current, fee, freight, cost: toNumber(row0.custo_unit), taxPct, source: 'live' }),
      };
    }
    const { row, token, mlUserId } = await this.session(tenantId, id);
    const target = price ?? toNumber(row.price);
    if (!target || target <= 0) throw new Blocked('Anúncio sem preço para simular.');
    const [fees, freightCost, taxPct] = await Promise.all([
      this.wrap(() => this.api.listingFees(token, target, row.category_id)),
      row.free_shipping ? this.wrap(() => this.api.freeShippingCost(token, mlUserId, id)) : Promise.resolve(0),
      this.db.withTenant(tenantId, (db) => this.repo.taxPct(db)),
    ]);
    const f = fees.find((x) => x.listing_type_id === row.listing_type_id);
    const fee = f ? round2(f.sale_fee_amount) : null;
    const freight = freightCost === null ? null : round2(freightCost);
    // só o preço vigente fica salvo (simulações de outro preço não sobrescrevem o banco)
    if (isCurrent) {
      await this.db.withTenant(tenantId, (db) =>
        this.repo.savePricing(db, id, { price: target, fee, feePct: f?.sale_fee_details?.percentage_fee ?? null, freight }),
      );
    }
    return {
      price: target,
      fee,
      feePct: f?.sale_fee_details?.percentage_fee ?? null,
      freight,
      margin: unitMargin({ price: target, fee, freight, cost: toNumber(row.custo_unit), taxPct, source: 'live' }),
    };
  }

  async setPrice(tenantId: string, id: string, price: number) {
    const { row, token } = await this.session(tenantId, id);
    if (row.catalog_listing) throw new Blocked('Anúncio de catálogo: o preço não pode ser alterado por aqui.');
    if (row.status === 'closed') throw new Blocked('Anúncio finalizado: não é possível alterar o preço.');
    const next = round2(price);
    const item = await this.wrap(() => this.api.updateItem(token, id, { price: next }));
    await this.db.withTenant(tenantId, (db) => this.repo.setLocal(db, id, { price: item.price ?? next }));
    return { id, price: item.price ?? next };
  }

  async setStock(tenantId: string, id: string, quantity: number) {
    const { row, token } = await this.session(tenantId, id);
    if (row.status === 'closed') throw new Blocked('Anúncio finalizado: não é possível alterar o estoque.');
    if (row.logistic_type === 'fulfillment') {
      throw new Blocked('Anúncio Full: o estoque é gerido pelo Mercado Livre e não pode ser alterado por aqui.');
    }
    const item = await this.wrap(() => this.api.updateItem(token, id, { available_quantity: quantity }));
    await this.db.withTenant(tenantId, (db) => this.repo.setLocal(db, id, { stock: item.available_quantity ?? quantity }));
    return { id, stock: item.available_quantity ?? quantity };
  }

  async setStatus(tenantId: string, id: string, status: 'active' | 'paused' | 'closed') {
    const { row, token } = await this.session(tenantId, id);
    if (row.status === 'closed') throw new Blocked('Anúncio já finalizado: não é possível mudar o status.');
    const item = await this.wrap(() => this.api.updateItem(token, id, { status }));
    await this.db.withTenant(tenantId, (db) => this.repo.setLocal(db, id, { status: item.status ?? status }));
    return { id, status: item.status ?? status };
  }

  /** Erros do ML viram resposta 502 legível, sem vazar detalhes internos. */
  async wrap<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof MlApiError) {
        throw new AppError(`Mercado Livre: ${err.message}`, 'MARKETPLACE_ERROR', err.status === 401 ? 401 : 502);
      }
      throw err;
    }
  }
}
