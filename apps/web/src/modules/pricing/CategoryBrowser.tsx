import { useEffect, useState } from 'react';
import type { CategoryLevelDto, CategoryNodeDto } from '@nvs/shared';
import { ApiError } from '../../shared/http';
import { pricingApi } from './pricing-api';

const feeChips = (n: CategoryNodeDto) => (
  <span className="pcat-fees">
    <span>Clássico <b>{n.feeClassic === null ? '—' : `${n.feeClassic.toLocaleString('pt-BR')}%`}</b></span>
    <span>Premium <b>{n.feePremium === null ? '—' : `${n.feePremium.toLocaleString('pt-BR')}%`}</b></span>
  </span>
);

/** Todas as categorias do ML em árvore (ou busca), com a % de tarifa de cada uma já à vista. */
export function CategoryBrowser({ onPick, onSkip, title = '1. Categoria do produto' }: { onPick: (id: string) => void; onSkip: () => void; title?: string }) {
  const [level, setLevel] = useState<CategoryLevelDto | null>(null);
  const [parent, setParent] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<CategoryNodeDto[] | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    pricingApi
      .tree(parent)
      .then((l) => alive && setLevel(l))
      .catch((err) => alive && setError(err instanceof ApiError ? err.message : 'Não foi possível carregar as categorias.'))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [parent]);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return setResults(null);
    const t = window.setTimeout(() => pricingApi.categories(term).then(setResults).catch(() => setResults([])), 400);
    return () => window.clearTimeout(t);
  }, [q]);

  const open = (n: CategoryNodeDto) => (n.leaf === true ? onPick(n.id) : setParent(n.id));
  const list = results ?? level?.items ?? [];

  return (
    <section className="scard pcat">
      <header className="scard-head">
        <div>
          <h2>{title}</h2>
          <p>A tarifa do ML muda por categoria. Navegue pelas pastas ou busque; a % de cada uma já aparece.</p>
        </div>
      </header>
      <label className="search">
        <span className="sr-only">Buscar categoria</span>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
        <input placeholder="Buscar: o que é o produto? (ex.: viseira de capacete)" value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      {!results && (
        <nav className="pcat-crumbs" aria-label="Caminho">
          <button type="button" className="link" onClick={() => setParent(undefined)}>Todas</button>
          {level?.path.map((p, i) => (
            <span key={p.id}>
              › {i === level.path.length - 1 ? <b>{p.name}</b> : <button type="button" className="link" onClick={() => setParent(p.id)}>{p.name}</button>}
            </span>
          ))}
        </nav>
      )}
      {error && <p className="banner banner-error" role="alert">{error}</p>}
      <ul className="pcat-list" aria-busy={loading}>
        {list.map((n) => (
          <li key={n.id}>
            <button type="button" onClick={() => open(n)}>
              <strong>{n.name}</strong>
              {feeChips(n)}
              <i aria-hidden="true">{n.leaf === true ? 'escolher' : '›'}</i>
            </button>
          </li>
        ))}
        {!loading && !list.length && <li className="lsales-empty">{results ? 'Nenhuma categoria encontrada.' : 'Sem subcategorias.'}</li>}
      </ul>
      {!results && level?.path.length ? (
        <button type="button" className="act pcat-usethis" onClick={() => onPick(level.path.at(-1)!.id)}>
          Usar “{level.path.at(-1)!.name}” mesmo assim
        </button>
      ) : null}
      {loading && !level && <div className="promo-skel" aria-hidden="true" />}
      <button type="button" className="link pcat-skip" onClick={onSkip}>Não sei a categoria — simular com a tarifa média (Clássico 12%, Premium 17%)</button>
    </section>
  );
}

export { feeChips };
