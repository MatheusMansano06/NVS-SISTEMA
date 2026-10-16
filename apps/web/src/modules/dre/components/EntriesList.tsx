import { DRE_BASIS_LABELS, DRE_CATEGORY_LABELS, DRE_KINDS, type DreEntryDto } from '@nvs/shared';
import { money } from '../../../shared/format';
import { KIND_HELP, TEMPLATES, monthLabel } from '../dre-copy';

const emojiOf = (e: DreEntryDto) => TEMPLATES.find((t) => t.name === e.name)?.emoji ?? '•';
const valueOf = (e: DreEntryDto) =>
  e.basis === 'percentual'
    ? `${e.amount.toLocaleString('pt-BR')}% das vendas`
    : e.basis === 'pedido'
      ? `${money(e.amount)} por pedido`
      : money(e.amount);
const periodOf = (e: DreEntryDto) =>
  e.basis === 'unico'
    ? `só em ${monthLabel(e.startMonth, true)}`
    : `${monthLabel(e.startMonth, true)} → ${e.endMonth ? monthLabel(e.endMonth, true) : 'sem fim'}`;

/** Todos os gastos lançados, separados por tipo, com o total mensal do que é valor fixo. */
export function EntriesList({
  entries,
  month,
  onEdit,
  onNew,
}: {
  entries: DreEntryDto[];
  month: string;
  onEdit: (e: DreEntryDto) => void;
  onNew: () => void;
}) {
  const active = (e: DreEntryDto) =>
    e.basis === 'unico'
      ? e.startMonth === month
      : e.startMonth <= month && (!e.endMonth || e.endMonth >= month);
  return (
    <div className="entries">
      <div className="entries-head">
        <h2>Meus gastos</h2>
        <button type="button" className="btn btn-primary btn-sm" onClick={onNew}>
          + Lançar gasto
        </button>
      </div>
      {!entries.length && <p className="dre-muted">Nenhum gasto lançado ainda.</p>}
      {DRE_KINDS.map((k) => {
        const list = entries.filter((e) => e.kind === k);
        if (!list.length) return null;
        const mensal = list
          .filter((e) => e.basis === 'mensal' && active(e))
          .reduce((a, e) => a + e.amount, 0);
        return (
          <section key={k} className="entries-group" data-kind={k}>
            <h3>
              {KIND_HELP[k].titulo} <small>{KIND_HELP[k].frase}</small>
              {mensal > 0 && <span className="money">{money(mensal)}/mês</span>}
            </h3>
            <ul>
              {list.map((e) => (
                <li key={e.id} data-inactive={!active(e) || undefined}>
                  <button type="button" onClick={() => onEdit(e)}>
                    <span className="entries-emoji" aria-hidden="true">
                      {emojiOf(e)}
                    </span>
                    <span className="entries-name">
                      {e.name}
                      <small>
                        {DRE_CATEGORY_LABELS[e.category]} · {DRE_BASIS_LABELS[e.basis]} ·{' '}
                        {periodOf(e)}
                        {!active(e) && ' · fora deste mês'}
                      </small>
                    </span>
                    <b className="money">{valueOf(e)}</b>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
