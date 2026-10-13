import { useEffect, useRef, useState, type ReactNode } from 'react';
import { LISTING_TYPE_LABELS, LOGISTIC_LABELS, marginBand, type FinanceLineDto, type SaleStatus } from '@nvs/shared';
import { Icon } from '../../../shared/ui/Icon';
import { Pagination } from '../../../shared/ui/Pagination';
import { ProductThumb } from '../../dashboard/components/ProductThumb';
import { financeApi, type FinanceFilters, type LineFilters } from '../finance-api';
import { shortDay } from '../dates';
import { FilterPanel } from './FilterPanel';

const STATUS_LABEL: Record<SaleStatus, string> = { aprovada: 'Aprovada', cancelada: 'Cancelada', devolucao: 'Dev. parcial' };
/** Valores sem "R$" em cada célula (o cabeçalho avisa): a tabela cabe na tela. */
const v = (n: number | null) => (n === null ? '—' : n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

function Copy({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="copy"
      aria-label={`Copiar ${label}`}
      title={done ? 'Copiado!' : `Copiar ${label}`}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          window.setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? '✓' : '⧉'}
    </button>
  );
}

/** Colunas agrupadas (2 linhas por célula) para caber em qualquer largura sem rolar para o lado. */
type Col = { key: string; label: ReactNode; cls?: string; render: (l: FinanceLineDto) => ReactNode };
const COLUMNS: Col[] = [
  {
    key: 'pedido',
    label: <>Pedido<br />Data</>,
    cls: 'c-ped',
    render: (l) => (
      <span className="two">
        <span className="mono">{l.orderId}<Copy text={l.orderId} label="pedido" /></span>
        <small>{shortDay(l.date)}</small>
      </span>
    ),
  },
  {
    key: 'status',
    label: <>Status<br />Frete</>,
    cls: 'c-st',
    render: (l) => (
      <span className="two">
        <span className={`st st-${l.status}`}>{STATUS_LABEL[l.status]}</span>
        <small className="chip">{LOGISTIC_LABELS[l.bucket]}{l.listingType ? ` · ${LISTING_TYPE_LABELS[l.listingType] ?? ''}` : ''}</small>
      </span>
    ),
  },
  {
    key: 'valor',
    label: <>Qtd ×<br />valor un.</>,
    cls: 'num',
    render: (l) => (
      <span className="two">
        <b>{l.qtd} ×</b>
        <small>{v(l.valorUnit)}</small>
      </span>
    ),
  },
  { key: 'fat', label: 'Faturado', cls: 'num', render: (l) => <b>{v(l.faturamento)}</b> },
  { key: 'cupom', label: 'Cupom', cls: 'num', render: (l) => v(l.cupom) },
  {
    key: 'custo',
    label: <>Custo<br />Imposto</>,
    cls: 'num',
    render: (l) =>
      l.custo === null ? (
        <span className="tag tag-missing">Sem custo</span>
      ) : (
        <span className="two">
          <span>{v(l.custo)}</span>
          <small>{v(l.imposto)}</small>
        </span>
      ),
  },
  { key: 'tarifa', label: 'Tarifa', cls: 'num', render: (l) => v(l.tarifa) },
  {
    key: 'frete',
    label: <>Frete comp.<br />Frete vend.</>,
    cls: 'num',
    render: (l) => (
      <span className="two">
        <span>{v(l.freteComprador)}</span>
        <small>{v(l.freteVendedor)}</small>
      </span>
    ),
  },
  {
    key: 'mc',
    label: <>MC<br />MC %</>,
    cls: 'num',
    render: (l) =>
      l.mc === null ? (
        '—'
      ) : (
        <span className="two">
          <b>{v(l.mc)}</b>
          <span className="band" data-band={marginBand(l.mcPct!)}>{l.mcPct!.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%</span>
        </span>
      ),
  },
];
const COL_NAMES: Record<string, string> = {
  pedido: 'Pedido · Data', status: 'Status · Frete', valor: 'Qtd × Valor', fat: 'Faturamento', cupom: 'Cupom',
  custo: 'Custo · Imposto', tarifa: 'Tarifa', frete: 'Frete comp. · vend.', mc: 'MC · MC%',
};
const COLS_KEY = 'nvs.finance.cols.v2';
const readHidden = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(COLS_KEY) ?? '[]');
  } catch {
    return [];
  }
};

