import { useState } from 'react';
import {
  DRE_BASIS_LABELS,
  DRE_CATEGORIES,
  DRE_CATEGORY_LABELS,
  DRE_KINDS,
  type DreBasis,
  type DreEntryDto,
  type DreEntryInput,
  type DreKind,
  type TeamRole,
} from '@nvs/shared';
import { ApiError } from '../../../shared/http';
import { money } from '../../../shared/format';
import {
  KIND_HELP,
  KIND_SECTION,
  SECTION_COPY,
  TEMPLATES,
  monthLabel,
  type Template,
} from '../dre-copy';
import { dreApi } from '../dre-api';
import { TeamMemberForm } from './TeamMemberForm';

type Step = 'pick' | 'classify' | 'basis' | 'form';

interface Props {
  /** editar um lançamento existente */
  entry?: DreEntryDto;
  /** abrir já filtrado num tipo (ex.: "+ Lançar custos para vender") */
  kind?: DreKind;
  /** abrir já preenchido com um gasto comum */
  template?: Template;
  month: string;
  /** números do mês aberto, para mostrar quanto o lançamento dá */
  sample: { pedidos: number; receitaBruta: number };
  onDone: () => void;
  onClose: () => void;
}

const BASES_BY_KIND: Record<DreKind, DreBasis[]> = {
  custo_variavel: ['pedido', 'percentual', 'mensal', 'unico'],
  despesa_fixa: ['mensal', 'unico'],
  despesa_financeira: ['mensal', 'percentual', 'unico'],
};

