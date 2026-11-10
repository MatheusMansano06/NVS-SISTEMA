import type { Marketplace, SaveSkuCostInput, SkuFilter, SkuImportReport, SkuListDto, SkuRowDto, TaxRateDto } from '@nvs/shared';
import type { Cache } from '../../../shared/kernel/cache.js';
import type { Database, Queryable } from '../../../shared/infrastructure/database.js';
import { ValidationError } from '../../../shared/kernel/errors.js';
import { todayIn } from '../domain/period.js';
import { parseSkuCsv } from '../domain/sku-csv.js';
import { SINCE_ALWAYS, type PgSkuRepository } from '../infrastructure/pg-sku-repository.js';

const same = (a: number, b: number) => Math.abs(a - b) < 0.005;
/** A base do cadastro é servida da memória; passou disso, continua servindo e atualiza por trás. */
const ROWS_FRESH_MS = 5 * 60_000;
/** Depois disso a base é descartada (empresa que não abre o cadastro não ocupa memória). */
const ROWS_KEEP_S = 3600;
interface CachedRows {
  at: number;
  rows: SkuRowDto[];
}

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

  /** Leituras da base em andamento (uma por empresa) e versão que invalida a leitura que começou antes de uma gravação. */
  private loadingRows = new Map<string, Promise<SkuRowDto[]>>();
  private rowsVersion = new Map<string, number>();

  /**
   * A consulta que monta o cadastro lê 90 dias de vendas e leva segundos; a tela chama a cada busca, filtro e página.
   * Por isso a base (centenas de linhas por empresa) fica em memória e busca/filtro/página são feitos aqui.
   */
  async list(tenantId: string, q: { q?: string; filter: SkuFilter; platform?: Marketplace; offset: number; limit: number }): Promise<SkuListDto> {
    const needle = q.q?.trim().toLowerCase();
    const found = (await this.rows(tenantId)).filter(
      (r) =>
        (!needle || r.sku.toLowerCase().includes(needle) || (r.title ?? '').toLowerCase().includes(needle)) &&
        (!q.platform || r.platforms.includes(q.platform)),
    );
    const all = found.length;
    const done = found.filter((r) => r.custoUnit !== null).length;
    const picked = q.filter === 'all' ? found : found.filter((r) => (r.custoUnit === null) === (q.filter === 'missing'));
    // sem custo primeiro, depois os mais vendidos
    picked.sort(
      (a, b) =>
        Number(b.custoUnit === null) - Number(a.custoUnit === null) ||
        b.units30d - a.units30d ||
        Number(a.title === null) - Number(b.title === null) ||
        (a.title ?? '').localeCompare(b.title ?? '') ||
        a.sku.localeCompare(b.sku),
    );
    return { items: picked.slice(q.offset, q.offset + q.limit), total: picked.length, counts: { all, done, missing: all - done } };
  }

  private rowsKey(tenantId: string): string {
    return `sku-rows:${tenantId}`;
  }

  private async rows(tenantId: string): Promise<SkuRowDto[]> {
    const hit = await this.cache.get<CachedRows>(this.rowsKey(tenantId));
    if (!hit) return this.loadRows(tenantId);
    if (Date.now() - hit.at > ROWS_FRESH_MS) void this.loadRows(tenantId).catch(() => undefined);
    return hit.rows;
  }

  private loadRows(tenantId: string): Promise<SkuRowDto[]> {
    const running = this.loadingRows.get(tenantId);
    if (running) return running;
    const version = this.rowsVersion.get(tenantId) ?? 0;
    const job = this.db
      .withTenant(tenantId, (db) => this.repo.rows(db))
      .then(async (rows) => {
        // um custo gravado enquanto a consulta rodava: este resultado já nasceu velho, não vai para a memória
        if ((this.rowsVersion.get(tenantId) ?? 0) === version) {
          await this.cache.set<CachedRows>(this.rowsKey(tenantId), { at: Date.now(), rows }, ROWS_KEEP_S);
        }
        return rows;
      })
      .finally(() => this.loadingRows.delete(tenantId));
    this.loadingRows.set(tenantId, job);
    return job;
  }

  /**
   * Custos mudaram. Com `cost` (um SKU salvo ou removido), só o custo dele e dos vinculados é ajustado na base em
   * memória — cadastrar custos em sequência não refaz a consulta; nos outros casos a base é descartada.
   */
  private async touchRows(tenantId: string, cost?: { sku: string; custoUnit: number | null }): Promise<void> {
    this.rowsVersion.set(tenantId, (this.rowsVersion.get(tenantId) ?? 0) + 1);
    this.loadingRows.delete(tenantId);
    const hit = cost ? await this.cache.get<CachedRows>(this.rowsKey(tenantId)) : undefined;
    if (!hit || !cost) return this.cache.del(this.rowsKey(tenantId));
    const now = new Date().toISOString();
    const rows = hit.rows.map((r) =>
      (r.linkedSku ?? r.sku) === cost.sku ? { ...r, custoUnit: cost.custoUnit, updatedAt: cost.custoUnit === null ? null : now } : r,
    );
    await this.cache.set<CachedRows>(this.rowsKey(tenantId), { at: hit.at, rows }, ROWS_KEEP_S);
  }

  /**
   * Vincula `sku` ao SKU do mesmo produto em outra plataforma: as vendas dele passam a usar o custo (e o histórico
   * de custo) de `linkedSku`. Um nível só, para o custo ter uma origem clara.
   */
  async link(tenantId: string, userId: string, sku: string, linkedSku: string): Promise<{ affectedOrders: number }> {
    if (sku === linkedSku) throw new ValidationError('Escolha um SKU diferente para vincular');
    const affected = await this.db.withTenant(tenantId, async (db) => {
      if (await this.repo.linkOf(db, linkedSku)) throw new ValidationError(`${linkedSku} já está vinculado a outro SKU. Vincule direto a ele.`);
      if (await this.repo.isLinkTarget(db, sku)) throw new ValidationError(`Outros SKUs usam o custo de ${sku}. Desvincule-os antes.`);
      await this.repo.setLink(db, tenantId, userId, sku, linkedSku);
      return this.repo.applyCosts(db, { skus: [sku] });
    });
    await this.invalidate(tenantId);
    return { affectedOrders: affected };
  }

  /** Desfaz o vínculo: o SKU volta a usar o próprio custo (ou fica sem custo). */
  async unlink(tenantId: string, sku: string): Promise<boolean> {
    const removed = await this.db.withTenant(tenantId, async (db) => {
      if (!(await this.repo.removeLink(db, sku))) return false;
      await this.repo.applyCosts(db, { skus: [sku] });
      return true;
    });
    await this.invalidate(tenantId);
    return removed;
  }

  async save(tenantId: string, userId: string, input: SaveSkuCostInput, today = todayIn()) {
    const result = await this.db.withTenant(tenantId, async (db) => {
      // custo de SKU vinculado vem do destino: gravar aqui não teria efeito e confundiria
      const target = await this.repo.linkOf(db, input.sku);
      if (target) throw new ValidationError(`${input.sku} usa o custo de ${target}. Altere o custo lá ou desvincule.`);
      const changed = await this.write(db, tenantId, userId, input.sku, input.custoUnit, 'cadastro', today);
      const affected = changed ? await this.repo.applyCosts(db, { skus: [input.sku] }) : 0;
      return { sku: input.sku, custoUnit: input.custoUnit, affectedOrders: affected };
    });
    await this.invalidate(tenantId, { sku: input.sku, custoUnit: input.custoUnit });
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
    if (removed) await this.invalidate(tenantId, { sku, custoUnit: null });
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
    const base = {
      received: rows.length, created: 0, updated: 0, unchanged: 0, withoutCost: 0,
      unknownSkus: [] as { line: number; sku: string }[], ignored: 0, duplicates: [] as { line: number; sku: string; keptLine: number }[],
    };
    if (invalidRows.length) return { status: 'rejected', ...base, invalidRows: invalidRows.slice(0, 50) };

    const report = await this.db.withTenant(tenantId, async (db) => {
      // só confere com o marketplace quando já há anúncios/vendas sincronizados (empresa nova importa livre)
      const known = await this.repo.knownSkus(db);
      // grafia exata do anúncio primeiro; senão a mesma letra em outra caixa (o anúncio manda)
      const canonical = (sku: string) => (known.exact.has(sku.trim()) ? sku.trim() : (known.byUpper.get(sku.trim().toUpperCase()) ?? sku.trim()));
      const unknown = known.size ? rows.filter((r) => !known.exact.has(r.sku.trim()) && !known.byUpper.has(r.sku.trim().toUpperCase())) : [];
      const counts = { ...base, unknownSkus: unknown.map((r) => ({ line: r.line, sku: r.sku })) };
      if (unknown.length && !ignoreUnknown) return { rejected: true, counts };
      counts.ignored = unknown.length;
      const skip = new Set(unknown.map((r) => r.line));
      const existing = await this.repo.allCosts(db);
      const changedSkus: string[] = [];
      const firstLine = new Map<string, number>();
      for (const r of rows) {
        if (skip.has(r.line)) continue;
        // mesmo SKU repetido (inclusive em outra caixa de letra que cai no mesmo anúncio): fica a primeira linha
        const target = canonical(r.sku);
        const kept = firstLine.get(target);
        if (kept !== undefined) {
          counts.duplicates.push({ line: r.line, sku: r.sku, keptLine: kept });
          continue;
        }
        firstLine.set(target, r.line);
        if (r.custoUnit === null) {
          counts.withoutCost++; // sem custo na planilha: o SKU continua "sem custo" no cadastro
          continue;
        }
        // grava com a grafia do anúncio (planilha com outra caixa de letra continua ligando às vendas)
        const sku = target;
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

  /**
   * Define a alíquota da empresa e recalcula o imposto das vendas a partir da vigência dela.
   * `vigenteDesde` (opcional) escolhe o dia: as vendas desde então passam a usar a nova alíquota
   * e as vigências que começavam nesse dia ou depois deixam de valer.
   */
  async setTaxRate(tenantId: string, userId: string, ratePct: number, today = todayIn(), vigenteDesde?: string): Promise<TaxRateDto> {
    if (vigenteDesde && (vigenteDesde > today || vigenteDesde < '2000-01-01' || Number.isNaN(Date.parse(vigenteDesde))))
      throw new ValidationError('A data de vigência deve ser um dia válido até hoje.');
    const dto = await this.db.withTenant(tenantId, async (db) => {
      const cur = await this.repo.currentTaxRate(db);
      if (cur && same(cur.ratePct, ratePct) && (!vigenteDesde || cur.since <= vigenteDesde)) return { ratePct, vigenteDesde: cur.since };
      const since = vigenteDesde ?? sinceFor(cur, today);
      if (vigenteDesde) await this.repo.dropTaxRatesFrom(db, vigenteDesde);
      await this.repo.addTaxRate(db, tenantId, userId, ratePct, since);
      await this.repo.applyTaxRate(db, ratePct, since);
      return { ratePct, vigenteDesde: since };
    });
    await this.invalidate(tenantId);
    return dto;
  }

  async exportCsv(tenantId: string): Promise<string> {
    const { items } = await this.list(tenantId, { filter: 'all', offset: 0, limit: 100_000 });
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
  private async invalidate(tenantId: string, cost?: { sku: string; custoUnit: number | null }): Promise<void> {
    await this.cache.set(`dash-version:${tenantId}`, Date.now(), 86_400);
    await this.touchRows(tenantId, cost);
  }
}
