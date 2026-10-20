import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AD_METRICS, AD_METRIC_INFO, AD_OPS, AD_OP_LABELS, AD_WINDOWS, AD_WINDOW_LABELS, formatAdMetric,
  type AdCampaignDetailDto, type AdCampaignDto, type AdCondition, type AdEventDto, type AdGoalDto, type AdGoalKind, type AdRuleDto,
  type AdRuleScope, type AdSimulationDto, type AdStatus, type AdsRadarOverviewDto,
} from '@nvs/shared';
import { money } from '../../shared/format';
import { ApiError } from '../../shared/http';
import { Icon } from '../../shared/ui/Icon';
import { adsRadarApi } from './ads-radar-api';

export const TONE_COLOR: Record<AdStatus, string> = { estourado: 'var(--danger)', atencao: 'var(--yellow)', ok: 'var(--ok)' };
export const STATUS_LABEL: Record<AdStatus | 'all', string> = { all: 'Todas', estourado: 'Estouradas', atencao: 'Atenção', ok: 'Ok' };

export const fmtPct = (v: number | null) => (v === null ? '—' : `${v.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`);
export const fmtX = (v: number | null) => (v === null ? '—' : `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}x`);
const short: Record<string, string> = { hoje: 'hoje', ontem: 'ontem', '3d': '3 dias', '7d': '7 dias', '14d': '14 dias', '30d': '30 dias', mes: 'no mês' };

/** "TACOS 7 dias maior que 4,0%" */
export function conditionText(c: AdCondition): string {
  const v = c.op === 'sobe' || c.op === 'cai' ? `${c.value.toLocaleString('pt-BR')}%` : formatAdMetric(c.metric, c.value);
  return `${AD_METRIC_INFO[c.metric].label} ${short[c.window]} ${AD_OP_LABELS[c.op]} ${v}`;
}
export const ruleTone = (r: AdRuleDto): AdStatus | null => (!r.enabled ? null : r.now.estourado ? 'estourado' : r.now.atencao ? 'atencao' : 'ok');
export const SCOPE_LABEL: Record<AdRuleScope, string> = { conta: 'Regra da conta', campanhas: 'Regra · cada campanha', campanha: 'Regra da campanha' };

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Algo deu errado. Tente novamente.');

// ---------------------------------------------------------------- escolha em pílula (menu flutuante)

