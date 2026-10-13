import type { Database, Queryable } from '../../../shared/infrastructure/database.js';
import { TIMEZONE, todayIn } from '../domain/period.js';

/** Meses completos guardados com o detalhe venda a venda (além do mês atual). */
export const DETAIL_MONTHS = 13;
const MONTHS_PER_RUN = 6; // limita o trabalho de cada execução

interface Logger {
  error(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
}

/** 1º dia do mês a partir do qual o detalhe é mantido (AAAA-MM-01). */
export function retentionCutoff(today = todayIn()): string {
  const [y, m] = today.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 - DETAIL_MONTHS, 1));
  return d.toISOString().slice(0, 10);
}

/**
 * Retenção das vendas: o que passou de 13 meses vira totais mensais (por conta, status, SKU, anúncio,
 * estado, forma de pagamento e tipo de envio) e o detalhe é apagado. Cada mês é arquivado numa transação:
 * soma e apaga juntos — rodar de novo não duplica e uma queda no meio não perde nada.
 */
export class SalesRetention {
  constructor(
    private readonly db: Database,
    private readonly log: Logger,
  ) {}

  async archiveTenant(tenantId: string, today = todayIn()): Promise<string[]> {
    const cutoff = retentionCutoff(today);
    const months = await this.db.withTenant(tenantId, async (db) => {
      const { rows } = await db.query<{ month: string }>(
        `SELECT DISTINCT to_char(date_trunc('month', ordered_at AT TIME ZONE '${TIMEZONE}'), 'YYYY-MM-DD') AS month
           FROM orders WHERE ordered_at < ($1::date)::timestamp AT TIME ZONE '${TIMEZONE}'
          ORDER BY 1 LIMIT ${MONTHS_PER_RUN}`,
        [cutoff],
      );
      return rows.map((r) => r.month);
    });
    for (const month of months) {
      await this.db.withTenant(tenantId, (db) => this.archiveMonth(db, month));
    }
    // registro de sincronizações antigas não serve para nada
    await this.db.withTenant(tenantId, (db) => db.query("DELETE FROM ml_sync_runs WHERE started_at < now() - interval '60 days'"));
    return months;
  }

  private async archiveMonth(db: Queryable, month: string): Promise<void> {
    const inMonth = `o.ordered_at >= ($1::date)::timestamp AT TIME ZONE '${TIMEZONE}'
      AND o.ordered_at < (($1::date + interval '1 month')::date)::timestamp AT TIME ZONE '${TIMEZONE}'`;
    await db.query(
      `INSERT INTO sales_monthly_totals AS t (tenant_id, account_id, marketplace, month, status, sku, listing_id, ship_state,
              payment_type, logistic_bucket, source, orders, units, gross, fee, shipping_cost, buyer_shipping, coupon, refund,
              tax, cost, cost_known)
       SELECT o.tenant_id, o.account_id, o.marketplace, $1::date, o.status, i.sku, coalesce(i.listing_id, ''),
              coalesce(o.ship_state, ''), coalesce(o.payment_type, ''), coalesce(o.logistic_bucket, ''), o.source,
              count(DISTINCT o.id), sum(i.quantity), round(sum(i.quantity * i.unit_price), 2),
              round(sum(o.marketplace_fee * s.share), 2), round(sum(o.shipping_cost * s.share), 2),
              round(sum(o.buyer_shipping * s.share), 2), round(sum(coalesce(o.coupon_seller, 0) * s.share), 2),
              round(sum(coalesce(o.refund_partial, 0) * s.share), 2), round(sum(o.tax_amount * s.share), 2),
              round(coalesce(sum(i.unit_cost * i.quantity), 0), 2), bool_and(i.unit_cost IS NOT NULL)
         FROM orders o
         JOIN order_items i ON i.order_id = o.id
         CROSS JOIN LATERAL (SELECT coalesce(i.quantity * i.unit_price / nullif(o.gross_amount, 0), 1) AS share) s
        WHERE ${inMonth}
        GROUP BY o.tenant_id, o.account_id, o.marketplace, o.status, i.sku, coalesce(i.listing_id, ''), coalesce(o.ship_state, ''),
                 coalesce(o.payment_type, ''), coalesce(o.logistic_bucket, ''), o.source
       ON CONFLICT (tenant_id, account_id, month, status, sku, listing_id, ship_state, payment_type, logistic_bucket, source)
       DO UPDATE SET orders = t.orders + EXCLUDED.orders, units = t.units + EXCLUDED.units, gross = t.gross + EXCLUDED.gross,
         fee = t.fee + EXCLUDED.fee, shipping_cost = t.shipping_cost + EXCLUDED.shipping_cost,
         buyer_shipping = t.buyer_shipping + EXCLUDED.buyer_shipping, coupon = t.coupon + EXCLUDED.coupon,
         refund = t.refund + EXCLUDED.refund, tax = t.tax + EXCLUDED.tax, cost = t.cost + EXCLUDED.cost,
         cost_known = t.cost_known AND EXCLUDED.cost_known, archived_at = now()`,
      [month],
    );
    // os itens saem junto (ON DELETE CASCADE)
    const { rowCount } = await db.query(`DELETE FROM orders o WHERE ${inMonth}`, [month]);
    this.log.info({ month, orders: rowCount }, 'Retenção: mês arquivado em totais');
  }

  /** Um ciclo diário (uma instância por dia, via scheduler_ticks). */
  async dailyTick(now = new Date()): Promise<boolean> {
    const slot = new Date(now);
    slot.setUTCHours(0, 0, 0, 0);
    const claimed = await this.db.query('INSERT INTO scheduler_ticks (job, slot) VALUES ($1, $2) ON CONFLICT DO NOTHING', ['sales_retention', slot]);
    if (claimed.rowCount !== 1) return false;
    await this.db.query("DELETE FROM scheduler_ticks WHERE slot < now() - interval '30 days'");
    const { rows } = await this.db.query<{ id: string }>('SELECT id FROM tenants');
    for (const t of rows) {
      await this.archiveTenant(t.id).catch((err) => this.log.error({ err, tenantId: t.id }, 'Retenção falhou'));
    }
    return true;
  }

  /** Roda às 03:30 (horário de Brasília), fora do horário de pico. Retorna a função para parar. */
  startScheduler(): () => void {
    let timer: NodeJS.Timeout;
    const schedule = () => {
      const now = new Date();
      const next = new Date(now);
      next.setUTCHours(6, 30, 0, 0); // 03:30 em São Paulo
      if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
      timer = setTimeout(() => {
        this.dailyTick().catch((err) => this.log.error({ err }, 'Retenção: agendador falhou'));
        schedule();
      }, next.getTime() - now.getTime());
      timer.unref();
    };
    schedule();
    return () => clearTimeout(timer);
  }
}
