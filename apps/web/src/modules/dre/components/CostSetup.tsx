import { useState } from 'react';
import {
  DRE_BASIS_LABELS,
  TEAM_ROLE_INFO,
  type DreCategory,
  type DreEntryDto,
  type DreKind,
} from '@nvs/shared';
import { ApiError } from '../../../shared/http';
import { money } from '../../../shared/format';
import { TEMPLATES, monthLabel, type Template } from '../dre-copy';
import { dreApi } from '../dre-api';
import { EntryWizard } from './EntryWizard';
import { TeamMemberForm } from './TeamMemberForm';

interface StepDef {
  id: string;
  emoji: string;
  title: string;
  intro: string;
  match?: (t: { kind: DreKind; category: DreCategory }) => boolean;
  kind?: DreKind;
}
const STEPS: StepDef[] = [
  {
    id: 'equipe',
    emoji: '👥',
    title: 'Sua equipe',
    intro:
      'Pessoas costumam ser o maior gasto fixo de uma loja. Cadastre cada uma (inclusive você, se tira pró-labore): o sistema calcula o custo real e lança todo mês sozinho. Contratou ou alguém saiu? É só voltar aqui.',
  },
  {
    id: 'estrutura',
    emoji: '🏠',
    title: 'Barracão e estrutura',
    kind: 'despesa_fixa',
    intro:
      'O que você paga todo mês para o espaço funcionar. Marque o que tem e informe o valor uma vez: ele se repete todo mês até você mudar.',
    match: (t) => t.kind === 'despesa_fixa' && t.category === 'estrutura',
  },
  {
    id: 'servicos',
    emoji: '💻',
    title: 'Sistemas e serviços',
    kind: 'despesa_fixa',
    intro: 'Contador, sistemas, aplicativos e marketing fora do Mercado Livre.',
    match: (t) =>
      t.kind === 'despesa_fixa' &&
      ['sistemas', 'servicos', 'marketing', 'outros'].includes(t.category),
  },
  {
    id: 'vender',
    emoji: '📦',
    title: 'Custos para vender',
    kind: 'custo_variavel',
    intro:
      'Tarifa, frete e Mercado Ads já entram sozinhos. Aqui vai o resto que cresce com as vendas: embalagem, etiqueta, motoboy…',
    match: (t) => t.kind === 'custo_variavel',
  },
  {
    id: 'bancos',
    emoji: '🏦',
    title: 'Bancos e juros',
    kind: 'despesa_financeira',
    intro:
      'Juros de empréstimo, antecipação e tarifas do banco. Só os juros: a parte que devolve o empréstimo não é despesa.',
    match: (t) => t.kind === 'despesa_financeira',
  },
  {
    id: 'plataformas',
    emoji: '🛍️',
    title: 'Outras plataformas',
    kind: 'outra_plataforma',
    intro:
      'Vende também na TikTok Shop, Shopee ou em outro lugar? Informe quanto sobrou de lá neste mês (depois do custo dos produtos, tarifas e frete), mesmo que aproximado. Isso soma no resultado para pagar as contas. Não vende? Pode pular.',
    match: (t) => t.kind === 'outra_plataforma',
  },
  { id: 'pronto', emoji: '✅', title: 'Pronto', intro: '' },
];

const activeIn = (e: DreEntryDto, month: string) =>
  e.basis === 'unico'
    ? e.startMonth === month
    : e.startMonth <= month && (!e.endMonth || e.endMonth >= month);
const unit = (e: Pick<DreEntryDto, 'basis' | 'amount'>) =>
  e.basis === 'unico'
    ? money(e.amount)
    : e.basis === 'percentual'
      ? `${e.amount.toLocaleString('pt-BR')}%`
      : e.basis === 'pedido'
        ? `${money(e.amount)}/pedido`
        : `${money(e.amount)}/mês`;

type Sub =
  | { type: 'person'; entry?: DreEntryDto }
  | { type: 'entry'; entry?: DreEntryDto; kind?: DreKind }
  | null;

