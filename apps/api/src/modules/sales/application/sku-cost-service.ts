import type { SaveSkuCostInput, SkuFilter, SkuImportReport, SkuListDto, TaxRateDto } from '@nvs/shared';
import type { Cache } from '../../../shared/kernel/cache.js';
import type { Database, Queryable } from '../../../shared/infrastructure/database.js';
import { ValidationError } from '../../../shared/kernel/errors.js';
import { todayIn } from '../domain/period.js';
import { parseSkuCsv } from '../domain/sku-csv.js';
import { SINCE_ALWAYS, type PgSkuRepository } from '../infrastructure/pg-sku-repository.js';

const same = (a: number, b: number) => Math.abs(a - b) < 0.005;

/**
 * Vigência (regra do NVS-WMS): o PRIMEIRO valor vale para todo o histórico; alterações valem
 * a partir de hoje; correção no mesmo dia ajusta a vigência recém-criada.
 */
const sinceFor = (last: { since: string; registeredOn: string } | null, today: string) =>
  !last ? SINCE_ALWAYS : last.registeredOn === today ? last.since : today;

/**
 * Cadastro de SKUs (custo unitário por SKU) e alíquota única de imposto da empresa.
 * Importação é tudo-ou-nada, com pré-visualização (dry-run). Remover custo não apaga o passado.
 */
export class SkuCostService {
  constructor(
    private readonly db: Database,
    private readonly repo: PgSkuRepository,
    private readonly cache: Cache,
  ) {}

  list(tenantId: string, q: { q?: string; filter: SkuFilter; offset: number; limit: number }): Promise<SkuListDto> {
    return this.db.withTenant(tenantId, (db) => this.repo.list(db, q));
  }

  async save(tenantId: string, userId: string, input: SaveSkuCostInput, today = todayIn()) {
    const result = await this.db.withTenant(tenantId, async (db) => {
      const changed = await this.write(db, tenantId, userId, input.sku, input.custoUnit, 'cadastro', today);
      const affected = changed ? await this.repo.applyCosts(db, { skus: [input.sku] }) : 0;
      return { sku: input.sku, custoUnit: input.custoUnit, affectedOrders: affected };
    });
    await this.invalidate(tenantId);
    return result;
  }

  /**
   * Custo novo valendo a partir de `since` (Central de Devoluções → Quebrados): o que veio antes mantém o custo da época.
   * Primeira mudança de um SKU sem histórico guarda antes o custo atual "desde sempre". O custo atual passa a ser o da
   * vigência mais recente. Retorna esse custo atual.
   */
  async saveFrom(tenantId: string, userId: string, sku: string, custoUnit: number, since: string, byName: string | null): Promise<number> {
    const current = await this.db.withTenant(tenantId, async (db) => {
      const cur = await this.repo.current(db, sku);
      const hasHistory = (await db.query('SELECT 1 FROM sku_cost_history WHERE sku = $1 LIMIT 1', [sku])).rowCount;
      if (!hasHistory && cur) await this.repo.addHistory(db, { tenantId, sku, custoUnit: cur.custoUnit, since: SINCE_ALWAYS, origem: 'cadastro', userId });
      await db.query(
        `INSERT INTO sku_cost_history (tenant_id, sku, custo_unit, vigente_desde, origem, registrado_por, registrado_por_nome)
         VALUES ($1, $2, $3, $4, 'cadastro', $5, $6)`,
        [tenantId, sku, custoUnit, since, userId, byName],
      );
      const { rows } = await db.query<{ custo_unit: string | null }>(
        'SELECT custo_unit FROM sku_cost_history WHERE sku = $1 ORDER BY vigente_desde DESC, registrado_em DESC LIMIT 1',
        [sku],
      );
      const latest = rows[0]?.custo_unit == null ? custoUnit : Number(rows[0].custo_unit);
      await this.repo.upsert(db, tenantId, userId, sku, latest);
      await this.repo.applyCosts(db, { skus: [sku] });
      return latest;
    });
    await this.invalidate(tenantId);
    return current;
  }

  async remove(tenantId: string, userId: string, sku: string, today = todayIn()): Promise<boolean> {
    const removed = await this.db.withTenant(tenantId, async (db) => {
      if (!(await this.repo.remove(db, sku))) return false;
      await this.repo.addHistory(db, { tenantId, sku, custoUnit: null, since: today, origem: 'removido', userId });
      await this.repo.applyCosts(db, { skus: [sku] });
      return true;
    });
    await this.invalidate(tenantId);
    return removed;
  }