/** Lançar gasto sem precisar saber contabilidade: escolhe um modelo ou responde 1–2 perguntas. */
export function EntryWizard({ entry, kind, template, month, sample, onDone, onClose }: Props) {
  const [step, setStep] = useState<Step>(entry || template ? 'form' : 'pick');
  const [form, setForm] = useState<DreEntryInput>(() =>
    entry
      ? {
          name: entry.name,
          kind: entry.kind,
          category: entry.category,
          basis: entry.basis,
          amount: entry.amount,
          startMonth: entry.startMonth,
          endMonth: entry.endMonth,
          notes: entry.notes,
        }
      : template
        ? {
            name: template.name,
            kind: template.kind,
            category: template.category,
            basis: template.basis,
            amount: 0,
            startMonth: month,
            endMonth: null,
            notes: null,
          }
        : {
            name: '',
            kind: kind ?? 'despesa_fixa',
            category: 'outros',
            basis: 'mensal',
            amount: 0,
            startMonth: month,
            endMonth: null,
            notes: null,
          },
  );
  const [dica, setDica] = useState<string | undefined>(template?.dica);
  const [amountText, setAmountText] = useState(entry ? String(entry.amount).replace('.', ',') : '');
  const [hasEnd, setHasEnd] = useState(Boolean(entry?.endMonth));
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');

  // pessoas da equipe: calculadora de custo real (salário não é o custo)
  const [person, setPerson] = useState<TeamRole | null>(
    entry?.details ? entry.details.role : (template?.pessoa ?? null),
  );
  const set = <K extends keyof DreEntryInput>(k: K, v: DreEntryInput[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const fromTemplate = (t: Template) => {
    if (t.pessoa) return setPerson(t.pessoa);
    setForm((f) => ({ ...f, name: t.name, kind: t.kind, category: t.category, basis: t.basis }));
    setDica(t.dica);
    setStep('form');
  };
  const pickKind = (k: DreKind) => {
    setForm((f) => ({
      ...f,
      kind: k,
      basis: BASES_BY_KIND[k][0]!,
      category: k === 'despesa_financeira' ? 'financeiro' : f.category,
    }));
    setStep(k === 'custo_variavel' ? 'basis' : 'form');
  };

  const amount = Number(amountText.replace(/\./g, '').replace(',', '.')) || 0;
  const preview =
    form.basis === 'pedido'
      ? amount * sample.pedidos
      : form.basis === 'percentual'
        ? (amount / 100) * sample.receitaBruta
        : amount;
  const section = SECTION_COPY[KIND_SECTION[form.kind]];

  const save = async () => {
    setError('');
    if (!form.name.trim()) return setError('Dê um nome ao gasto.');
    if (amount <= 0) return setError('Informe o valor.');
    setSaving(true);
    try {
      const body: DreEntryInput = {
        ...form,
        amount,
        endMonth: hasEnd && form.basis !== 'unico' ? form.endMonth || form.startMonth : null,
      };
      if (entry) await dreApi.update(entry.id, body);
      else await dreApi.create(body);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.');
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    if (!entry) return;
    setSaving(true);
    try {
      await dreApi.remove(entry.id);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível excluir.');
      setSaving(false);
    }
  };

  if (person) {
    return (
      <TeamMemberForm
        entry={entry?.details ? entry : undefined}
        role={person}
        month={month}
        onDone={onDone}
        onCancel={() => (entry || template ? onClose() : setPerson(null))}
      />
    );
  }

  if (step === 'pick') {
    const kinds = kind ? [kind] : DRE_KINDS;
    return (
      <div className="wiz">
        <h2>Lançar um gasto</h2>
        <p className="dre-muted">
          Escolha um dos gastos comuns de quem vende online (já vem classificado) ou crie o seu.
        </p>
        {kinds.map((k) => (
          <div key={k} className="wiz-group" data-kind={k}>
            <p className="wiz-group-title">
              <b>{KIND_HELP[k].titulo}</b> · {KIND_HELP[k].frase}
            </p>
            <div className="wiz-chips">
              {TEMPLATES.filter((t) => t.kind === k).map((t) => (
                <button
                  key={t.name}
                  type="button"
                  className="wiz-chip"
                  onClick={() => fromTemplate(t)}
                >
                  <span aria-hidden="true">{t.emoji}</span> {t.name}
                </button>
              ))}
            </div>
          </div>
        ))}
        <button
          type="button"
          className="btn btn-primary btn-sm wiz-other"
          onClick={() => setStep(kind ? 'form' : 'classify')}
        >
          Outro gasto
        </button>
      </div>
    );
  }

  if (step === 'classify') {
    return (
      <div className="wiz">
        <button type="button" className="link wiz-back" onClick={() => setStep('pick')}>
          ← voltar
        </button>
        <h2>Uma pergunta só</h2>
        <p className="wiz-q">
          Se no mês que vem você vendesse <b>o dobro</b>, esse gasto…
        </p>
        <div className="wiz-options">
          <button type="button" onClick={() => pickKind('custo_variavel')}>
            <span aria-hidden="true">📈</span>
            <b>Aumentaria junto</b>
            <small>
              É um <u>custo variável</u>. Ex.: embalagem, etiqueta, motoboy.
            </small>
          </button>
          <button type="button" onClick={() => pickKind('despesa_fixa')}>
            <span aria-hidden="true">🟰</span>
            <b>Continuaria igual</b>
            <small>
              É uma <u>despesa fixa</u>. Ex.: aluguel, salário, internet.
            </small>
          </button>
          <button type="button" onClick={() => pickKind('despesa_financeira')}>
            <span aria-hidden="true">🏦</span>
            <b>É juros ou tarifa de banco</b>
            <small>
              É uma <u>despesa financeira</u>. Ex.: juros de empréstimo, antecipação.
            </small>
          </button>
        </div>
      </div>
    );
  }

  if (step === 'basis') {
    const opts: { b: DreBasis; t: string; s: string }[] = [
      { b: 'pedido', t: 'Um valor por pedido', s: 'Ex.: R$ 1,20 de embalagem em cada pedido' },
      { b: 'percentual', t: 'Uma % do que vendo', s: 'Ex.: 3% de comissão sobre as vendas' },
      { b: 'mensal', t: 'Um valor no mês', s: 'Ex.: R$ 600 de motoboy no mês' },
    ];
    return (
      <div className="wiz">
        <button type="button" className="link wiz-back" onClick={() => setStep('classify')}>
          ← voltar
        </button>
        <h2>Como ele é cobrado?</h2>
        <div className="wiz-options">
          {opts.map((o) => (
            <button
              key={o.b}
              type="button"
              onClick={() => {
                set('basis', o.b);
                setStep('form');
              }}
            >
              <b>{o.t}</b>
              <small>{o.s}</small>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <form
      className="wiz"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {!entry && (
        <button type="button" className="link wiz-back" onClick={() => setStep('pick')}>
          ← voltar
        </button>
      )}
      <h2>{entry ? 'Editar gasto' : 'Quanto custa?'}</h2>

      <div className="wiz-kind" data-kind={form.kind}>
        <span>
          <b>{KIND_HELP[form.kind].titulo}</b> — entra em “{section.emoji} {section.label}”
        </span>
        <button type="button" className="link" onClick={() => setStep('classify')}>
          trocar
        </button>
      </div>

      <label className="wiz-field">
        <span>Nome</span>
        <input
          value={form.name}
          maxLength={80}
          onChange={(e) => set('name', e.target.value)}
          placeholder="Ex.: Aluguel do galpão"
          data-autofocus={!form.name || undefined}
        />
      </label>

      <div className="wiz-field">
        <span>Como é cobrado</span>
        <div className="wiz-seg" role="radiogroup" aria-label="Como é cobrado">
          {BASES_BY_KIND[form.kind].map((b) => (
            <button
              key={b}
              type="button"
              role="radio"
              aria-checked={form.basis === b}
              onClick={() => set('basis', b)}
            >
              {DRE_BASIS_LABELS[b]}
            </button>
          ))}
        </div>
      </div>

      <label className="wiz-field">
        <span>
          {form.basis === 'percentual'
            ? 'Percentual sobre as vendas'
            : form.basis === 'pedido'
              ? 'Valor por pedido'
              : 'Valor'}
        </span>
        <span className="wiz-money">
          {form.basis !== 'percentual' && <i>R$</i>}
          <input
            inputMode="decimal"
            value={amountText}
            onChange={(e) => setAmountText(e.target.value.replace(/[^\d.,]/g, ''))}
            placeholder="0,00"
            data-autofocus={form.name ? true : undefined}
          />
          {form.basis === 'percentual' && <i>%</i>}
        </span>
        {dica && <small className="wiz-dica">💡 {dica}</small>}
      </label>

      <div className="wiz-row">
        <label className="wiz-field">
          <span>{form.basis === 'unico' ? 'Mês do pagamento' : 'Começa em'}</span>
          <input
            type="month"
            value={form.startMonth}
            onChange={(e) => e.target.value && set('startMonth', e.target.value)}
          />
        </label>
        {form.basis !== 'unico' && (
          <label className="wiz-field">
            <span>
              <input
                type="checkbox"
                checked={hasEnd}
                onChange={(e) => setHasEnd(e.target.checked)}
              />{' '}
              Tem data para acabar?
            </span>
            <input
              type="month"
              disabled={!hasEnd}
              value={form.endMonth ?? form.startMonth}
              min={form.startMonth}
              onChange={(e) => set('endMonth', e.target.value || null)}
            />
          </label>
        )}
      </div>

      <label className="wiz-field">
        <span>Grupo</span>
        <select
          value={form.category}
          onChange={(e) => set('category', e.target.value as DreEntryInput['category'])}
        >
          {DRE_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {DRE_CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
      </label>

      {amount > 0 && (
        <p className="wiz-preview">
          Em {monthLabel(month).toLowerCase()} isso dá <b>{money(preview)}</b>
          {form.basis === 'pedido' && <> ({sample.pedidos.toLocaleString('pt-BR')} pedidos)</>}
          {form.basis === 'percentual' && <> (sobre {money(sample.receitaBruta)} vendidos)</>}
          {form.basis === 'unico' && form.startMonth !== month && (
            <> só em {monthLabel(form.startMonth).toLowerCase()}</>
          )}
          .
        </p>
      )}

      {error && (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      )}
      <div className="wiz-actions">
        {entry &&
          (confirmDelete ? (
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={() => void remove()}
              disabled={saving}
            >
              Confirmar exclusão
            </button>
          ) : (
            <button type="button" className="link wiz-del" onClick={() => setConfirmDelete(true)}>
              Excluir
            </button>
          ))}
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
          Cancelar
        </button>
        <button
          type="submit"
          className="btn btn-primary btn-sm"
          disabled={saving}
          aria-busy={saving || undefined}
        >
          {saving ? 'Salvando…' : 'Salvar'}
        </button>
      </div>
    </form>
  );
}
