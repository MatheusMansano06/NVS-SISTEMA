import { useEffect, useMemo, useState } from 'react';
import { marginBand, type TaxImpactDto } from '@nvs/shared';
import { money, pct } from '../../../shared/format';
import { ProductThumb } from '../../dashboard/components/ProductThumb';
import { financeApi, type FinanceFilters } from '../finance-api';

type Filtro = 'todos' | 'prejuizo' | 'negativos' | 'critico';
type Ordem = 'perda' | 'margem' | 'unidades';
const FILTROS: Record<Filtro, string> = {
  todos: 'Todos os produtos',
  prejuizo: 'Viraram prejuízo',
  negativos: 'Margem negativa depois',
  critico: 'Margem abaixo de 10% depois',
};
const ORDENS: Record<Ordem, string> = { perda: 'Maior perda em R$', margem: 'Menor margem depois', unidades: 'Mais vendidos' };
const v = (n: number) => n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const p1 = (n: number) => n.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const rate = (s: string) => {
  const n = Number(s.replace(',', '.'));
  return s.trim() !== '' && Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
};

/** Simulador de imposto: quanto a margem de cada produto muda trocando a alíquota, com as vendas do período. */
export function TaxImpact({ filters }: { filters: FinanceFilters }) {
  const [de, setDe] = useState('');
  const [para, setPara] = useState('');
  const [data, setData] = useState<TaxImpactDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filtro, setFiltro] = useState<Filtro>('todos');
  const [ordem, setOrdem] = useState<Ordem>('perda');
  const [busca, setBusca] = useState('');

  const deN = rate(de);
  const paraN = rate(para);
  useEffect(() => {
    const c = new AbortController();
    const t = window.setTimeout(async () => {
      setLoading(true);
      setError('');
      try {
        const r = await financeApi.taxImpact(filters, { de: deN ?? undefined, para: paraN ?? undefined }, c.signal);
        setData(r);
        // primeira carga: mostra a alíquota anterior e a atual da empresa
        if (de === '') setDe(String(r.de));
        if (para === '') setPara(String(r.para));
      } catch (err) {
        if ((err as Error).name !== 'AbortError') setError('Não foi possível simular.');
      } finally {
        if (!c.signal.aborted) setLoading(false);
      }
    }, 300);
    return () => {
      c.abort();
      window.clearTimeout(t);
    };
  }, [filters, deN, paraN]);

  const items = useMemo(() => {
    const term = busca.trim().toLowerCase();
    const list = (data?.items ?? []).filter(
      (i) =>
        (filtro === 'todos' ||
          (filtro === 'prejuizo' && i.mcAntes >= 0 && i.mcDepois < 0) ||
          (filtro === 'negativos' && i.mcDepois < 0) ||
          (filtro === 'critico' && i.mcPctDepois < 10)) &&
        (!term || i.sku.toLowerCase().includes(term) || i.title.toLowerCase().includes(term)),
    );
    const by: Record<Ordem, (a: (typeof list)[number], b: (typeof list)[number]) => number> = {
      perda: (a, b) => a.impacto - b.impacto,
      margem: (a, b) => a.mcPctDepois - b.mcPctDepois,
      unidades: (a, b) => b.unidades - a.unidades,
    };
    return [...list].sort(by[ordem]);
  }, [data, filtro, ordem, busca]);

  const r = data?.resumo;
  const diff = r ? r.mcDepois - r.mcAntes : 0;
  const pctOf = (mc: number) => (r && r.faturamento > 0 ? pct(mc / r.faturamento, 2) : '—');

  return (
    <section className="panel ftable taxsim" aria-labelledby="ts-title">
      <header className="panel-head">
        <div>
          <h2 id="ts-title">Simulador de imposto por produto</h2>
          <small className="panel-hint">
            Vendas aprovadas com custo no período · troca só a alíquota e mantém custo, tarifa e frete de cada venda ·
            "Vender por" é o preço que volta à margem % de antes (imposto e tarifa sobem junto com o preço)
          </small>
        </div>
        <div className="taxsim-rates">
          <label>
            <span>Imposto de</span>
            <input inputMode="decimal" value={de} onChange={(e) => setDe(e.target.value)} aria-invalid={de !== '' && deN === null} />
            <i>%</i>
          </label>
          <span aria-hidden="true">→</span>
          <label>
            <span>Para</span>
            <input inputMode="decimal" value={para} onChange={(e) => setPara(e.target.value)} aria-invalid={para !== '' && paraN === null} />
            <i>%</i>
          </label>
        </div>
      </header>

      {error && <p className="banner banner-error" role="alert">{error}</p>}

      {r && (
        <div className="fin-minis taxsim-minis">
          <div>
            <span>MC com {data.de}%</span>
            <b className="money">{money(r.mcAntes)}</b>
            <small>{pctOf(r.mcAntes)} do faturamento</small>
          </div>
          <div>
            <span>MC com {data.para}%</span>
            <b className="money">{money(r.mcDepois)}</b>
            <small>{pctOf(r.mcDepois)} do faturamento</small>
          </div>
          <div>
            <span>Diferença</span>
            <b className={`money${diff < 0 ? ' neg' : ''}`}>{money(diff)}</b>
            <small>no período escolhido</small>
          </div>
          <div>
            <span>Viraram prejuízo</span>
            <b className={r.viraramPrejuizo ? 'neg' : undefined}>{r.viraramPrejuizo}</b>
            <small>de {r.produtos} produtos com custo</small>
          </div>
        </div>
      )}
      {data && data.semCusto > 0 && (
        <p className="panel-hint">{data.semCusto} venda(s) sem custo cadastrado ficaram fora da simulação.</p>
      )}

      <div className="taxsim-tools">
        <input className="search" type="search" placeholder="Buscar SKU ou produto" value={busca} onChange={(e) => setBusca(e.target.value)} aria-label="Buscar SKU ou produto" />
        <select value={filtro} onChange={(e) => setFiltro(e.target.value as Filtro)} aria-label="Filtro">
          {Object.entries(FILTROS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <select value={ordem} onChange={(e) => setOrdem(e.target.value as Ordem)} aria-label="Ordenar">
          {Object.entries(ORDENS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>

      <div className="fin-wrap" aria-busy={loading}>
        <table className="fin">
          <thead>
            <tr>
              <th scope="col" className="c-prod">Produto · SKU</th>
              <th scope="col" className="num">Unid.<br />Vendas</th>
              <th scope="col" className="num">Faturamento</th>
              <th scope="col" className="num">MC com {data?.de ?? '—'}%</th>
              <th scope="col" className="num">MC com {data?.para ?? '—'}%</th>
              <th scope="col" className="num">Impacto</th>
              <th scope="col" className="num" title="Preço por unidade para voltar à margem % de antes com a alíquota nova">Vender por</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.sku} data-loss={(i.mcAntes >= 0 && i.mcDepois < 0) || undefined}>
                <td className="c-prod">
                  <span className="fin-product">
                    <ProductThumb src={i.pictureUrl} alt={i.title} size={36} />
                    <span>
                      <strong title={i.title}>{i.title}</strong>
                      <small className="mono">{i.sku}</small>
                    </span>
                  </span>
                </td>
                <td className="num" data-label="Unid. · vendas">
                  <span className="two">{i.unidades}<small>{i.vendas} venda(s)</small></span>
                </td>
                <td className="num" data-label="Faturamento">{v(i.faturamento)}</td>
                <td className="num" data-label={`MC com ${data?.de}%`}>
                  <span className="two">
                    {v(i.mcAntes)}
                    <small><span className="band" data-band={marginBand(i.mcPctAntes)}>{p1(i.mcPctAntes)}%</span></small>
                  </span>
                </td>
                <td className="num" data-label={`MC com ${data?.para}%`}>
                  <span className="two">
                    {v(i.mcDepois)}
                    <small><span className="band" data-band={marginBand(i.mcPctDepois)}>{p1(i.mcPctDepois)}%</span></small>
                  </span>
                </td>
                <td className="num" data-label="Impacto">
                  <span className="two">
                    <b className={i.impacto < 0 ? 'neg' : 'pos'}>{i.impacto > 0 ? '+' : ''}{v(i.impacto)}</b>
                    <small>{p1(i.mcPctDepois - i.mcPctAntes)} p.p.</small>
                  </span>
                </td>
                <td className="num" data-label="Vender por">
                  {i.impacto >= 0 ? (
                    <span className="two">—<small>margem mantida</small></span>
                  ) : i.precoSugerido === null ? (
                    <span className="two">—<small>sem preço que volte a {p1(i.mcPctAntes)}%</small></span>
                  ) : (
                    <span className="two" title={`Hoje: ${money(i.precoMedio)} por unidade`}>
                      <b className="sugerido">{money(i.precoSugerido)}</b>
                      <small>+{p1(((i.precoSugerido - i.precoMedio) / i.precoMedio) * 100)}% · hoje {v(i.precoMedio)}</small>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && items.length === 0 && <p className="empty">Nenhum produto com esses filtros.</p>}
      </div>
    </section>
  );
}
