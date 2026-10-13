import { PERIODS, PERIOD_LABELS, type DashboardDto, type Marketplace } from '@nvs/shared';
import { Icon } from '../../../shared/ui/Icon';
import type { DashboardFilters } from '../dashboard-api';

const MARKETPLACE_OPTIONS: { id: Marketplace; label: string; soon?: boolean }[] = [
  { id: 'mercado_livre', label: 'Mercado Livre' },
  { id: 'shopee', label: 'Shopee', soon: true },
  { id: 'tiktok_shop', label: 'TikTok Shop', soon: true },
];

interface Props {
  filters: DashboardFilters;
  onChange: (f: DashboardFilters) => void;
  accounts: DashboardDto['accounts'];
  hidden: boolean;
  onToggleHidden: () => void;
  onRefresh: () => void;
  loading: boolean;
  updatedAt?: string;
}

export function FilterBar({ filters, onChange, accounts, hidden, onToggleHidden, onRefresh, loading, updatedAt }: Props) {
  const activeIndex = PERIODS.indexOf(filters.period);
  const visibleAccounts = accounts.filter((a) => !filters.marketplace || a.marketplace === filters.marketplace);

  return (
    <div className="filters" role="toolbar" aria-label="Filtros do dashboard">
      <div className="periods" role="radiogroup" aria-label="Período" style={{ ['--i' as string]: activeIndex, ['--n' as string]: PERIODS.length }}>
        <span className="periods-thumb" aria-hidden="true" />
        {PERIODS.map((p) => (
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
            value={filters.marketplace ?? ''}
            onChange={(e) =>
              onChange({ ...filters, marketplace: (e.target.value || undefined) as Marketplace | undefined, accountId: undefined })
            }
          >
            <option value="">Marketplaces</option>
            {MARKETPLACE_OPTIONS.map((m) => (
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
