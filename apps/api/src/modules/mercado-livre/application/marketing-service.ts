import {
  MARKETING_TOOL_INFO,
  MARKETING_TOOLS,
  type MarketingAccountDto,
  type MarketingDto,
  type MarketingListingDto,
  type MarketingTool,
  type MarketingToolStat,
} from '@nvs/shared';
import type { Database, Queryable } from '../../../shared/infrastructure/database.js';
import type { Cache } from '../../../shared/kernel/cache.js';
import { NotFoundError } from '../../../shared/kernel/errors.js';
import type { MlRawApi } from '../infrastructure/ml-api.js';
import type { MlIntegrationService } from './ml-integration-service.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const TICK_MS = 15 * 60_000;
/** Anúncios analisados por conta a cada ciclo (3 a 4 chamadas cada): ~600/h por conta, sem pressa. */
const BATCH = 150;
const PACE_MS = 200;
/** Releitura automática: uma vez por semana (ou antes, quando forçada pelo "Analisar agora"/"Sincronizar"). */
const STALE_HOURS = 7 * 24;
const CAMPAIGNS_TTL = 600;
/** Se o ML não responde clips/anúncios patrocinados nas primeiras leituras, para de perguntar neste ciclo. */
const PROBE_LIMIT = 5;

/** Quantidade alta o bastante para cair na maior faixa de atacado cadastrada. */
const WHOLESALE_PROBE_QTY = 1000;
const ACTIVE_PROMO = new Set(['started', 'pending', 'active']);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Row {
  item_id: string;
  promos_active: string[];
  promos_candidate: string[];
  wholesale: boolean | null;
  clips: boolean | null;
  video: boolean | null;
  ads: string | null;
}

