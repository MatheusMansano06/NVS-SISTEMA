import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LOGISTIC_LABELS, marginBand, type FinanceSummaryDto, type MlStatusDto } from '@nvs/shared';
import { AppShell } from '../../app/AppShell';
import { navigate } from '../../app/router';
import { int, money, pct } from '../../shared/format';
import { Icon } from '../../shared/ui/Icon';
import { mlApi } from '../mercado-livre/ml-api';
import { AreaChart } from './components/AreaChart';
import { Donut } from './components/Donut';
import { FinanceTable } from './components/FinanceTable';
import { PRESETS, presetRange, shortDay, type PresetId } from './dates';
import { financeApi, type FinanceFilters, type LineFilters } from './finance-api';
import '../dashboard/dashboard.css';
import './finance.css';

/** Análise Financeira: margem de contribuição, composição e vendas detalhadas (regras NVS-WMS). */
export function FinancePage() {
  const [preset, setPreset] = useState<PresetId | null>('30d');
  const [range, setRange] = useState(() => presetRange('30d'));
  const [accountId, setAccountId] = useState('');
  const [considerarFc, setConsiderarFc] = useState(false);
  const [accounts, setAccounts] = useState<MlStatusDto['connections']>([]);
  const [data, setData] = useState<FinanceSummaryDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tableFilter, setTableFilter] = useState<LineFilters>({});
  const [version, setVersion] = useState(0);
  const ctrl = useRef<AbortController | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);

  const filters: FinanceFilters = useMemo(
    () => ({ from: range.from, to: range.to, accountId: accountId || undefined, considerarFreteComprador: considerarFc || undefined }),
    [range, accountId, considerarFc],
  );

  useEffect(() => {
    mlApi.status().then((s) => setAccounts(s.connections)).catch(() => undefined);
  }, []);

  const load = useCallback(
    async (fresh = false) => {
      ctrl.current?.abort();
      const c = new AbortController();
      ctrl.current = c;
      setLoading(true);
      setError('');
      try {
        setData(await financeApi.summary(filters, fresh, c.signal));
        if (fresh) setVersion((v) => v + 1);
      } catch (err) {
        if ((err as Error).name !== 'AbortError') setError('Não foi possível carregar a análise.');
      } finally {
        if (ctrl.current === c) setLoading(false);
      }
    },
    [filters],
  );
  useEffect(() => void load(), [load]);

  const pick = (id: PresetId) => {
    setPreset(id);
    setRange(presetRange(id));
  };
  const showNoCost = () => {
    setTableFilter({ custo: 'sem_custo' });
    tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const c = data?.cards;
  const band = c?.mcPct != null ? marginBand(c.mcPct) : null;

  return (
    <AppShell>
      <div className="fin-page" data-loading={loading || undefined}>
        <header className="dash-head">
          <div>
            <p className="dash-kicker">Financeiro</p>
            <h1>Análise Financeira</h1>
          </div>
          <div className="mkt-tabs" role="tablist" aria-label="Marketplace">
            <button type="button" role="tab" aria-selected="true">Mercado Livre</button>
            <button type="button" role="tab" aria-selected="false" disabled title="Em breve">Shopee <small>em breve</small></button>
          </div>
        </header>

        <div className="fin-filters" role="toolbar" aria-label="Período">
          <div className="presets">
            {PRESETS.map((p) => (
              <button key={p.id} type="button" aria-pressed={preset === p.id} onClick={() => pick(p.id)}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="range">
            <label>
              <span>De</span>
              <input
                type="date"
                value={range.from}
                max={range.to}
                onChange={(e) => {
                  setPreset(null);
                  setRange((r) => ({ ...r, from: e.target.value }));
                }}
              />
            </label>
            <span aria-hidden="true">→</span>
            <label>
              <span>Até</span>
              <input
                type="date"
                value={range.to}
                min={range.from}
                onChange={(e) => {
                  setPreset(null);
                  setRange((r) => ({ ...r, to: e.target.value }));
                }}
              />
            </label>
          </div>
          {accounts.length > 1 && (
            <label className="select">
              <span className="sr-only">Conta</span>
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                <option value="">Todas as contas</option>
                {accounts.map((a) => (
                  <option key={a.accountId} value={a.accountId}>{a.nickname}</option>
                ))}
              </select>
              <Icon name="chevron" size={16} />
            </label>
          )}
          <button type="button" className="icon-btn" onClick={() => void load(true)} aria-label="Atualizar" data-spinning={loading || undefined}>
            <Icon name="refresh" />
          </button>
        </div>

        {error && <p className="banner banner-error" role="alert">{error}</p>}

        {data && data.semCusto.qtd > 0 && (
          <div className="nocost-banner" role="note">
            <span className="nocost-icon" aria-hidden="true">!</span>
            <p>
              <strong>{data.semCusto.qtd} venda(s), {money(data.semCusto.valor)}, ficaram fora da margem por falta de custo</strong>
              {data.semCusto.skus.length > 0 && ` (${data.semCusto.skus.slice(0, 4).join(', ')}${data.semCusto.skus.length > 4 ? '…' : ''})`}.
              Cadastre o custo e a análise se atualiza sozinha.
            </p>
            <button type="button" className="btn btn-ghost btn-sm" onClick={showNoCost}>Ver vendas sem custo</button>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => navigate('/skus')}>Cadastrar custos</button>
          </div>
        )}
        {data && data.enriquecimentoPendente > 0 && (
          <p className="banner banner-ok" role="status">
            Fretes, cupons e devoluções de {int(data.enriquecimentoPendente)} venda(s) ainda estão sendo calculados pela
            sincronização com o Mercado Livre. Os números se completam sozinhos.
          </p>
        )}

        {!data && loading ? (
          <div className="fin-grid"><div className="kpi skeleton fin-hero" /><div className="kpi skeleton" /><div className="kpi skeleton" /></div>
        ) : c ? (
          <>
            <section className="fin-grid">
              <article className="fin-hero">
                <span className="fin-label">Vendas aprovadas</span>
                <p className="fin-big money">{money(c.vendasAprovadas)}</p>
                <p className="fin-sub">
                  Cancel. <b className="money">{money(c.vendasCanceladas)}</b> · Dev. parcial <b className="money">{money(c.devolucoesParciais)}</b>{' '}
                  · Faturamento <b className="money">{money(c.faturamento)}</b>
                </p>
                <AreaChart
                  tone="dark"
                  values={data.series.map((s) => s.aprovadas)}
                  labels={data.series.map((s) => shortDay(s.day))}
                  format={money}
                  height={170}
                  ariaLabel="Vendas aprovadas por dia"
                />
              </article>

              <article className="fin-card fin-mc" data-band={band ?? undefined}>
                <span className="fin-label">Margem de contribuição</span>
                <p className="fin-pct">{c.mcPct === null ? '—' : pct(c.mcPct / 100, 2)}</p>
                <p className="fin-sub">
                  <b className="money">{c.mcTotal === null ? '—' : money(c.mcTotal)}</b> no período
                  {c.ticketMc !== null && <> · <b className="money">{money(c.ticketMc)}</b> por venda</>}
                </p>
                <AreaChart
                  tone="light"
                  values={data.series.map((s) => s.mc)}
                  labels={data.series.map((s) => shortDay(s.day))}
                  format={money}
                  height={90}
                  ariaLabel="Margem de contribuição por dia"
                />
              </article>

              <article className="fin-card">
                <span className="fin-label">Composição</span>
                {data.composicao.length ? (
                  <Donut parts={data.composicao} mcPct={c.mcPct} />
                ) : (
                  <p className="empty">Cadastre os custos para ver a composição da margem.</p>
                )}
              </article>
            </section>

            <section className="fin-minis" aria-label="Indicadores">
              <div>
                <span>Tarifa ML</span>
                <b className="neg money">{money(c.tarifa)}</b>
                <small>{c.faturamento ? pct(c.tarifa / c.faturamento) : '0%'} do faturamento</small>
              </div>
              <div>
                <span>Cupons seller</span>
                <b className="neg money">{money(c.cupomSeller)}</b>
                <small>descontos bancados por você</small>
              </div>
              <div>
                <span>Frete total</span>
                <b className="money">{money(c.freteComprador + c.freteVendedor)}</b>
                <small>Comp. {money(c.freteComprador)} · Vend. {money(c.freteVendedor)}</small>
              </div>
              <div>
                <span>Custo + imposto</span>
                <b className="money">{c.custoTotal === null ? '—' : money((c.custoTotal ?? 0) + (c.impostoTotal ?? 0))}</b>
                <small>{c.impostoTotal === null ? 'cadastre os custos' : `Imposto ${money(c.impostoTotal)}`}</small>
              </div>
              <div>
                <span>Vendas</span>
                <b>{int(c.qtdAprovadas)}</b>
                <small>{int(c.unidades)} unid. · {c.qtdCanceladas} cancel. · {c.qtdDevolucoes} dev.</small>
              </div>
              <div>
                <span>Ticket médio</span>
                <b className="money">{money(c.ticketMedio)}</b>
                <small>por venda aprovada</small>
              </div>
            </section>

            {data.breakdown.length > 0 && (
              <section className="panel logistics" aria-label="Vendas por modalidade de frete">
                <span className="fin-label">Vendas por modalidade de frete</span>
                <div className="logi-bar">
                  {data.breakdown.map((b) => (
                    <span key={b.bucket} data-b={b.bucket} style={{ flexGrow: Math.max(b.valor, 0.0001) }} title={`${LOGISTIC_LABELS[b.bucket]}: ${money(b.valor)}`} />
                  ))}
                </div>
                <ul className="logi-legend">
                  {data.breakdown.map((b) => (
                    <li key={b.bucket}>
                      <i data-b={b.bucket} aria-hidden="true" />
                      {LOGISTIC_LABELS[b.bucket]} <b className="money">{money(b.valor)}</b>
                      <small>{c.vendasAprovadas ? pct(b.valor / c.vendasAprovadas) : ''}</small>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <div ref={tableRef}>
              <FinanceTable filters={filters} initial={tableFilter} version={version} onConsiderarFc={setConsiderarFc} />
            </div>
          </>
        ) : null}
      </div>
    </AppShell>
  );
}
