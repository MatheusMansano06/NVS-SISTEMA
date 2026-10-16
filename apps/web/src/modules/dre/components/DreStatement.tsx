import { useState } from 'react';
import {
  DRE_FLOW,
  DRE_SECTIONS,
  type DreDto,
  type DreEntryDto,
  type DreKind,
  type DreSectionId,
  type DreSubtotalId,
} from '@nvs/shared';
import { money } from '../../../shared/format';
import { Icon } from '../../../shared/ui/Icon';
import { KIND_SECTION, SECTION_COPY, SUBTOTAL_COPY, type Copy } from '../dre-copy';

const isSection = (id: string): id is DreSectionId =>
  (DRE_SECTIONS as readonly string[]).includes(id);
const ADDABLE = Object.fromEntries(Object.entries(KIND_SECTION).map(([k, s]) => [s, k])) as Partial<
  Record<DreSectionId, DreKind>
>;
const pctOf = (v: number, base: number) =>
  base > 0
    ? `${((v / base) * 100).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
    : '—';

interface Props {
  data: DreDto;
  entries: DreEntryDto[];
  tecnico: boolean;
  open: Set<DreSectionId>;
  onToggle: (id: DreSectionId) => void;
  focus: DreSectionId | 'lucro' | null;
  onFocus: (id: DreSectionId | 'lucro' | null) => void;
  onAdd: (kind: DreKind) => void;
  onEdit: (entry: DreEntryDto) => void;
}

/** O DRE de cima para baixo: cada bloco tira dinheiro, cada "=" mostra o que sobrou até ali. */
export function DreStatement({
  data,
  entries,
  tecnico,
  open,
  onToggle,
  focus,
  onFocus,
  onAdd,
  onEdit,
}: Props) {
  const [help, setHelp] = useState<string | null>(null);
  const base = data.receitaBruta;

  const helpBox = (id: string, copy: Copy) =>
    help === id ? (
      <div className="st-help" role="note">
        <p>{copy.explain}</p>
        {copy.exemplo && <p className="st-ex">💡 {copy.exemplo}</p>}
        <small>
          Nome no contador: <b>{copy.tecnico}</b>
        </small>
      </div>
    ) : null;
  const helpBtn = (id: string, label: string) => (
    <button
      type="button"
      className="st-q"
      aria-expanded={help === id}
      aria-label={`O que é ${label}?`}
      onClick={(e) => {
        e.stopPropagation();
        setHelp((h) => (h === id ? null : id));
      }}
    >
      ?
    </button>
  );

  return (
    <div className="statement" role="table" aria-label="DRE do mês">
      <div className="st-head" role="row">
        <span role="columnheader">O caminho do dinheiro</span>
        <span role="columnheader" className="num">
          Valor
        </span>
        <span
          role="columnheader"
          className="num"
          title="Quanto cada linha representa do que você vendeu"
        >
          % das vendas
        </span>
      </div>
      {DRE_FLOW.map((id) => {
        if (!isSection(id)) {
          const sid = id as DreSubtotalId;
          const copy = SUBTOTAL_COPY[sid];
          const v = data.subtotals[sid];
          const final = sid === 'lucro_liquido';
          return (
            <div key={id} className="st-block">
              <div
                role="row"
                className="st-sub"
                data-final={final || undefined}
                data-neg={v < 0 || undefined}
                data-dim={(final && focus && focus !== 'lucro') || undefined}
                onMouseEnter={() => final && onFocus('lucro')}
                onMouseLeave={() => final && onFocus(null)}
              >
                <span role="cell" className="st-name">
                  <b className="st-eq" aria-hidden="true">
                    =
                  </b>
                  <span>
                    {copy.label}
                    {tecnico && <small className="st-tec">{copy.tecnico}</small>}
                  </span>
                  {helpBtn(id, copy.label)}
                </span>
                <span role="cell" className="num money">
                  {money(v)}
                </span>
                <span role="cell" className="num st-pct">
                  {pctOf(v, base)}
                </span>
              </div>
              {helpBox(id, copy)}
            </div>
          );
        }
        const s = data.sections.find((x) => x.id === id)!;
        const copy = SECTION_COPY[id];
        const isOpen = open.has(id);
        const kind = ADDABLE[id];
        const income = id === 'receita';
        return (
          <div
            key={id}
            className="st-block"
            data-sec={id}
            data-dim={(focus && focus !== id) || undefined}
            id={`dre-${id}`}
          >
            <div
              role="row"
              className="st-sec"
              onMouseEnter={() => onFocus(id)}
              onMouseLeave={() => onFocus(null)}
            >
              <span role="cell" className="st-name">
                <button
                  type="button"
                  className="st-toggle"
                  aria-expanded={isOpen}
                  onClick={() => onToggle(id)}
                >
                  <i className="st-dot" aria-hidden="true" />
                  <span className="st-emoji" aria-hidden="true">
                    {copy.emoji}
                  </span>
                  <span>
                    {copy.label}
                    {tecnico && <small className="st-tec">{copy.tecnico}</small>}
                  </span>
                  <small className="st-count">
                    {s.items.length
                      ? `${s.items.length} ${s.items.length === 1 ? 'item' : 'itens'}`
                      : 'nada lançado'}
                  </small>
                  <Icon name="chevron" size={16} />
                </button>
                {helpBtn(id, copy.label)}
              </span>
              <span role="cell" className="num money st-val">
                {income ? '' : '− '}
                {money(s.total)}
              </span>
              <span role="cell" className="num st-pct">
                {income ? '100%' : pctOf(s.total, base)}
              </span>
            </div>
            {helpBox(id, copy)}
            {isOpen && (
              <div className="st-items">
                {s.items.map((it) => {
                  const entry = it.entryId ? entries.find((e) => e.id === it.entryId) : undefined;
                  return (
                    <div key={it.key} role="row" className="st-item">
                      <span role="cell" className="st-name">
                        <span className="st-iname">
                          {it.label}
                          <small>
                            {it.auto ? (
                              <span className="tag-auto">automático</span>
                            ) : (
                              <span className="tag-mine">lançado por você</span>
                            )}
                            {it.estimated && (
                              <span
                                className="tag-est"
                                title="Estimado pela média das vendas que têm custo cadastrado"
                              >
                                estimado
                              </span>
                            )}
                            {it.detail && <span className="st-detail">{it.detail}</span>}
                          </small>
                        </span>
                        {entry && (
                          <button
                            type="button"
                            className="link st-edit"
                            onClick={() => onEdit(entry)}
                          >
                            editar
                          </button>
                        )}
                      </span>
                      <span role="cell" className="num money">
                        {income ? '' : '− '}
                        {money(it.valor)}
                      </span>
                      <span role="cell" className="num st-pct">
                        {pctOf(it.valor, base)}
                      </span>
                    </div>
                  );
                })}
                {!s.items.length && <p className="st-empty">Nada aqui neste mês.</p>}
                {kind && (
                  <button type="button" className="st-add" onClick={() => onAdd(kind)}>
                    + Lançar {copy.label.toLowerCase()}
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