interface Logger {
  info(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/** Usa? true/false; null = sem leitura do ML para esta ferramenta. */
function uses(r: Row, tool: MarketingTool): boolean | null {
  const types = MARKETING_TOOL_INFO[tool].promoTypes;
  if (types) return r.promos_active.some((t) => types.includes(t));
  if (tool === 'ads') return r.ads === null ? null : r.ads === 'active';
  return r[tool as 'wholesale' | 'clips' | 'video'];
}

const eligibleFor = (r: Row, tool: MarketingTool) => {
  const types = MARKETING_TOOL_INFO[tool].promoTypes;
  return Boolean(types && r.promos_candidate.some((t) => types.includes(t)));
};

/**
 * Central de Marketing: raio-X de cada anúncio ativo (promoções, atacado, clips, vídeo, Mercado Ads), lido aos poucos
 * em segundo plano e guardado no banco. A tela só lê o banco; o que o ML não informa para a conta aparece como
 * indisponível (cada conta tem ferramentas diferentes).
 */
export class MarketingService {
  private running = new Set<string>();

  constructor(
    private readonly db: Database,
    private readonly ml: MlIntegrationService,
    private readonly api: MlRawApi,
    private readonly cache: Cache,
    private readonly log: Logger,
    private readonly opts: { paceMs?: number } = {},
  ) {}

  async summary(tenantId: string): Promise<MarketingDto> {
    const status = await this.ml.status(tenantId);
    const accounts: MarketingAccountDto[] = [];
    for (const c of status.connections.filter((x) => x.status === 'active')) {
      const { conn } = await this.ml.accessToken(tenantId, c.id);
      const { rows, active, last, pending } = await this.db.withTenant(tenantId, async (db) => ({
        rows: await this.analyzed(db, conn.account_id),
        active: Number(
          (await db.query<{ n: string }>(`SELECT count(*) AS n FROM listings WHERE account_id = $1 AND status = 'active'`, [conn.account_id])).rows[0]?.n ?? 0,
        ),
        last: (
          await db.query<{ at: Date | null }>('SELECT max(checked_at) AS at FROM listing_marketing WHERE account_id = $1', [conn.account_id])
        ).rows[0]?.at,
        pending: Number(
          (
            await db.query<{ n: string }>(
              `SELECT count(*) AS n FROM listings l
                 LEFT JOIN listing_marketing m ON m.account_id = l.account_id AND m.item_id = l.external_id
                WHERE l.account_id = $1 AND l.status = 'active' AND l.source = 'marketplace'
                  AND (m.item_id IS NULL OR m.stale OR m.checked_at < now() - make_interval(hours => $2))`,
              [conn.account_id, STALE_HOURS],
            )
          ).rows[0]?.n ?? 0,
        ),
      }));
      accounts.push({
        connectionId: c.id,
        accountId: conn.account_id,
        nickname: c.nickname,
        activeListings: active,
        analyzed: rows.length,
        pending,
        lastCheckedAt: last ? new Date(last).toISOString() : null,
        tools: MARKETING_TOOLS.map((tool) => this.stat(rows, tool)),
        openCampaigns: await this.openCampaigns(tenantId, c.id, conn.ml_user_id),
      });
    }
    return { accounts, scanning: this.running.has(tenantId) };
  }

  /** Anúncios que usam (ou não) uma ferramenta: os elegíveis primeiro, depois os mais caros. */
  async listings(tenantId: string, connectionId: string, tool: MarketingTool, using: boolean, offset: number, limit: number) {
    const { conn } = await this.ml.accessToken(tenantId, connectionId).catch(() => {
      throw new NotFoundError('Conta do Mercado Livre não encontrada');
    });
    return this.db.withTenant(tenantId, async (db) => {
      const rows = (await this.analyzed(db, conn.account_id)).filter((r) => uses(r, tool) === using);
      const ids = rows.map((r) => r.item_id);
      const eligible = new Set(rows.filter((r) => eligibleFor(r, tool)).map((r) => r.item_id));
      const { rows: items } = await db.query<Json>(
        `SELECT external_id, title, picture_url, permalink, price, sku FROM listings
          WHERE account_id = $1 AND external_id = ANY($2::text[])`,
        [conn.account_id, ids],
      );
      const list: MarketingListingDto[] = items
        .map((l: Json) => ({
          id: l.external_id,
          title: l.title,
          pictureUrl: l.picture_url,
          permalink: l.permalink,
          price: l.price === null ? null : Number(l.price),
          sku: l.sku ?? null,
          eligible: eligible.has(l.external_id),
        }))
        .sort((a: MarketingListingDto, b: MarketingListingDto) => Number(b.eligible) - Number(a.eligible) || (b.price ?? 0) - (a.price ?? 0));
      return { items: list.slice(offset, offset + limit), total: list.length };
    });
  }

  /**
   * Reanálise forçada ("Analisar agora"): marca todos os anúncios para reler e já começa, em segundo plano, até
   * acabar a fila. A última análise continua valendo na tela até cada anúncio ser relido.
   */
  refresh(tenantId: string): void {
    void (async () => {
      await this.markStale(tenantId);
      if (this.running.has(tenantId)) return; // a rodada em andamento continua pela fila nova
      while ((await this.scanTenant(tenantId)) > 0) {
        /* lote a lote, no ritmo do PACE_MS */
      }
    })().catch((err) => this.log.error({ err, tenantId }, 'Central de Marketing: análise falhou'));
  }

  /** "Sincronizar" do Dashboard: só marca para reler; o agendador relê aos poucos (sem somar à carga da sincronização). */
  async markStale(tenantId: string): Promise<void> {
    await this.db.withTenant(tenantId, (db) => db.query('UPDATE listing_marketing SET stale = true WHERE NOT stale'));
  }

  /** Um lote por conta; devolve quantos anúncios foram lidos (0 = nada pendente). */
  async scanTenant(tenantId: string, batch = BATCH): Promise<number> {
    if (this.running.has(tenantId)) return 0;
    this.running.add(tenantId);
    let total = 0;
    try {
      const status = await this.ml.status(tenantId);
      for (const c of status.connections.filter((x) => x.status === 'active')) {
        total += await this.scanAccount(tenantId, c.id, batch).catch((err) => {
          this.log.error({ err, tenantId }, 'Central de Marketing: conta do ML falhou na análise');
          return 0;
        });
      }
    } finally {
      this.running.delete(tenantId);
    }
    return total;
  }

  /** Lê no ML os anúncios ativos nunca analisados, marcados para reler ou lidos há mais de uma semana. */
  async scanAccount(tenantId: string, connectionId: string, batch = BATCH): Promise<number> {
    const { conn } = await this.ml.accessToken(tenantId, connectionId);
    const due = await this.db.withTenant(tenantId, async (db) =>
      (
        await db.query<{ external_id: string }>(
          `SELECT l.external_id FROM listings l
             LEFT JOIN listing_marketing m ON m.account_id = l.account_id AND m.item_id = l.external_id
            WHERE l.account_id = $1 AND l.status = 'active' AND l.source = 'marketplace'
              AND (m.checked_at IS NULL OR m.stale OR m.checked_at < now() - make_interval(hours => $2))
            ORDER BY m.checked_at IS NOT NULL, m.checked_at LIMIT $3`,
          [conn.account_id, STALE_HOURS, batch],
        )
      ).rows.map((r) => r.external_id),
    );
    if (!due.length) return 0;
    const pace = this.opts.paceMs ?? PACE_MS;
    const ads = await this.adsByItem(tenantId, connectionId);
    const misses = { clips: 0 };
    let done = 0;
    for (const id of due) {
      const { token } = await this.ml.accessToken(tenantId, connectionId);
      const get = <T>(path: string) => this.api.rawGet<T>(token, path).catch(() => null);
      const promos = await get<Json>(`/seller-promotions/items/${encodeURIComponent(id)}?app_version=v2`);
      const list: Json[] = Array.isArray(promos) ? promos : (promos?.results ?? []);
      const prices = await get<Json>(`/items/${encodeURIComponent(id)}/prices`);
      // atacado (B2B): a lista de preços nem sempre traz as faixas; o preço para empresa comprando muito revela
      const b2b = async (quantity: number) =>
        (
          await get<Json>(
            `/items/${encodeURIComponent(id)}/sale_price?context=channel_marketplace,user_type_business&quantity=${quantity}`,
          )
        )?.amount as number | undefined;
      let wholesale: boolean | null = prices ? hasWholesale(prices) : null;
      if (!wholesale) {
        const one = await b2b(1);
        const many = typeof one === 'number' ? ((await b2b(WHOLESALE_PROBE_QTY)) ?? (await b2b(10))) : undefined;
        if (typeof one === 'number' && typeof many === 'number') wholesale = many < one - 0.01;
      }
      const item = await get<Json>(`/items/${encodeURIComponent(id)}?attributes=id,video_id`);
      let clips: boolean | null = null;
      if (misses.clips < PROBE_LIMIT) {
        const r = await get<Json>(`/marketplace/items/${encodeURIComponent(id)}/clips`);
        if (r === null) misses.clips++;
        else clips = (Array.isArray(r) ? r : (r.results ?? r.clips ?? [])).length > 0;
      }
      const row: Row = {
        item_id: id,
        promos_active: [...new Set(list.filter((p) => ACTIVE_PROMO.has(String(p.status ?? '').toLowerCase())).map((p) => String(p.type)))],
        promos_candidate: [...new Set(list.filter((p) => String(p.status ?? '').toLowerCase() === 'candidate').map((p) => String(p.type)))],
        wholesale,
        clips,
        video: item ? Boolean(item.video_id) : null,
        ads: ads ? (ads.get(id) ?? 'none') : null,
      };
      await this.db.withTenant(tenantId, (db) =>
        db.query(
          `INSERT INTO listing_marketing (tenant_id, account_id, item_id, promos_active, promos_candidate, wholesale, clips, video, ads, checked_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
           ON CONFLICT (tenant_id, account_id, item_id) DO UPDATE SET promos_active = EXCLUDED.promos_active,
             promos_candidate = EXCLUDED.promos_candidate, wholesale = EXCLUDED.wholesale,
             clips = coalesce(EXCLUDED.clips, listing_marketing.clips), video = EXCLUDED.video, ads = EXCLUDED.ads,
             checked_at = now(), stale = false`,
          [tenantId, conn.account_id, id, row.promos_active, row.promos_candidate, row.wholesale, row.clips, row.video, row.ads],
        ),
      );
      done++;
      if (pace) await sleep(pace);
    }
    return done;
  }

  /** Um ciclo do agendador (só uma instância processa cada horário). */
  async tick(now = new Date()): Promise<void> {
    const slot = new Date(Math.floor(now.getTime() / TICK_MS) * TICK_MS);
    if (!(await this.ml.claimSlot('marketing_scan', slot))) return;
    const tenants = [...new Set((await this.ml.activeConnections()).map((c) => c.tenantId))];
    for (const tenantId of tenants) await this.scanTenant(tenantId);
  }

  startScheduler(): () => void {
    let timer: NodeJS.Timeout;
    const schedule = () => {
      const now = Date.now();
      // fora dos picos das vendas (hh:00) e das devoluções (múltiplos de 10 min + 30 s)
      const next = Math.floor(now / TICK_MS) * TICK_MS + TICK_MS + 5 * 60_000;
      timer = setTimeout(() => {
        this.tick().catch((err) => this.log.error({ err }, 'Central de Marketing: agendador falhou'));
        schedule();
      }, next - now);
      timer.unref();
    };
    schedule();
    return () => clearTimeout(timer);
  }

  private stat(rows: Row[], tool: MarketingTool): MarketingToolStat {
    let using = 0;
    let notUsing = 0;
    let eligible = 0;
    for (const r of rows) {
      const u = uses(r, tool);
      if (u === null) continue;
      if (u) using++;
      else {
        notUsing++;
        if (eligibleFor(r, tool)) eligible++;
      }
    }
    return { tool, using, notUsing, eligible, available: using + notUsing > 0 };
  }

  private async analyzed(db: Queryable, accountId: string): Promise<Row[]> {
    const { rows } = await db.query<Row>(
      `SELECT m.item_id, m.promos_active, m.promos_candidate, m.wholesale, m.clips, m.video, m.ads
         FROM listing_marketing m JOIN listings l ON l.account_id = m.account_id AND l.external_id = m.item_id
        WHERE m.account_id = $1 AND l.status = 'active'`,
      [accountId],
    );
    return rows;
  }

  /** Campanhas abertas para a conta agora (o que o ML oferece a ela), por tipo. */
  private async openCampaigns(tenantId: string, connectionId: string, userId: string) {
    const key = `mkt:campaigns:${tenantId}:${connectionId}`;
    const hit = await this.cache.get<{ type: string; count: number }[]>(key);
    if (hit) return hit;
    const { token } = await this.ml.accessToken(tenantId, connectionId);
    const r = await this.api.rawGet<Json>(token, `/seller-promotions/users/${encodeURIComponent(userId)}?app_version=v2`).catch(() => null);
    const counts = new Map<string, number>();
    for (const p of (r?.results ?? []) as Json[]) {
      const st = String(p.status ?? '').toLowerCase();
      if (st === 'started' || st === 'pending') counts.set(String(p.type), (counts.get(String(p.type)) ?? 0) + 1);
    }
    const out = [...counts.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count);
    await this.cache.set(key, out, CAMPAIGNS_TTL);
    return out;
  }

  /** Situação no Mercado Ads de cada anúncio da conta (uma busca paginada por ciclo); null = sem leitura. */
  private async adsByItem(tenantId: string, connectionId: string): Promise<Map<string, string> | null> {
    const { token, conn } = await this.ml.accessToken(tenantId, connectionId);
    const adv = await this.db.withTenant(tenantId, async (db) =>
      (await db.query<{ advertiser_id: string | null }>('SELECT advertiser_id FROM ad_accounts WHERE account_id = $1', [conn.account_id])).rows[0]
        ?.advertiser_id ?? null,
    );
    if (!adv) return null;
    const out = new Map<string, string>();
    for (let offset = 0, total = 1; offset < total && offset < 10_000; offset += 100) {
      const page = await this.api
        .rawGet<Json>(token, `/advertising/MLB/advertisers/${encodeURIComponent(adv)}/product_ads/ads/search?limit=100&offset=${offset}`)
        .catch(() => null);
      if (!page) return offset === 0 ? null : out;
      total = Number(page.paging?.total ?? 0);
      for (const a of (page.results ?? []) as Json[]) if (a.item_id) out.set(String(a.item_id), String(a.status ?? 'none').toLowerCase());
      if (!(page.results ?? []).length) break;
    }
    return out;
  }
}

/** Atacado: preço com mínimo de unidades (faixas por quantidade) ou restrito a compradores empresa. */
export function hasWholesale(prices: Json): boolean {
  const list: Json[] = prices?.prices ?? [];
  return list.some(
    (p) =>
      Number(p?.conditions?.min_purchase_unit ?? 0) > 1 ||
      (p?.conditions?.context_restrictions ?? []).some((c: string) => String(c).includes('business')),
  );
}