  /**
   * Importação em 2 passos (pré-visualiza → confirma). Custo vazio/zero é aceito (fica "sem custo"). SKU que não existe
   * em nenhum anúncio nem venda do marketplace barra a planilha — ou é pulado, se `ignoreUnknown`.
   */
  async importCsv(tenantId: string, userId: string, csv: string, dryRun: boolean, today = todayIn(), ignoreUnknown = false): Promise<SkuImportReport> {
    const { rows, headerError } = parseSkuCsv(csv);
    if (headerError) throw new ValidationError(headerError);
    const invalidRows = rows.filter((r) => r.error).map((r) => ({ line: r.line, sku: r.sku || null, reason: r.error! }));
    const seen = new Set<string>();
    for (const r of rows) {
      if (!r.error && seen.has(r.sku.toUpperCase())) invalidRows.push({ line: r.line, sku: r.sku, reason: 'SKU repetido na planilha' });
      seen.add(r.sku.toUpperCase());
    }
    const base = { received: rows.length, created: 0, updated: 0, unchanged: 0, withoutCost: 0, unknownSkus: [] as { line: number; sku: string }[], ignored: 0 };
    if (invalidRows.length) return { status: 'rejected', ...base, invalidRows: invalidRows.slice(0, 50) };

    const report = await this.db.withTenant(tenantId, async (db) => {
      // só confere com o marketplace quando já há anúncios/vendas sincronizados (empresa nova importa livre)
      const known = await this.repo.knownSkus(db);
      const unknown = known.size ? rows.filter((r) => !known.has(r.sku.trim().toUpperCase())) : [];
      const counts = { ...base, unknownSkus: unknown.map((r) => ({ line: r.line, sku: r.sku })) };
      if (unknown.length && !ignoreUnknown) return { rejected: true, counts };
      counts.ignored = unknown.length;
      const skip = new Set(unknown.map((r) => r.line));
      const existing = await this.repo.allCosts(db);
      const changedSkus: string[] = [];
      for (const r of rows) {
        if (skip.has(r.line)) continue;
        if (r.custoUnit === null) {
          counts.withoutCost++; // sem custo na planilha: o SKU continua "sem custo" no cadastro
          continue;
        }
        // grava com a grafia do anúncio (planilha com outra caixa de letra continua ligando às vendas)
        const sku = known.get(r.sku.trim().toUpperCase()) ?? r.sku.trim();
        const cur = existing.get(sku);
        if (!cur) counts.created++;
        else if (same(cur.custoUnit, r.custoUnit)) {
          counts.unchanged++;
          continue;
        } else counts.updated++;
        if (!dryRun) {
          await this.write(db, tenantId, userId, sku, r.custoUnit, 'importacao', today);
          changedSkus.push(sku);
        }
      }
      if (!dryRun) await this.repo.applyCosts(db, { skus: changedSkus });
      return { rejected: false, counts };
    });
    if (report.rejected) return { status: 'rejected', ...report.counts, invalidRows: [] };
    if (!dryRun) await this.invalidate(tenantId);
    return { status: dryRun ? 'dry_run' : 'ok', ...report.counts, invalidRows: [] };
  }

  // ---------- alíquota única de imposto
  async taxRate(tenantId: string): Promise<TaxRateDto> {
    const cur = await this.db.withTenant(tenantId, (db) => this.repo.currentTaxRate(db));
    return { ratePct: cur?.ratePct ?? null, vigenteDesde: cur?.since ?? null };
  }

  /** Define a alíquota da empresa e recalcula o imposto de todas as vendas pela vigência. */
  async setTaxRate(tenantId: string, userId: string, ratePct: number, today = todayIn()): Promise<TaxRateDto> {
    const dto = await this.db.withTenant(tenantId, async (db) => {
      const cur = await this.repo.currentTaxRate(db);
      if (cur && same(cur.ratePct, ratePct)) return { ratePct, vigenteDesde: cur.since };
      const since = sinceFor(cur, today);
      await this.repo.addTaxRate(db, tenantId, userId, ratePct, since);
      await this.repo.applyCosts(db, { all: true });
      return { ratePct, vigenteDesde: since };
    });
    await this.invalidate(tenantId);
    return dto;
  }

  async exportCsv(tenantId: string): Promise<string> {
    const { items } = await this.db.withTenant(tenantId, (db) =>
      this.repo.list(db, { filter: 'all', offset: 0, limit: 100_000 }),
    );
    const br = (n: number | null) => (n === null ? '' : n.toFixed(2).replace('.', ','));
    const esc = (s: string | null) => `"${(s ?? '').replace(/"/g, '""')}"`;
    const lines = ['sku;titulo;custo_unit;vendidos_30d;estoque'];
    for (const r of items) lines.push([esc(r.sku), esc(r.title), br(r.custoUnit), r.units30d, r.stock ?? ''].join(';'));
    return '﻿' + lines.join('\r\n');
  }

  /** Grava custo + vigência. Retorna false se nada mudou. */
  private async write(
    db: Queryable,
    tenantId: string,
    userId: string,
    sku: string,
    custoUnit: number,
    origem: 'cadastro' | 'importacao',
    today: string,
  ): Promise<boolean> {
    const cur = await this.repo.current(db, sku);
    if (cur && same(cur.custoUnit, custoUnit)) return false;
    const since = sinceFor(await this.repo.lastHistory(db, sku), today);
    await this.repo.upsert(db, tenantId, userId, sku, custoUnit);
    await this.repo.addHistory(db, { tenantId, sku, custoUnit, since, origem, userId });
    return true;
  }

  /** O dashboard e a análise têm cache curto: muda a versão para refletir na hora. */
  private async invalidate(tenantId: string): Promise<void> {
    await this.cache.set(`dash-version:${tenantId}`, Date.now(), 86_400);
  }
}
