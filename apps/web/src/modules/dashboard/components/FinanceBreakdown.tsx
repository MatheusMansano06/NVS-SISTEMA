import { useEffect, useState } from 'react';
import { LOGISTIC_BUCKETS, LOGISTIC_LABELS, type FinanceSummaryDto, type Marketplace } from '@nvs/shared';
import { navigate } from '../../../app/router';
import { ApiError } from '../../../shared/http';
import { int, money, pct } from '../../../shared/format';
import { financeApi } from '../../finance/finance-api';

const OPEN_KEY = 'nvs.financeOpen';
const FC_KEY = 'nvs.financeFc';
const readFlag = (key: string) => {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
};
const saveFlag = (key: string, v: boolean) => {
  try {
    localStorage.setItem(key, v ? '1' : '0');
  } catch {
    /* vale só para esta sessão */
  }
};

interface Props {
  range: { from: string; to: string };
  marketplace?: Marketplace;
  accountId?: string;
  adSpend: number;
  discountAds: boolean;
  /** Muda a cada atualização do dashboard: recarrega o detalhamento aberto. */
  stamp: string;
}

/** Detalhamento financeiro do período (mesmos números da Análise Financeira), recolhível. Só busca quando aberto. */
export function FinanceBreakdown({ range, marketplace, accountId, adSpend, discountAds, stamp }: Props) {
  const [open, setOpen] = useState(() => readFlag(OPEN_KEY));
  const [fc, setFc] = useState(() => readFlag(FC_KEY));
  const [data, setData] = useState<FinanceSummaryDto | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    setError('');
    financeApi
      .summary({ from: range.from, to: range.to, marketplace, accountId, considerarFreteComprador: fc }, false, ctrl.signal)
      .then(setData)
      .catch((e) => {
        if (!ctrl.signal.aborted) setError(e instanceof ApiError ? e.message : 'Não foi possível carregar o detalhamento.');
      });
    return () => ctrl.abort();
  }, [open, fc, range.from, range.to, marketplace, accountId, stamp]);

  const toggle = () => setOpen((v) => (saveFlag(OPEN_KEY, !v), !v));
  const toggleFc = () => setFc((v) => (saveFlag(FC_KEY, !v), !v));
  const c = data?.cards;
  const share = (v: number) => (c && c.faturamento > 0 ? pct(v / c.faturamento) : '—');
  const custoImposto = c && c.custoTotal !== null ? c.custoTotal + (c.impostoTotal ?? 0) : null;
  const mcAds = c && c.mcTotal !== null ? c.mcTotal - adSpend : null;
  // margem depois dos Ads = margem − TACOS (Ads ÷ receita bruta), a mesma conta da Análise Financeira
  const mcPctAds = c && c.mcPct !== null && c.vendasAprovadas > 0 ? c.mcPct - (adSpend / c.vendasAprovadas) * 100 : null;
  const byBucket = new Map(data?.breakdown.map((b) => [b.bucket, b.valor]) ?? []);

  return (
    <section className="fb" data-open={open || undefined} aria-label="Detalhamento financeiro">
      <button type="button" className="fb-head" aria-expanded={open} onClick={toggle}>
        <span className="fb-title">
          <strong>Detalhamento financeiro</strong>
          <small>Vendas, custos, tarifas, frete e margem de contribuição do período</small>
        </span>
        <span className="fb-chevron" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
        </span>
      </button>

      {open && (
        <div className="fb-body">
          {error && <p className="banner banner-error" role="alert">{error}</p>}
          {!c ? (
            !error && <div className="fb-grid" aria-busy="true">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="fb-card skeleton" />)}</div>
          ) : (
            <>
              <div className="fb-grid">
                <article className="fb-card" data-tone="purple">
                  <div className="fb-main">
                    <span>Vendas aprovadas</span>
                    <b className="money">{money(c.vendasAprovadas)}</b>
                    <label className="ads-toggle fb-fc">
                      <input type="checkbox" checked={fc} onChange={toggleFc} />
                      <span className="ads-switch" aria-hidden="true" />
                      Considerar frete comprador
                    </label>
                  </div>
                  <dl className="fb-side">
                    <div><dt>Faturamento ML</dt><dd className="money">{money(c.faturamento)}</dd></div>
                    <div><dt>Vendas canceladas</dt><dd className="money">{money(c.vendasCanceladas)}</dd></div>
                  </dl>
                </article>

                <article className="fb-card" data-tone="red">
                  <div className="fb-main">
                    <span>Custo &amp; imposto</span>
                    <b className="money">{custoImposto === null ? '—' : money(custoImposto)}</b>
                    {custoImposto === null && <small>cadastre os custos dos SKUs</small>}
                  </div>
                  <dl className="fb-side">
                    <div><dt>Custo</dt><dd className="money">{c.custoTotal === null ? '—' : money(c.custoTotal)}</dd></div>
                    <div><dt>Imposto</dt><dd className="money">{c.impostoTotal === null ? '—' : money(c.impostoTotal)}</dd></div>
                  </dl>
                </article>

                <article className="fb-card" data-tone="yellow">
                  <div className="fb-main">
                    <span>Tarifa de venda</span>
                    <b className="money">{money(c.tarifa)}</b>
                    <small>{share(c.tarifa)} do faturamento</small>
                  </div>
                  <dl className="fb-side">
                    <div><dt>Cupons seller</dt><dd className="money">{money(c.cupomSeller)}</dd></div>
                  </dl>
                </article>

                <article className="fb-card" data-tone="blue">
                  <div className="fb-main">
                    <span>Frete total</span>
                    <b className="money">{money(c.freteComprador + c.freteVendedor)}</b>
                  </div>
                  <dl className="fb-side">
                    <div><dt>Frete comprador</dt><dd className="money">{money(c.freteComprador)}</dd></div>
                    <div><dt>Frete vendedor</dt><dd className="money">{money(c.freteVendedor)}</dd></div>
                  </dl>
                </article>

                <article className="fb-card" data-tone="green">
                  <div className="fb-main">
                    <span>Margem de contribuição</span>
                    <b className="money">{c.mcTotal === null ? '—' : money(c.mcTotal)}</b>
                    <small>{c.mcPct === null ? 'cadastre os custos dos SKUs' : pct(c.mcPct / 100, 2)}</small>
                  </div>
                  {discountAds && mcAds !== null && adSpend > 0 && (
                    <dl className="fb-side">
                      <div><dt>Depois dos Ads</dt><dd className="money">{money(mcAds)}</dd></div>
                      <div>
                        <dt>Margem</dt>
                        <dd>{mcPctAds === null ? '—' : pct(mcPctAds / 100, 2)}</dd>
                      </div>
                    </dl>
                  )}
                </article>
              </div>

              <div className="fb-grid fb-row2">
                <article className="fb-card fb-logi">
                  <dl>
                    {LOGISTIC_BUCKETS.map((b) => (
                      <div key={b}><dt>{LOGISTIC_LABELS[b]}</dt><dd className="money">{money(byBucket.get(b) ?? 0)}</dd></div>
                    ))}
                    <div className="fb-total"><dt>Total</dt><dd className="money">{money(c.vendasAprovadas)}</dd></div>
                  </dl>
                </article>

                <article className="fb-card">
                  <div className="fb-main">
                    <span>Qtd. vendas aprovadas</span>
                    <b>{int(c.qtdAprovadas)}</b>
                    <small>{int(c.unidades)} unidades</small>
                  </div>
                  <dl className="fb-side">
                    <div><dt>Canceladas</dt><dd>{int(c.qtdCanceladas)}</dd></div>
                  </dl>
                </article>

                <article className="fb-card">
                  <div className="fb-main">
                    <span>Ticket médio por venda</span>
                    <b className="money">{money(c.ticketMedio)}</b>
                    <small>vendas aprovadas</small>
                  </div>
                </article>

                <article className="fb-card">
                  <div className="fb-main">
                    <span>Ticket médio da margem</span>
                    <b className="money">{c.ticketMc === null ? '—' : money(c.ticketMc)}</b>
                    <small>{c.mcPct === null ? 'por venda aprovada' : `${pct(c.mcPct / 100, 2)} por venda`}</small>
                  </div>
                </article>

                <article className="fb-card">
                  <div className="fb-main">
                    <span>Devoluções parciais</span>
                    <b className="money">{money(c.devolucoesParciais)}</b>
                    <small>{int(c.qtdDevolucoes)} venda(s)</small>
                  </div>
                </article>
              </div>

              <p className="fb-foot">
                {data.semCusto.qtd > 0 && <>{int(data.semCusto.qtd)} venda(s) sem custo cadastrado ficam fora da margem. </>}
                <button type="button" className="link" onClick={() => navigate('/financeiro')}>Abrir Análise Financeira completa →</button>
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
