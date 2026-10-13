import './pagination.css';

interface Props {
  page: number; // 1-based
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  onPageSize?: (size: number) => void;
  sizes?: number[];
  label?: string;
}

/** Números de página compactos: 1 … 4 5 6 … 20 */
function pages(current: number, last: number): (number | '…')[] {
  if (last <= 7) return Array.from({ length: last }, (_, i) => i + 1);
  const set = new Set([1, last, current - 1, current, current + 1].filter((p) => p >= 1 && p <= last));
  const sorted = [...set].sort((a, b) => a - b);
  const out: (number | '…')[] = [];
  sorted.forEach((p, i) => {
    if (i && p - sorted[i - 1]! > 1) out.push('…');
    out.push(p);
  });
  return out;
}

/** Paginação numerada (em vez de "carregar mais" e rolagem infinita). */
export function Pagination({ page, pageSize, total, onPage, onPageSize, sizes = [25, 50, 100], label = 'itens' }: Props) {
  const last = Math.max(1, Math.ceil(total / pageSize));
  const from = total ? (page - 1) * pageSize + 1 : 0;
  const to = Math.min(total, page * pageSize);
  return (
    <nav className="pager" aria-label="Paginação">
      <span className="pager-info">
        Mostrando <b>{from}–{to}</b> de <b>{total.toLocaleString('pt-BR')}</b> {label}
      </span>
      <div className="pager-pages">
        <button type="button" onClick={() => onPage(page - 1)} disabled={page <= 1} aria-label="Página anterior">
          ‹
        </button>
        {pages(page, last).map((p, i) =>
          p === '…' ? (
            <span key={`gap-${i}`} className="pager-gap" aria-hidden="true">…</span>
          ) : (
            <button
              key={p}
              type="button"
              onClick={() => onPage(p)}
              aria-current={p === page ? 'page' : undefined}
              aria-label={`Página ${p}`}
            >
              {p}
            </button>
          ),
        )}
        <button type="button" onClick={() => onPage(page + 1)} disabled={page >= last} aria-label="Próxima página">
          ›
        </button>
      </div>
      {onPageSize && (
        <label className="pager-size">
          <span>Por página</span>
          <select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}>
            {sizes.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
      )}
    </nav>
  );
}