function Choice<T extends string>({ value, options, onChange, label }: { value: T; options: readonly { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  return (
    <span ref={ref} style={{ position: 'relative' }}>
      <button type="button" className="ar-pill" aria-label={label} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {options.find((o) => o.value === value)?.label ?? value}
      </button>
      {open && (
        <span className="ar-menu" role="listbox" aria-label={label}>
          {options.map((o) => (
            <button key={o.value} type="button" role="option" aria-selected={o.value === value} onClick={() => { onChange(o.value); setOpen(false); }}>
              {o.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

const METRIC_OPTS = AD_METRICS.map((m) => ({ value: m, label: AD_METRIC_INFO[m].label }));
const WINDOW_OPTS = AD_WINDOWS.map((w) => ({ value: w, label: AD_WINDOW_LABELS[w] }));
const OP_OPTS = AD_OPS.map((o) => ({ value: o, label: AD_OP_LABELS[o] }));
const unitOf = (c: AdCondition) => (c.op === 'sobe' || c.op === 'cai' ? '%' : { '%': '%', pp: 'p.p.', x: 'x', brl: 'R$', un: '' }[AD_METRIC_INFO[c.metric].unit]);

// ---------------------------------------------------------------- editor de regra

export interface RuleDraftPreset {
  scope: AdRuleScope;
  campaignId: number | null;
  accountId: string | null;
}

/** Regra como frase: "Quando [TACOS] dos [últimos 7 dias] for [maior que] [4] %". Simula ao vivo nos últimos 30 dias. */
export function RuleEditor({
  rule, preset, campaigns, canWrite, onDone,
}: { rule: AdRuleDto | null; preset: RuleDraftPreset; campaigns: AdCampaignDto[]; canWrite: boolean; onDone: (changed: boolean) => void }) {
  const [name, setName] = useState(rule?.name ?? '');
  const [scope, setScope] = useState<AdRuleScope>(rule?.scope ?? preset.scope);
  const [campaignId, setCampaignId] = useState<number | null>(rule?.campaignId ?? preset.campaignId);
  const [conditions, setConditions] = useState<AdCondition[]>(rule?.conditions ?? [{ metric: 'tacos', window: '7d', op: 'maior', value: 4 }]);
  const [cooldown, setCooldown] = useState(rule?.cooldownHours ?? 24);
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [sim, setSim] = useState<AdSimulationDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');
  const accountId = rule?.accountId ?? preset.accountId;

  const setCond = (i: number, patch: Partial<AdCondition>) => setConditions((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const valid = conditions.every((c) => Number.isFinite(c.value)) && (scope !== 'campanha' || campaignId !== null);

  // simulação ao vivo (espera a pessoa parar de mexer)
  useEffect(() => {
    if (!valid) return;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      adsRadarApi
        .simulate({ accountId, scope, campaignId: scope === 'campanha' ? campaignId : null, conditions, cooldownHours: cooldown, days: 30 }, ctl.signal)
        .then(setSim)
        .catch(() => setSim(null));
    }, 400);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [accountId, scope, campaignId, conditions, cooldown, valid]);

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const body = {
        name: name.trim() || conditions.map(conditionText).join(' e ').slice(0, 80),
        accountId, scope, campaignId: scope === 'campanha' ? campaignId : null, conditions, enabled, cooldownHours: cooldown,
      };
      if (rule) await adsRadarApi.updateRule(rule.id, body);
      else await adsRadarApi.createRule(body);
      onDone(true);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!rule) return;
    setBusy(true);
    try {
      await adsRadarApi.deleteRule(rule.id);
      onDone(true);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  const campaignName = campaigns.find((c) => c.campaignId === campaignId)?.name;
  return (
    <>
      <h2>{rule ? 'Regra' : 'Nova regra'}</h2>
      <p className="ar-sub">Toque nas partes em azul para trocar. Todas as condições precisam bater para avisar.</p>

      <div className="ar-row">
        <span>Vale para</span>
        <div className="ar-seg" role="group" aria-label="Escopo da regra">
          {(['campanhas', 'conta', 'campanha'] as const).map((s) => (
            <button key={s} type="button" aria-pressed={scope === s} onClick={() => setScope(s)}>
              {s === 'campanhas' ? 'Cada campanha' : s === 'conta' ? 'Conta inteira' : 'Uma campanha'}
            </button>
          ))}
        </div>
      </div>
      {scope === 'campanha' && (
        <div className="ar-row">
          <span className="grow">Campanha</span>
          <select value={campaignId ?? ''} onChange={(e) => setCampaignId(e.target.value ? Number(e.target.value) : null)} aria-label="Campanha">
            <option value="">Escolha…</option>
            {campaigns.map((c) => <option key={c.campaignId} value={c.campaignId}>{c.name}</option>)}
          </select>
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        {conditions.map((c, i) => (
          <div className="ar-cond" key={i}>
            <div className="ar-sentence">
              {i === 0 ? 'Quando' : 'e'}
              <Choice label="Métrica" value={c.metric} options={METRIC_OPTS} onChange={(metric) => setCond(i, { metric })} />
              {c.window === 'hoje' || c.window === 'ontem' || c.window === 'mes' ? 'de' : 'dos'}
              <Choice label="Período" value={c.window} options={WINDOW_OPTS} onChange={(window) => setCond(i, { window })} />
              for
              <Choice label="Comparação" value={c.op} options={OP_OPTS} onChange={(op) => setCond(i, { op })} />
              <input
                className="ar-pill-input"
                type="number"
                step="any"
                aria-label="Valor"
                value={Number.isFinite(c.value) ? c.value : ''}
                onChange={(e) => setCond(i, { value: e.target.value === '' ? Number.NaN : Number(e.target.value) })}
              />
              {unitOf(c)}
            </div>
            {conditions.length > 1 && (
              <button type="button" className="ar-x" aria-label="Tirar condição" onClick={() => setConditions((cs) => cs.filter((_, j) => j !== i))}>✕</button>
            )}
          </div>
        ))}
        {conditions.length < 5 && (
          <button type="button" className="ar-pill muted" style={{ marginTop: 6 }} onClick={() => setConditions((cs) => [...cs, { metric: 'cliques', window: '7d', op: 'maior', value: 50 }])}>
            + condição
          </button>
        )}
      </div>

      <div className="ar-row">
        <span className="grow">Avisar de novo a mesma {scope === 'conta' ? 'conta' : 'campanha'} só depois de</span>
        <select value={cooldown} onChange={(e) => setCooldown(Number(e.target.value))} aria-label="Intervalo entre avisos">
          {[6, 12, 24, 48, 72, 168].map((h) => <option key={h} value={h}>{h < 48 ? `${h} horas` : `${h / 24} dias`}</option>)}
        </select>
      </div>
      <div className="ar-row">
        <span className="grow">Nome (opcional)</span>
        <input type="text" value={name} maxLength={80} placeholder={conditions.map(conditionText).join(' e ').slice(0, 60)} onChange={(e) => setName(e.target.value)} aria-label="Nome da regra" />
      </div>
      <div className="ar-row">
        <span className="grow">Regra ligada</span>
        <button type="button" role="switch" className="ar-switch" aria-checked={enabled} aria-label="Regra ligada" onClick={() => setEnabled((e) => !e)} />
      </div>

      {sim && (
        <div className="ar-preview" data-tone={sim.total ? undefined : 'ok'} role="status">
          {sim.total
            ? <>Nos últimos {sim.days} dias essa regra teria avisado <b>{sim.total} {sim.total === 1 ? 'vez' : 'vezes'}</b>
                {scope !== 'conta' && <> em {sim.targets.slice(0, 4).map((t) => t.name).join(', ')}{sim.targets.length > 4 ? ` e mais ${sim.targets.length - 4}` : ''}</>}.</>
            : <>Nos últimos {sim.days} dias essa regra não teria avisado nenhuma vez{scope === 'campanha' && campaignName ? ` em ${campaignName}` : ''}.</>}
        </div>
      )}
      {error && <p className="ar-error" role="alert">{error}</p>}

      <div className="ar-actions">
        {rule && canWrite && (
          confirmDelete
            ? <button type="button" className="ar-btn danger left" disabled={busy} onClick={remove}>Confirmar exclusão</button>
            : <button type="button" className="ar-btn left" onClick={() => setConfirmDelete(true)}>Excluir</button>
        )}
        <button type="button" className="ar-btn" onClick={() => onDone(false)}>Cancelar</button>
        {canWrite && <button type="button" className="ar-btn primary" disabled={busy || !valid} onClick={save}>{rule ? 'Salvar regra' : 'Criar regra'}</button>}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- metas

const GOAL_TITLE: Record<AdGoalKind, string> = { gasto_mes: 'Meta do mês', gasto_ano: 'Meta do ano', tacos: 'Objetivo de TACOS' };

function paceTag(g: AdGoalDto) {
  if (g.kind === 'tacos') {
    if (g.current === null) return null;
    const d = Math.round((g.current - g.target) * 10) / 10;
    return d > 0
      ? <span className="ar-chip" data-tone="estourado">{d.toLocaleString('pt-BR')} p.p. acima</span>
      : <span className="ar-chip" data-tone="ok">dentro do objetivo</span>;
  }
  const p = g.pace!;
  if (p.status === 'acima') return <span className="ar-chip" data-tone="estourado">ritmo {Math.round(p.paceDiff)}% acima</span>;
  if (p.status === 'abaixo') return <span className="ar-chip" data-tone="atencao">ritmo {Math.round(-p.paceDiff)}% abaixo</span>;
  return <span className="ar-chip" data-tone="ok">no ritmo</span>;
}

export function GoalCard({ goal }: { goal: AdGoalDto }) {
  const isTacos = goal.kind === 'tacos';
  return (
    <div className="ar-goal">
      <div className="ar-goal-top"><span>{GOAL_TITLE[goal.kind]}</span>{paceTag(goal)}</div>
      <div className="ar-goal-val">
        {isTacos ? fmtPct(goal.current) : money(goal.current ?? 0)} <small>{isTacos ? `objetivo ${fmtPct(goal.target)}` : `de ${money(goal.target)}`}</small>
      </div>
      {isTacos ? (
        <div className="ar-track"><span className="fill" style={{ width: `${Math.min(100, ((goal.current ?? 0) / (goal.target * 2)) * 100)}%`, background: TONE_COLOR[goal.status] }} /><span className="mark" style={{ left: '50%' }} /></div>
      ) : (
        <div className="ar-track">
          <span className="proj" style={{ width: `${Math.min(100, (goal.pace!.projected / goal.target) * 100)}%` }} />
          <span className="fill" style={{ width: `${Math.min(100, ((goal.current ?? 0) / goal.target) * 100)}%` }} />
          <span className="mark" style={{ left: `${goal.pace!.elapsed * 100}%` }} />
        </div>
      )}
      <div className="ar-goal-foot">{isTacos ? 'TACOS do mês até agora' : `Nesse ritmo fecha em ${money(goal.pace!.projected)}`}</div>
    </div>
  );
}

/** Metas do mês, do ano e objetivo de TACOS: ver e editar no mesmo lugar. */
export function GoalsPanel({ goals, today, canWrite, onChanged }: { goals: AdGoalDto[]; today: string; canWrite: boolean; onChanged: () => void }) {
  const month = `${today.slice(0, 7)}-01`, year = `${today.slice(0, 4)}-01-01`;
  const slots: { kind: AdGoalKind; periodStart: string | null }[] = [
    { kind: 'gasto_mes', periodStart: month }, { kind: 'gasto_ano', periodStart: year }, { kind: 'tacos', periodStart: null },
  ];
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const find = (s: (typeof slots)[number]) => goals.find((g) => g.kind === s.kind && g.periodStart === s.periodStart && g.accountId === null);
  const save = async (s: (typeof slots)[number]) => {
    const target = Number((values[s.kind] ?? '').replace(',', '.'));
    if (!(target > 0)) return setError('Informe um valor maior que zero.');
    setBusy(s.kind);
    setError('');
    try {
      await adsRadarApi.saveGoal({ accountId: null, kind: s.kind, periodStart: s.periodStart, target });
      setValues((v) => ({ ...v, [s.kind]: '' }));
      onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  };
  const remove = async (id: string) => {
    setBusy(id);
    try {
      await adsRadarApi.deleteGoal(id);
      onChanged();
    } finally {
      setBusy('');
    }
  };
  return (
    <>
      <h2>Metas de investimento</h2>
      <p className="ar-sub">A barra cheia é o gasto, a listrada é a projeção no ritmo atual e o traço é o dia de hoje.</p>
      <div className="ar-goals">
        {slots.map((s) => {
          const g = find(s);
          return (
            <div key={s.kind}>
              {g ? <GoalCard goal={g} /> : (
                <div className="ar-goal"><div className="ar-goal-top"><span>{GOAL_TITLE[s.kind]}</span></div><div className="ar-goal-foot" style={{ marginTop: 8 }}>Ainda sem meta.</div></div>
              )}
              {canWrite && (
                <div className="ar-goal-edit">
                  <input
                    inputMode="decimal"
                    placeholder={s.kind === 'tacos' ? 'Ex.: 4 (%)' : 'Ex.: 30000 (R$)'}
                    value={values[s.kind] ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [s.kind]: e.target.value }))}
                    aria-label={`${GOAL_TITLE[s.kind]}: novo valor`}
                  />
                  <button type="button" className="ar-btn" disabled={busy === s.kind} onClick={() => save(s)}>{g ? 'Trocar' : 'Definir'}</button>
                  {g && <button type="button" className="ar-btn" aria-label={`Tirar ${GOAL_TITLE[s.kind]}`} disabled={busy === g.id} onClick={() => remove(g.id)}>✕</button>}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {error && <p className="ar-error" role="alert">{error}</p>}
      <p className="ar-goal-foot" style={{ marginTop: 14 }}>O gasto do ano conta a partir de quando a conta foi conectada ao sistema (o ML só guarda 90 dias).</p>
    </>
  );
}

// ---------------------------------------------------------------- alertas

const when = (iso: string) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export function EventsPanel({ events, onOpenCampaign, onReadAll }: { events: AdEventDto[]; onOpenCampaign: (e: AdEventDto) => void; onReadAll: () => void }) {
  return (
    <>
      <h2>Alertas</h2>
      <p className="ar-sub">Clique num alerta para abrir o fluxo da campanha.</p>
      {events.length ? (
        <div className="ar-feed ar-scroll">
          {events.map((e) => (
            <button key={e.id} type="button" className="ar-ev" data-read={e.read || undefined} onClick={() => onOpenCampaign(e)}>
              <small>{when(e.firedAt)} · {e.ruleName}</small>
              {e.message}
            </button>
          ))}
        </div>
      ) : (
        <p className="ar-goal-foot">Nenhum alerta ainda. Quando uma regra passar do limite, ele aparece aqui.</p>
      )}
      {events.some((e) => !e.read) && (
        <div className="ar-actions"><button type="button" className="ar-btn" onClick={onReadAll}>Marcar todos como lidos</button></div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- visão geral

export function OverviewPanel({ overview, campaigns, onPick }: { overview: AdsRadarOverviewDto; campaigns: AdCampaignDto[]; onPick: (c: AdCampaignDto) => void }) {
  const groups: AdStatus[] = ['estourado', 'atencao', 'ok'];
  const active = campaigns.filter((c) => c.mlStatus === 'active');
  return (
    <>
      <h2>Visão geral</h2>
      <p className="ar-sub">{active.length} campanhas ativas · a barra é o ACOS de 7 dias e o traço é o alvo de cada uma. Clique para abrir o fluxo.</p>
      {overview.goals.length > 0 && <div className="ar-goals">{overview.goals.map((g) => <GoalCard key={g.id} goal={g} />)}</div>}
      <div className="ar-scroll">
      {groups.map((s) => {
        const list = active.filter((c) => c.status === s).sort((a, b) => b.last7.cost - a.last7.cost);
        if (!list.length) return null;
        return (
          <div key={s}>
            <div className="ar-sec">{STATUS_LABEL[s]} · {list.length}</div>
            <div className="ar-tiles">
              {list.map((c) => (
                <button key={`${c.accountId}:${c.campaignId}`} type="button" className="ar-tile" data-tone={s} onClick={() => onPick(c)}>
                  <b>{c.name}</b>
                  <strong style={{ color: s === 'ok' ? undefined : TONE_COLOR[s] }}>{fmtPct(c.last7.acos)}</strong>
                  <small>ACOS · {money(c.last7.cost)} em 7d</small>
                  <div className="ar-track" style={{ height: 6, margin: '8px 0 0' }}>
                    <span className="fill" style={{ width: `${Math.min(100, ((c.last7.acos ?? 0) / Math.max(1, (c.acosTarget ?? 5) * 2)) * 100)}%`, background: TONE_COLOR[s] }} />
                    {c.acosTarget !== null && <span className="mark" style={{ left: '50%' }} />}
                  </div>
                </button>
              ))}
            </div>
          </div>
        );
      })}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- robô (Fase 2)

export function RobotPanel() {
  return (
    <>
      <h2>Robô</h2>
      <p className="ar-sub">Em breve. Por enquanto o Radar só avisa — nenhuma mudança é feita no Mercado Livre.</p>
      <div className="ar-row"><span className="grow">Ação automática</span><button type="button" role="switch" className="ar-switch" aria-checked={false} disabled aria-label="Ação automática (em breve)" /></div>
      <div className="ar-row"><span className="grow">Pausar anúncio · mover de campanha · mudar orçamento · mudar ACOS objetivo</span></div>
      <div className="ar-row"><span className="grow">Com pedido de aprovação, limite por dia e botão de desfazer</span></div>
    </>
  );
}

// ---------------------------------------------------------------- detalhe da campanha

export function CampaignPanel({ detail }: { detail: AdCampaignDetailDto }) {
  const c = detail.campaign;
  const maxCost = Math.max(1, ...detail.series.map((d) => d.cost));
  return (
    <>
      <h2>{c.name}</h2>
      <p className="ar-sub">
        {c.mlStatus === 'active' ? 'Ativa' : 'Pausada'} no ML · alvo de ACOS {fmtPct(c.acosTarget)}{c.budget !== null ? ` · orçamento ${money(c.budget)}` : ''}
      </p>
      <div className="ar-goals">
        <div className="ar-goal"><div className="ar-goal-top"><span>Investimento 7d</span></div><div className="ar-goal-val">{money(c.last7.cost)}</div></div>
        <div className="ar-goal"><div className="ar-goal-top"><span>ACOS · TACOS 7d</span></div><div className="ar-goal-val">{fmtPct(c.last7.acos)} <small>· {fmtPct(c.last7.tacos)}</small></div></div>
        <div className="ar-goal"><div className="ar-goal-top"><span>ROAS 7d</span></div><div className="ar-goal-val">{fmtX(c.last7.roas)}</div></div>
      </div>
      {detail.series.length > 0 && (
        <>
          <div className="ar-sec">Investimento dia a dia (30 dias)</div>
          <svg viewBox={`0 0 ${detail.series.length * 10} 60`} preserveAspectRatio="none" style={{ width: '100%', height: 70 }} role="img" aria-label="Investimento por dia">
            {detail.series.map((d, i) => (
              <rect key={d.day} x={i * 10 + 1} y={60 - (d.cost / maxCost) * 58} width={8} height={(d.cost / maxCost) * 58} rx={2} fill="var(--blue)" opacity={0.75}>
                <title>{`${d.day.split('-').reverse().slice(0, 2).join('/')}: ${money(d.cost)} · ACOS ${fmtPct(d.acos)}`}</title>
              </rect>
            ))}
          </svg>
        </>
      )}
      <div className="ar-sec">Anúncios da campanha · {detail.items.length}</div>
      <div className="ar-items ar-scroll" style={{ maxHeight: 260 }}>
        {detail.items.slice(0, 12).map((i) => (
          <div className="ar-item" key={i.itemId}>
            {i.thumbnail ? <img src={i.thumbnail.replace('http://', 'https://')} alt="" loading="lazy" /> : <img alt="" />}
            <span>{i.title ?? i.itemId}</span>
            <b>{money(i.last7.cost)}</b>
            <small style={{ minWidth: 64, textAlign: 'right' }}>ACOS {fmtPct(i.last7.acos)}</small>
          </div>
        ))}
        {detail.items.length > 12 && <p className="ar-goal-foot">e mais {detail.items.length - 12} anúncios.</p>}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- gaveta de campanhas

type Order = 'risco' | 'gasto' | 'nome';
const RANK: Record<AdStatus, number> = { estourado: 2, atencao: 1, ok: 0 };

export function CampaignDrawer({
  open, campaigns, filter, onFilter, selected, onPick, onClose,
}: {
  open: boolean; campaigns: AdCampaignDto[]; filter: AdStatus | 'all'; onFilter: (f: AdStatus | 'all') => void;
  selected: string | null; onPick: (c: AdCampaignDto) => void; onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [order, setOrder] = useState<Order>('risco');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 250);
  }, [open]);
  const active = useMemo(() => campaigns.filter((c) => c.mlStatus === 'active'), [campaigns]);
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return active
      .filter((c) => (filter === 'all' || c.status === filter) && c.name.toLowerCase().includes(q))
      .sort((a, b) => (order === 'nome' ? a.name.localeCompare(b.name) : order === 'gasto' ? b.last7.cost - a.last7.cost : RANK[b.status] - RANK[a.status] || b.last7.cost - a.last7.cost));
  }, [active, filter, query, order]);
  const count = (s: AdStatus | 'all') => (s === 'all' ? active.length : active.filter((c) => c.status === s).length);

  return (
    <aside className="ar-drawer" data-open={open || undefined} aria-label="Campanhas" aria-hidden={!open} inert={!open || undefined}>
      <button type="button" className="modal-close" onClick={onClose} aria-label="Fechar"><Icon name="close" /></button>
      <h3>Campanhas</h3>
      <input ref={inputRef} className="ar-search" placeholder="Buscar campanha" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Buscar campanha" />
      <div className="ar-filters" role="group" aria-label="Filtrar por situação">
        {(['all', 'estourado', 'atencao', 'ok'] as const).map((s) => (
          <button key={s} type="button" className="ar-f" aria-pressed={filter === s} onClick={() => onFilter(s)}>
            {STATUS_LABEL[s]} <b>{count(s)}</b>
          </button>
        ))}
      </div>
      <div className="ar-sort">
        Ordem
        <select value={order} onChange={(e) => setOrder(e.target.value as Order)} aria-label="Ordem">
          <option value="risco">Mais arriscadas</option>
          <option value="gasto">Maior investimento</option>
          <option value="nome">Nome</option>
        </select>
      </div>
      <div className="ar-camps">
        {list.length ? list.map((c) => {
          const key = `${c.accountId}:${c.campaignId}`;
          const vals = c.trend.filter((v): v is number => v !== null);
          const max = Math.max(...vals, 0.01), min = Math.min(...vals, 0);
          const pts = c.trend.map((v, i) => `${(i * 46) / 6},${16 - (((v ?? min) - min) / (max - min || 1)) * 14}`).join(' ');
          return (
            <button key={key} type="button" className="ar-camp" aria-current={selected === key} onClick={() => onPick(c)}>
              <span className="ar-dot" style={{ background: TONE_COLOR[c.status] }} />
              <span className="ar-camp-name">{c.name}<small>{c.rules ? `${c.rules} regra${c.rules > 1 ? 's' : ''}` : 'alvo do ML'} · {money(c.last7.cost)}</small></span>
              <svg width="46" height="18" aria-hidden="true"><polyline points={pts} fill="none" stroke={TONE_COLOR[c.status]} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
              <span className="ar-val" data-tone={c.status} style={{ background: `color-mix(in srgb, ${TONE_COLOR[c.status]} 14%, transparent)` }}>{fmtPct(c.last7.acos)}</span>
            </button>
          );
        }) : <p className="ar-goal-foot" style={{ padding: 12 }}>Nenhuma campanha com esse filtro.</p>}
      </div>
    </aside>
  );
}