interface Props {
  filters: FinanceFilters;
  initial: LineFilters;
  version: number;
  onConsiderarFc: (v: boolean) => void;
}

/** Vendas linha a linha: filtros em painel, colunas configuráveis, páginas e exportação. */
export function FinanceTable({ filters, initial, version, onConsiderarFc }: Props) {
  const [lf, setLf] = useState<LineFilters>(initial);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [data, setData] = useState<{ items: FinanceLineDto[]; total: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [hidden, setHidden] = useState<string[]>(readHidden);
  const [colsOpen, setColsOpen] = useState(false);
  const ctrl = useRef<AbortController | null>(null);
  const top = useRef<HTMLElement>(null);

  useEffect(() => setLf(initial), [initial]);
  useEffect(() => setPage(1), [lf, filters, pageSize]);
  useEffect(() => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setLoading(true);
    financeApi
      .lines(filters, lf, (page - 1) * pageSize, pageSize, c.signal)
      .then(setData)
      .catch(() => undefined)
      .finally(() => ctrl.current === c && setLoading(false));
  }, [filters, lf, page, pageSize, version]);

  const toggleCol = (key: string) =>
    setHidden((h) => {
      const next = h.includes(key) ? h.filter((k) => k !== key) : [...h, key];
      try {
        localStorage.setItem(COLS_KEY, JSON.stringify(next));
      } catch {
        /* sem armazenamento: vale só nesta sessão */
      }
      return next;
    });
  const cols = COLUMNS.filter((c) => !hidden.includes(c.key));

  return (
    <section className="panel ftable" aria-labelledby="ft-title" ref={top}>
      <header className="panel-head">
        <div>
          <h2 id="ft-title">Vendas detalhadas</h2>
          <small className="panel-hint">
            {data ? `${data.total.toLocaleString('pt-BR')} resultados · ` : ''}valores em R$ · custos, cupons, imposto, frete e margem
          </small>
        </div>
        <div className="ftable-actions">
          <FilterPanel value={lf} onChange={setLf} considerarFc={Boolean(filters.considerarFreteComprador)} onConsiderarFc={onConsiderarFc} />
          <div className="cols-menu">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setColsOpen((x) => !x)} aria-expanded={colsOpen}>
              Colunas
            </button>
            {colsOpen && (
              <div className="cols-pop" role="menu">
                {COLUMNS.map((c) => (
                  <label key={c.key}>
                    <input type="checkbox" checked={!hidden.includes(c.key)} onChange={() => toggleCol(c.key)} />
                    {COL_NAMES[c.key]}
                  </label>
                ))}
              </div>
            )}
          </div>
          <a className="btn btn-ghost btn-sm" href={financeApi.exportUrl(filters, lf)} download>
            <Icon name="logout" size={16} /> Exportar
          </a>
        </div>
      </header>

      <div className="fin-wrap" aria-busy={loading}>
        <table className="fin">
          <thead>
            <tr>
              <th scope="col" className="c-prod">Anúncio · SKU</th>
              {cols.map((c) => (
                <th key={c.key} scope="col" className={c.cls}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data?.items.map((l, i) => (
              <tr key={`${l.orderId}-${l.sku}-${i}`} data-nocost={l.mc === null || undefined}>
                <td className="c-prod">
                  <span className="fin-product">
                    <ProductThumb src={l.pictureUrl} alt={l.title} size={36} />
                    <span>
                      <strong title={l.title}>{l.title}</strong>
                      <small>
                        <span className="mono">{l.sku}</span><Copy text={l.sku} label="SKU" />
                        {l.listingId && <> · <span className="mono">{l.listingId}</span><Copy text={l.listingId} label="MLB" /></>}
                      </small>
                    </span>
                  </span>
                </td>
                {cols.map((c) => (
                  <td key={c.key} className={c.cls} data-label={COL_NAMES[c.key]}>{c.render(l)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {data && data.items.length === 0 && <p className="empty">Nenhuma venda com esses filtros.</p>}
      </div>

      {data && data.total > 0 && (
        <Pagination
          page={page}
          pageSize={pageSize}
          total={data.total}
          onPage={(p) => {
            setPage(p);
            top.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }}
          onPageSize={setPageSize}
          label="itens"
        />
      )}
    </section>
  );
}
