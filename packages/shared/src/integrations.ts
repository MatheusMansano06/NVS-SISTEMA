export const SYNC_PHASES = ['profile', 'orders_recent', 'listings', 'orders_history', 'shipping_costs', 'finishing'] as const;
export type SyncPhase = (typeof SYNC_PHASES)[number];

export const SYNC_PHASE_LABELS: Record<SyncPhase, string> = {
  profile: 'Perfil da conta',
  orders_recent: 'Pedidos dos últimos 30 dias',
  listings: 'Anúncios e fotos',
  orders_history: 'Histórico de 31 a 90 dias',
  shipping_costs: 'Fretes, cupons e devoluções',
  finishing: 'Últimos ajustes: endereços, frete pago e fatura',
};

/** Progresso (0–100) ao concluir cada etapa: o sistema vai se preenchendo por partes. */
export const SYNC_PHASE_END: Record<SyncPhase, number> = {
  profile: 10,
  orders_recent: 45,
  listings: 60,
  orders_history: 85,
  shipping_costs: 92,
  finishing: 100,
};

export interface SyncRunDto {
  status: 'running' | 'done' | 'failed';
  phase: SyncPhase;
  progress: number;
  ordersImported: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface MlConnectionDto {
  id: string;
  accountId: string;
  nickname: string;
  mlUserId: string;
  status: 'active' | 'revoked' | 'error';
  lastError: string | null;
  /** Sincronização completa (a que preenche o sistema por etapas). */
  sync: SyncRunDto | null;
  /** Última atualização concluída (completa ou automática de hora em hora). */
  lastSyncedAt: string | null;
  /** Histórico de vendas guardado no banco, mês a mês (busca em segundo plano depois da sincronização completa). */
  history: { monthsDone: number; monthsTotal: number; running: boolean };
}

/** Os números se atualizam de hora em hora; pedidos e anúncios chegam na hora (notificações). */
export const AUTO_SYNC_INTERVAL_MINUTES = 60;

export interface MlStatusDto {
  configured: boolean;
  connections: MlConnectionDto[];
}

/** Loja do TikTok Shop conectada. As vendas dela aparecem só na Análise Financeira (aba TikTok Shop). */
export interface TiktokConnectionDto {
  id: string;
  accountId: string;
  nickname: string;
  shopId: string;
  status: 'active' | 'revoked' | 'error';
  lastError: string | null;
  syncing: boolean;
  /** Aviso da última sincronização (ex.: extrato financeiro indisponível → tarifas estimadas). */
  syncError: string | null;
  ordersImported: number;
  /** Histórico de vendas já trazido por completo. */
  historyDone: boolean;
  lastSyncedAt: string | null;
}

export interface TiktokStatusDto {
  /** Integração configurada no ambiente E liberada para a empresa. */
  configured: boolean;
  connections: TiktokConnectionDto[];
}

/** Loja da Shopee conectada. As vendas dela aparecem só na Análise Financeira (aba Shopee). */
export interface ShopeeConnectionDto extends TiktokConnectionDto {
  /** Fim da autorização da loja (até 1 ano); depois disso é preciso conectar de novo. */
  authExpiresAt: string | null;
}

/** Funil do Seller Center no período: pedidos feitos (pela criação, inclusive os nunca pagos) e pagos (pelo pagamento). */
export interface ShopeeFunnelDto {
  feitos: { pedidos: number; valor: number };
  pagos: { pedidos: number; valor: number };
}

export interface ShopeeStatusDto {
  /** Integração configurada no ambiente E liberada para a empresa. */
  configured: boolean;
  connections: ShopeeConnectionDto[];
}
