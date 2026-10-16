import { useState } from 'react';
import {
  COMPANY_REGIMES,
  COMPANY_REGIME_INFO,
  TEAM_ROLES,
  TEAM_ROLE_INFO,
  teamCost,
  type CompanyRegime,
  type DreEntryDto,
  type StaffMember,
  type TeamRole,
} from '@nvs/shared';
import { ApiError } from '../../../shared/http';
import { money } from '../../../shared/format';
import { monthLabel } from '../dre-copy';
import { dreApi } from '../dre-api';

const REGIME_KEY = 'nvs.dre.regime';
const readRegime = (): CompanyRegime => {
  try {
    const v = localStorage.getItem(REGIME_KEY);
    return (COMPANY_REGIMES as readonly string[]).includes(v ?? '')
      ? (v as CompanyRegime)
      : 'simples';
  } catch {
    return 'simples';
  }
};
const num = (t: string) => Number(t.replace(/\./g, '').replace(',', '.')) || 0;
const txt = (n: number) => (n ? String(n).replace('.', ',') : '');
const GUESSES = [1, 1.3, 1.6, 2];

interface Props {
  entry?: DreEntryDto;
  role?: TeamRole;
  month: string;
  onDone: () => void;
  onCancel: () => void;
}

/** Custo real de uma pessoa: salário + 13º + férias + FGTS + INSS (conforme o regime) + benefícios, explicado linha a linha. */
export function TeamMemberForm({ entry, role: initialRole, month, onDone, onCancel }: Props) {
  const d = entry?.details;
  const [name, setName] = useState(entry?.name ?? '');
  const [role, setRole] = useState<TeamRole>(d?.role ?? initialRole ?? 'clt');
  const [regime, setRegime] = useState<CompanyRegime>(d?.regime ?? readRegime);
  const [salario, setSalario] = useState(txt(d?.salario ?? 0));
  const [vt, setVt] = useState(txt(d?.vt ?? 0));
  const [vr, setVr] = useState(txt(d?.vr ?? 0));
  const [saude, setSaude] = useState(txt(d?.saude ?? 0));
  const [outros, setOutros] = useState(txt(d?.outros ?? 0));
  const [start, setStart] = useState(entry?.startMonth ?? month);
  const [left, setLeft] = useState(Boolean(entry?.endMonth));
  const [end, setEnd] = useState(entry?.endMonth ?? month);
  const [guess, setGuess] = useState<number | 'skip' | null>(entry ? 'skip' : null);
  const [why, setWhy] = useState(false);
  const [benefits, setBenefits] = useState(Boolean(d && (d.vt || d.vr || d.saude || d.outros)));
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');

  const member: StaffMember = {
    role,
    regime,
    salario: num(salario),
    vt: num(vt),
    vr: num(vr),
    saude: num(saude),
    outros: num(outros),
  };
  const cost = teamCost(member);
  const s = member.salario;
  const info = TEAM_ROLE_INFO[role];
  const revealed = guess !== null && s > 0;
  const closest = GUESSES.reduce(
    (a, g) => (Math.abs(g - cost.multiplicador) < Math.abs(a - cost.multiplicador) ? g : a),
    GUESSES[0]!,
  );

  const pickRegime = (r: CompanyRegime) => {
    setRegime(r);
    try {
      localStorage.setItem(REGIME_KEY, r);
    } catch {
      /* vale nesta sessão */
    }
  };
  const save = async () => {
    setError('');
    if (!name.trim()) return setError('Informe o nome (ou a função) da pessoa.');
    if (s <= 0) return setError(`Informe o ${info.salarioLabel.toLowerCase()}.`);
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        kind: 'despesa_fixa' as const,
        category: 'pessoas' as const,
        basis: 'mensal' as const,
        amount: cost.total,
        startMonth: start,
        endMonth: left ? (end < start ? start : end) : null,
        notes: null,
        details: member,
      };
      if (entry) await dreApi.update(entry.id, body);
      else await dreApi.create(body);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.');
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
  const moneyInput = (label: string, value: string, set: (v: string) => void, hint?: string) => (
    <label className="wiz-field">
      <span>{label}</span>
      <span className="wiz-money">
        <i>R$</i>
        <input
          inputMode="decimal"
          value={value}
          placeholder="0,00"
          onChange={(e) => set(e.target.value.replace(/[^\d.,]/g, ''))}
        />
      </span>
      {hint && <small className="wiz-hint">{hint}</small>}
    </label>
  );

  return (
    <form
      className="wiz team"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h2>{entry ? `Editar ${entry.name}` : 'Quanto essa pessoa custa de verdade?'}</h2>
      {!entry && (
        <p className="dre-muted">
          Erro mais comum em DRE: lançar só o salário. Uma pessoa CLT custa bem mais — vamos fazer a
          conta certa.
        </p>
      )}

      <label className="wiz-field">
        <span>Nome ou função</span>
        <input
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ex.: Ana — separação de pedidos"
          data-autofocus
        />
      </label>

      <div className="wiz-field">
        <span>Tipo de contratação</span>
        <div className="wiz-seg" role="radiogroup" aria-label="Tipo de contratação">
          {TEAM_ROLES.map((r) => (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={role === r}
              onClick={() => setRole(r)}
            >
              {TEAM_ROLE_INFO[r].label}
            </button>
          ))}
        </div>
        <small className="wiz-hint">{info.explain}</small>
      </div>

      {role !== 'pj' && role !== 'estagio' && (
        <label className="wiz-field">
          <span>Regime de impostos da sua empresa</span>
          <select value={regime} onChange={(e) => pickRegime(e.target.value as CompanyRegime)}>
            {COMPANY_REGIMES.map((r) => (
              <option key={r} value={r}>
                {COMPANY_REGIME_INFO[r].label}
              </option>
            ))}
          </select>
          <small className="wiz-hint">
            Não sabe? Está no DAS ou pergunte ao contador. Loja online costuma ser Simples.
          </small>
        </label>
      )}

      {moneyInput(info.salarioLabel, salario, setSalario)}

      <button
        type="button"
        className="link wiz-toggle"
        aria-expanded={benefits}
        onClick={() => setBenefits((v) => !v)}
      >
        {benefits ? '− Benefícios' : '+ Benefícios (vale-transporte, refeição, plano de saúde…)'}
      </button>
      {benefits && (
        <div className="wiz-row">
          {role !== 'pj' &&
            moneyInput(
              role === 'estagio' ? 'Auxílio-transporte' : 'Vale-transporte (passagens do mês)',
              vt,
              setVt,
              role === 'estagio'
                ? 'Obrigatório no estágio.'
                : 'Informe o total das passagens: o sistema desconta os 6% que a pessoa paga.',
            )}
          {moneyInput('Vale-refeição / alimentação', vr, setVr)}
          {moneyInput('Plano de saúde (parte da empresa)', saude, setSaude)}
          {moneyInput(
            role === 'estagio' ? 'Seguro de vida e outros' : 'Outros (uniforme, cursos…)',
            outros,
            setOutros,
            role === 'estagio' ? 'O seguro do estagiário é obrigatório.' : undefined,
          )}
        </div>
      )}

      {s > 0 && !revealed && (
        <div className="guess" role="group" aria-label="Adivinhe o custo">
          <p>
            🎯 <b>Antes de ver a conta:</b> quanto você acha que essa pessoa custa por mês?
          </p>
          <div className="guess-opts">
            {GUESSES.map((g) => (
              <button key={g} type="button" onClick={() => setGuess(g)}>
                {money(s * g)}
                <small>
                  {g === 1 ? 'só o salário' : `${String(g).replace('.', ',')}× o salário`}
                </small>
              </button>
            ))}
          </div>
          <button type="button" className="link" onClick={() => setGuess('skip')}>
            Só me mostra a conta
          </button>
        </div>
      )}

      {revealed && (
        <div className="cost-reveal">
          {typeof guess === 'number' && (
            <p className="cost-reveal-feedback" data-ok={guess === closest || undefined}>
              {guess === closest
                ? '🎉 Acertou! Pouca gente sabe disso.'
                : guess === 1
                  ? `É o erro mais comum: lançar só o salário. Na verdade custa ${String(cost.multiplicador).replace('.', ',')}× o salário.`
                  : `Quase! O custo real é ${String(cost.multiplicador).replace('.', ',')}× o salário.`}
            </p>
          )}
          <div className="cost-reveal-total">
            <span>Custo real por mês</span>
            <strong className="money">{money(cost.total)}</strong>
            {cost.multiplicador > 1 && (
              <small>
                {String(cost.multiplicador).replace('.', ',')}× o valor de {money(s)}
              </small>
            )}
          </div>
          <ul className="cost-reveal-lines">
            {cost.lines
              .filter((l) => why || !(l.valor === 0 && l.zeroReason === 'não informado'))
              .map((l) => (
                <li key={l.key} data-zero={(l.valor === 0 && Boolean(l.zeroReason)) || undefined}>
                  <span>
                    <b>{l.label}</b>
                    {why && <small>{l.explain}</small>}
                  </span>
                  <span className="money">
                    {l.zeroReason && l.valor === 0 ? <em>{l.zeroReason}</em> : money(l.valor)}
                  </span>
                </li>
              ))}
          </ul>
          <button
            type="button"
            className="link wiz-toggle"
            aria-expanded={why}
            onClick={() => setWhy((v) => !v)}
          >
            {why ? 'Esconder explicações' : 'Entender cada item'}
          </button>
          {why && regime && role !== 'pj' && role !== 'estagio' && (
            <small className="wiz-hint">{COMPANY_REGIME_INFO[regime].explain}</small>
          )}
          <small className="wiz-hint">
            Alíquotas de referência. Seu contador confirma as da sua empresa (RAT, terceiros,
            sindicato).
          </small>
        </div>
      )}

      <div className="wiz-row">
        <label className="wiz-field">
          <span>Começou a trabalhar em</span>
          <input
            type="month"
            value={start}
            onChange={(e) => e.target.value && setStart(e.target.value)}
          />
        </label>
        <label className="wiz-field">
          <span>
            <input type="checkbox" checked={left} onChange={(e) => setLeft(e.target.checked)} />{' '}
            Saiu da empresa?
          </span>
          <input
            type="month"
            disabled={!left}
            value={end}
            min={start}
            onChange={(e) => e.target.value && setEnd(e.target.value)}
            aria-label="Último mês trabalhado"
          />
          {left && (
            <small className="wiz-hint">
              Último mês que conta no DRE: {monthLabel(end < start ? start : end).toLowerCase()}. Os
              meses anteriores ficam como estão.
            </small>
          )}
        </label>
      </div>

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
              Apagar de todos os meses
            </button>
          ) : (
            <button
              type="button"
              className="link wiz-del"
              onClick={() => setConfirmDelete(true)}
              title="Para quem saiu, prefira marcar “Saiu da empresa?”"
            >
              Excluir
            </button>
          ))}
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          Voltar
        </button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
          {saving ? 'Salvando…' : entry ? 'Salvar' : 'Adicionar à equipe'}
        </button>
      </div>
    </form>
  );
}