/** Passo a passo para cadastrar todos os gastos da empresa uma vez; depois eles entram sozinhos no DRE todo mês. */
export function CostSetup({
  entries,
  month,
  sample,
  onChanged,
  onClose,
}: {
  entries: DreEntryDto[];
  month: string;
  sample: { pedidos: number; receitaBruta: number };
  onChanged: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [step, setStep] = useState(0);
  const [sub, setSub] = useState<Sub>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const def = STEPS[step]!;
  const done = async () => {
    setSub(null);
    await onChanged();
  };

  if (sub?.type === 'person') {
    return (
      <TeamMemberForm
        entry={sub.entry}
        role="clt"
        month={month}
        onDone={() => void done()}
        onCancel={() => setSub(null)}
      />
    );
  }
  if (sub?.type === 'entry') {
    return (
      <EntryWizard
        entry={sub.entry}
        kind={sub.kind}
        month={month}
        sample={sample}
        onDone={() => void done()}
        onClose={() => setSub(null)}
      />
    );
  }

  const quickAdd = async (t: Template) => {
    const amount = Number((values[t.name] ?? '').replace(/\./g, '').replace(',', '.'));
    if (!(amount > 0)) return setError(`Informe o valor de ${t.name.toLowerCase()}.`);
    setError('');
    setBusy(t.name);
    try {
      await dreApi.create({
        name: t.name,
        kind: t.kind,
        category: t.category,
        basis: t.basis,
        amount,
        startMonth: month,
        endMonth: null,
        notes: null,
      });
      setValues((v) => ({ ...v, [t.name]: '' }));
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.');
    } finally {
      setBusy(null);
    }
  };

  const people = entries.filter((e) => e.category === 'pessoas');
  const fixedTotal = entries
    .filter(
      (e) =>
        (e.kind === 'despesa_fixa' || e.kind === 'despesa_financeira') &&
        e.basis === 'mensal' &&
        activeIn(e, month),
    )
    .reduce((a, e) => a + e.amount, 0);

  return (
    <div className="setup">
      <ol className="setup-steps" aria-label="Etapas">
        {STEPS.map((s, i) => (
          <li
            key={s.id}
            aria-current={i === step ? 'step' : undefined}
            data-done={i < step || undefined}
          >
            <button type="button" onClick={() => setStep(i)}>
              <span aria-hidden="true">{s.emoji}</span>
              <small>{s.title}</small>
            </button>
          </li>
        ))}
      </ol>

      <h2>
        {def.emoji} {def.title}
      </h2>
      {def.intro && <p className="dre-muted">{def.intro}</p>}

      {def.id === 'equipe' && (
        <div className="setup-body">
          {people.length === 0 && (
            <p className="setup-q">Você tem funcionários ou tira um pró-labore da empresa?</p>
          )}
          <ul className="setup-list">
            {people.map((e) => {
              const active = activeIn(e, month);
              return (
                <li key={e.id} data-inactive={!active || undefined}>
                  <span className="setup-name">
                    {e.name}
                    <small>
                      {e.details
                        ? `${TEAM_ROLE_INFO[e.details.role].curto} · salário ${money(e.details.salario)}`
                        : '⚠️ só o valor informado, sem encargos'}
                      {e.endMonth
                        ? ` · saiu em ${monthLabel(e.endMonth, true)}`
                        : ` · desde ${monthLabel(e.startMonth, true)}`}
                    </small>
                  </span>
                  <b className="money" title="Custo real por mês">
                    {money(e.amount)}
                  </b>
                  <button
                    type="button"
                    className="link"
                    onClick={() => setSub({ type: 'person', entry: e })}
                  >
                    {!e.details ? 'calcular custo real' : active ? 'editar / desligar' : 'editar'}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="setup-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => setSub({ type: 'person' })}
            >
              + Adicionar pessoa
            </button>
            {people.length === 0 && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setStep(1)}>
                Não tenho, só eu e sem pró-labore
              </button>
            )}
          </div>
        </div>
      )}

      {def.match && (
        <div className="setup-body">
          <ul className="setup-list">
            {TEMPLATES.filter((t) => !t.pessoa && def.match!(t)).map((t) => {
              const saved = entries.find((e) => e.name === t.name && activeIn(e, month));
              return (
                <li key={t.name} data-saved={saved ? '' : undefined}>
                  <span className="setup-name">
                    <span aria-hidden="true">{t.emoji}</span> {t.name}
                    <small>{t.dica ?? DRE_BASIS_LABELS[t.basis]}</small>
                  </span>
                  {saved ? (
                    <>
                      <b className="money">✓ {unit(saved)}</b>
                      <button
                        type="button"
                        className="link"
                        onClick={() => setSub({ type: 'entry', entry: saved })}
                      >
                        editar
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="wiz-money setup-input">
                        {t.basis !== 'percentual' && <i>R$</i>}
                        <input
                          inputMode="decimal"
                          placeholder={
                            t.basis === 'pedido'
                              ? 'por pedido'
                              : t.basis === 'percentual'
                                ? '% das vendas'
                                : t.basis === 'unico'
                                  ? 'neste mês'
                                  : 'por mês'
                          }
                          value={values[t.name] ?? ''}
                          aria-label={`Valor de ${t.name}`}
                          onChange={(e) =>
                            setValues((v) => ({
                              ...v,
                              [t.name]: e.target.value.replace(/[^\d.,]/g, ''),
                            }))
                          }
                          onKeyDown={(e) =>
                            e.key === 'Enter' && (e.preventDefault(), void quickAdd(t))
                          }
                        />
                        {t.basis === 'percentual' && <i>%</i>}
                      </span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={busy === t.name || !values[t.name]}
                        onClick={() => void quickAdd(t)}
                      >
                        Adicionar
                      </button>
                    </>
                  )}
                </li>
              );
            })}
            {entries
              .filter(
                (e) =>
                  def.match!(e) && !TEMPLATES.some((t) => t.name === e.name) && activeIn(e, month),
              )
              .map((e) => (
                <li key={e.id} data-saved="">
                  <span className="setup-name">
                    {e.name}
                    <small>{DRE_BASIS_LABELS[e.basis]}</small>
                  </span>
                  <b className="money">✓ {unit(e)}</b>
                  <button
                    type="button"
                    className="link"
                    onClick={() => setSub({ type: 'entry', entry: e })}
                  >
                    editar
                  </button>
                </li>
              ))}
          </ul>
          <button
            type="button"
            className="link"
            onClick={() => setSub({ type: 'entry', kind: def.kind })}
          >
            {def.kind === 'outra_plataforma' ? '+ Outra plataforma' : '+ Outro gasto deste tipo'}
          </button>
        </div>
      )}

      {def.id === 'pronto' && (
        <div className="setup-body setup-done">
          <p className="be-value">
            <span className="money">{money(fixedTotal)}</span>
            <small>de gastos fixos por mês</small>
          </p>
          <p>
            Pronto! Daqui para frente esses gastos entram <b>sozinhos</b> no DRE de cada mês, junto
            com o que vem do Mercado Livre. Contratou, alguém saiu, o aluguel mudou? Volte em{' '}
            <b>Montar meus custos</b> e ajuste: os meses anteriores continuam como estavam.
          </p>
          <p className="dre-muted">
            {people.filter((e) => activeIn(e, month)).length} pessoas na equipe ·{' '}
            {entries.filter((e) => e.kind !== 'outra_plataforma').length} gastos cadastrados
          </p>
        </div>
      )}

      {error && (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      )}
      <div className="wiz-actions">
        {step > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setStep(step - 1)}>
            Voltar
          </button>
        )}
        {step < STEPS.length - 1 ? (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => {
              setError('');
              setStep(step + 1);
            }}
          >
            Próximo: {STEPS[step + 1]!.title}
          </button>
        ) : (
          <button type="button" className="btn btn-primary btn-sm" onClick={onClose}>
            Ver meu DRE
          </button>
        )}
      </div>
    </div>
  );
}
