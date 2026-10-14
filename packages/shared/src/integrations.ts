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
}

/** Os números se atualizam de hora em hora; pedidos e anúncios chegam na hora (notificações). */
export const AUTO_SYNC_INTERVAL_MINUTES = 60;

export interface MlStatusDto {
  configured: boolean;
  connections: MlConnectionDto[];
}
