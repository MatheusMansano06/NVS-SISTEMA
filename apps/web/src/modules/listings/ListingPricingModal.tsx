import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ListingDto, ListingPricingDto } from '@nvs/shared';
import { money, pct } from '../../shared/format';
import { ApiError } from '../../shared/http';
import { Button } from '../../shared/ui/Button';
import { skusApi } from '../skus/skus-api';
import { listingsApi } from './listings-api';

const toInput = (n: number | null) => (n === null ? '' : n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const parse = (s: string): number | null => {
  const t = s.replace(/[R$\s%]/g, '').replace(/\./g, '').replace(',', '.');
  const n = Number(t);
  return t && Number.isFinite(n) ? n : null;
};

interface Props {
  item: ListingDto;
  canManage: boolean;
  onSaved: () => void;
}

/** Preço e margem: simula tarifa/frete reais para um novo preço, edita o custo e aplica no marketplace. */
export function ListingPricingModal({ item, canManage, onSaved }: Props) {
  const [price, setPrice] = useState(toInput(item.price));
  const [cost, setCost] = useState(toInput(item.cost));
  const [sim, setSim] = useState<ListingPricingDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState('');
  const ctrl = useRef<AbortController | null>(null);

  const priceNum = parse(price);
  const costNum = parse(cost);

  // simula ao vivo (com atraso) quando o preço muda
  useEffect(() => {
    if (!priceNum || priceNum <= 0) return;
    const t = window.setTimeout(async () => {
      ctrl.current?.abort();
      const c = new AbortController();
      ctrl.current = c;
      setLoading(true);
      setError('');
      try {
        setSim(await listingsApi.pricing(item.id, priceNum === item.price ? undefined : priceNum, c.signal));
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setSim(null);
          setError(err instanceof ApiError ? err.message : 'Não foi possível simular agora.');
        }
      } finally {
        if (ctrl.current === c) setLoading(false);
      }
    }, 450);
    return () => window.clearTimeout(t);
  }, [priceNum, item.id, item.price]);

  // a margem reage ao custo digitado sem nova chamada
  const taxPct = sim?.margin.taxPct ?? item.margin.taxPct;
  // sem consulta ao vivo: usa a média das vendas (tarifa proporcional ao preço)
  const est = !sim && item.margin.fee !== null && item.margin.freight !== null && item.price;
  const fee = sim?.fee ?? (est && priceNum ? Math.round((item.margin.fee! * priceNum * 100) / item.price!) / 100 : null);
  const freight = sim?.freight ?? (est ? item.margin.freight : null);
  const tax = priceNum ? Math.round(priceNum * taxPct) / 100 : 0;
  const amount =
    priceNum && fee !== null && freight !== null && costNum !== null ? Math.round((priceNum - fee - freight - costNum - tax) * 100) / 100 : null;
  const margin = amount !== null && priceNum ? amount / priceNum : null;

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setDone('');
    try {
      if (costNum !== null && costNum > 0 && costNum !== item.cost && item.sku) await skusApi.save(item.sku, costNum);
      if (priceNum && priceNum > 0 && priceNum !== item.price) await listingsApi.setPrice(item.id, priceNum);
      setDone('Salvo.');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.');
    } finally {
      setSaving(false);
    }
  }

  const rows: [string, string, 'minus' | 'plus' | 'total'][] = [
    ['Preço de venda', priceNum ? money(priceNum) : '—', 'plus'],
    [`Tarifa${sim?.feePct ? ` (${sim.feePct.toLocaleString('pt-BR')}%)` : ''}`, fee === null ? '—' : `− ${money(fee)}`, 'minus'],
    ['Frete pago por você', freight === null ? '—' : `− ${money(freight)}`, 'minus'],
    ['Custo do produto', costNum === null ? '—' : `− ${money(costNum)}`, 'minus'],
    [`Imposto (${taxPct.toLocaleString('pt-BR')}%)`, priceNum ? `− ${money(tax)}` : '—', 'minus'],
  ];

  return (
    <form className="lprice" onSubmit={save}>
      <h2>Preço e margem</h2>
      <p className="lprice-sub">{item.title}</p>
      <code>{item.sku ?? item.id}</code>

      <div className="lprice-fields">
        <label className="sku-input">
          <small>Preço de venda</small>
          <span className="sku-field"><i>R$</i>
            <input inputMode="decimal" value={price} disabled={!canManage || item.catalog || item.status === 'closed'} onChange={(e) => setPrice(e.target.value)} />
          </span>
        </label>
        <label className="sku-input">
          <small>Custo unitário{item.sku ? '' : ' (anúncio sem SKU)'}</small>
          <span className="sku-field"><i>R$</i>
            <input inputMode="decimal" value={cost} disabled={!canManage || !item.sku} placeholder="0,00" onChange={(e) => setCost(e.target.value)} />
          </span>
        </label>
      </div>

      <ul className="lprice-break" aria-busy={loading}>
        {rows.map(([label, value, kind]) => (
          <li key={label} data-kind={kind}><span>{label}</span><b>{value}</b></li>
        ))}
        <li data-kind="total" data-tone={margin === null ? 'none' : margin >= 0.15 ? 'ok' : margin >= 0.08 ? 'warn' : 'bad'}>
          <span>Margem de contribuição</span>
          <b>{amount === null ? '—' : `${money(amount)} · ${pct(margin ?? 0, 2)}`}</b>
        </li>
      </ul>

      {est && <p className="lprice-note">Tarifa e frete estimados pela média das vendas dos últimos 90 dias.</p>}
      {item.catalog && <p className="banner banner-error">Anúncio de catálogo: o preço não pode ser alterado por aqui.</p>}
      {error && <p className="banner banner-error" role="alert">{error}</p>}
      {done && <p className="banner banner-ok" role="status">{done}</p>}
      {canManage && (
        <Button type="submit" loading={saving} disabled={item.catalog}>Salvar alterações</Button>
      )}
    </form>
  );
}
