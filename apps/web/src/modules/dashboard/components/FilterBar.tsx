import { PERIODS, PERIOD_LABELS, type DashboardDto, type Marketplace, type Period } from '@nvs/shared';
import { Icon } from '../../../shared/ui/Icon';
import type { DashboardFilters } from '../dashboard-api';

const MARKETPLACE_OPTIONS: { id: Marketplace; label: string; soon?: boolean }[] = [
  { id: 'mercado_livre', label: 'Mercado Livre' },
  { id: 'shopee', label: 'Shopee' },
  { id: 'tiktok_shop', label: 'TikTok Shop' },
];

interface Props {
  filters: DashboardFilters;
  onChange: (f: DashboardFilters) => void;
  accounts: DashboardDto['accounts'];
  /** Empresa com o TikTok Shop liberado (recurso `tiktok_shop`). */
  tiktok: boolean;
  /** Empresa com a Shopee liberada (recurso `shopee`). */
  shopee: boolean;
  hidden: boolean;
  onToggleHidden: () => void;
  onRefresh: () => void;
  loading: boolean;
  updatedAt?: string;
}

export function FilterBar({ filters, onChange, accounts, tiktok, shopee, hidden, onToggleHidden, onRefresh, loading, updatedAt }: Props) {
  // um marketplace por vez, nunca somados: sem escolha = Mercado Livre
  const marketplace = filters.marketplace ?? 'mercado_livre';
  // fatura é do Mercado Livre
  const periods: readonly Period[] = marketplace === 'mercado_livre' ? PERIODS : PERIODS.filter((p) => p !== 'invoice');
  const activeIndex = periods.indexOf(filters.period);
  const visibleAccounts = accounts.filter((a) => a.marketplace === marketplace);
  const options = MARKETPLACE_OPTIONS.filter((m) => (m.id === 'tiktok_shop' ? tiktok : m.id === 'shopee' ? shopee : true));

  return (
    <div className="filters" role="toolbar" aria-label="Filtros do dashboard">
      <div className="periods" role="radiogroup" aria-label="Período" style={{ ['--i' as string]: activeIndex, ['--n' as string]: periods.length }}>
        <span className="periods-thumb" aria-hidden="true" />
        {periods.map((p) => (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={filters.period === p}
            onClick={() => onChange({ ...filters, period: p })}
          >
            {PERIOD_LABELS[p]}
          </button>
        ))}
      </div>

      <div className="filters-right">
        <label className="select">
          <span className="sr-only">Marketplace</span>
          <select
            value={marketplace}
            onChange={(e) => {
              const next = e.target.value as Marketplace;
              const period = next !== 'mercado_livre' && filters.period === 'invoice' ? 'this_month' : filters.period;
              onChange({ ...filters, period, marketplace: next === 'mercado_livre' ? undefined : next, accountId: undefined });
            }}
          >
            {options.map((m) => (
              <option key={m.id} value={m.id} disabled={m.soon}>
                {m.label}
                {m.soon ? ' (em breve)' : ''}
              </option>
            ))}
          </select>
          <Icon name="chevron" size={16} />
        </label>

        <label className="select">
          <span className="sr-only">Conta</span>
          <select value={filters.accountId ?? ''} onChange={(e) => onChange({ ...filters, accountId: e.target.value || undefined })}>
            <option value="">Contas</option>
            {visibleAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.nickname}
              </option>
            ))}
          </select>
          <Icon name="chevron" size={16} />
        </label>

        <button type="button" className="icon-btn" onClick={onToggleHidden} aria-pressed={hidden} aria-label={hidden ? 'Mostrar valores' : 'Ocultar valores'} title={hidden ? 'Mostrar valores' : 'Ocultar valores'}>
          <Icon name={hidden ? 'eyeOff' : 'eye'} />
        </button>
        <button type="button" className="icon-btn" onClick={onRefresh} aria-label="Atualizar dados" title="Atualizar dados" data-spinning={loading || undefined}>
          <Icon name="refresh" />
        </button>
        {updatedAt && (
          <span className="updated" aria-live="polite">
            Atualizado às {new Date(updatedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
      </div>
    </div>
  );
}
