import type { TopProduct } from '@nvs/shared';
import { int, money, pct } from '../../../shared/format';
import { ProductThumb } from './ProductThumb';

/** Os 5 produtos que mais faturaram no período do filtro, com foto e título. */
export function TopFive({ products }: { products: TopProduct[] }) {
  return (
    <section className="panel" aria-labelledby="top5-title">
      <header className="panel-head">
        <h2 id="top5-title">Top 5 mais vendidos</h2>
        <small className="panel-hint">no período selecionado</small>
      </header>
      {products.length === 0 ? (
        <p className="empty">Nenhuma venda no período selecionado.</p>
      ) : (
        <ol className="top5">
          {products.map((p, i) => {
            const body = (
              <>
                <span className="top5-rank" data-rank={i + 1}>{i + 1}º</span>
                <ProductThumb src={p.pictureUrl} alt={p.title} />
                <span className="top5-info">
                  <strong>{p.title}</strong>
                  <small>{p.sku}</small>
                  <span className="top5-share" aria-label={`${pct(p.share)} do faturamento`}>
                    <span style={{ width: `${Math.max(3, p.share * 100)}%` }} />
                  </span>
                </span>
                <span className="top5-nums">
                  <b className="money">{money(p.revenue)}</b>
                  <small>{int(p.units)} un. · {pct(p.share)}</small>
                </span>
              </>
            );
            return (
              <li key={p.sku} style={{ ['--d' as string]: `${i * 60}ms` }}>
                {p.permalink ? (
                  <a className="top5-row" href={p.permalink} target="_blank" rel="noreferrer noopener" title="Ver anúncio no Mercado Livre">
                    {body}
                  </a>
                ) : (
                  <div className="top5-row">{body}</div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
