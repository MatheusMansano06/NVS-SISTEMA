import { useEffect, useState, type FormEvent } from 'react';
import { LOGISTIC_LABELS, type LowMarginDto, type Marketplace } from '@nvs/shared';
import { navigate } from '../../../app/router';
import { ApiError } from '../../../shared/http';
import { int, money, pct } from '../../../shared/format';
import { useAuth } from '../../auth/AuthContext';
import { financeApi } from '../../finance/finance-api';
import { ProductThumb } from './ProductThumb';

const shortDay = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

interface Props {
  range: { from: string; to: string };
  marketplace?: Marketplace;
  accountId?: string;
  /** Muda a cada atualização do dashboard: recarrega o alerta. */
  stamp: string;
}

/** Alerta: vendas aprovadas do período com margem de contribuição abaixo do mínimo da empresa (configurável aqui). */
export function LowMarginAlert({ range, marketplace, accountId, stamp }: Props) {
  const { session } = useAuth();
  const canEdit = session?.user.role !== 'viewer';
  const [data, setData] = useState<LowMarginDto | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    financeApi
      .lowMargin({ from: range.from, to: range.to, marketplace, accountId }, ctrl.signal)
      .then((r) => {
        setData(r);
        setError('');
      })
      .catch((e) => {
        if (!ctrl.signal.aborted) setError(e instanceof ApiError ? e.message : 'Não foi possível carregar o alerta de margem.');
      });
    return () => ctrl.abort();
  }, [range.from, range.to, marketplace, accountId, stamp, reload]);

  async function save(e: FormEvent) {
    e.preventDefault();
    const n = Number(draft.replace(',', '.'));
    if (!Number.isFinite(n) || n < -100 || n > 100) return;
    setSaving(true);
    try {
      await financeApi.setLowMargin(n);
      setEditing(false);
      setReload((x) => x + 1);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível salvar o mínimo.');
    } finally {
      setSaving(false);
    }
  }

  const min = data?.minPct ?? 8;
  return (
    <section className="lowm" data-alert={data && data.total > 0 ? true : undefined} aria-label="Vendas com margem baixa">
      <header className="lowm-head">
        <div>
          <h2>
            Vendas com margem baixa
            {data && <span className="lowm-count">{int(data.total)}</span>}
          </h2>
          <small>Margem de contribuição abaixo de {pct(min / 100)} no período</small>
        </div>
        {editing ? (
          <form className="lowm-form" onSubmit={save}>
            <label>
              Mínimo
              <input value={draft} onChange={(e) => setDraft(e.target.value)} inputMode="decimal" autoFocus aria-label="Margem mínima em %" />
              %
            </label>
            <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>{saving ? 'Salvando…' : 'Salvar'}</button>
            <button type="button" className="link" onClick={() => setEditing(false)}>Cancelar</button>
          </form>
        ) : (
          canEdit && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setDraft(String(min).replace('.', ',')); setEditing(true); }}>
              Mínimo: {pct(min / 100)} · alterar
            </button>
          )
        )}
      </header>

      {error && <p className="banner banner-error" role="alert">{error}</p>}
      {data && data.total > 0 && (
        <p className="lowm-gap">
          Se todas tivessem batido {pct(min / 100)}, sobrariam mais <b className="money">{money(data.gap)}</b>.
        </p>
      )}
      {data && data.total === 0 && <p className="lowm-ok">Nenhuma venda abaixo de {pct(min / 100)} neste período. 👏</p>}

      {data && data.items.length > 0 && (
        <ul className="lowm-list">
          {data.items.slice(0, 8).map((s) => (
            <li key={s.orderId}>
              <ProductThumb src={s.pictureUrl} alt={s.title} />
              <span className="lowm-title">
                <b title={s.title}>{s.title}</b>
                <small>{s.sku} · pedido {s.orderId} · {shortDay(s.date)} · {LOGISTIC_LABELS[s.bucket]}</small>
              </span>
              <span className="lowm-num">
                <b className="money">{money(s.faturamento)}</b>
                <small className="money">MC {money(s.mc)}</small>
              </span>
              <span className="lowm-pct" data-neg={s.mcPct < 0 || undefined}>{pct(s.mcPct / 100)}</span>
            </li>
          ))}
        </ul>
      )}
      {data && (data.total > 8 || data.semCusto > 0) && (
        <p className="lowm-foot">
          {data.total > 8 && <>Mostrando as 8 piores de {int(data.total)}. </>}
          {data.semCusto > 0 && <>{int(data.semCusto)} venda(s) sem custo cadastrado ficam fora do alerta. </>}
          <button type="button" className="link" onClick={() => navigate('/financeiro')}>Ver na Análise Financeira →</button>
        </p>
      )}
    </section>
  );
}
