import {
  AD_METRIC_INFO, AD_OP_LABELS, AD_WINDOW_LABELS, adMetric, formatAdMetric, sumAdTotals,
  type AdCondition, type AdStatus, type AdTotals, type AdWindow,
} from '@nvs/shared';

/** Totais de um dia (campanha, anúncio ou conta). */
export interface AdDay extends AdTotals {
  day: string; // YYYY-MM-DD
}

export interface DateRange {
  from: string;
  to: string; // inclusivo
}

const DAY_MS = 86_400_000;
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;

/** Período de uma janela, com "hoje" sendo o dia local corrente (parcial). */
export function windowRange(window: AdWindow, today: string): DateRange {
  const yesterday = addDays(today, -1);
  switch (window) {
    case 'hoje': return { from: today, to: today };
    case 'ontem': return { from: yesterday, to: yesterday };
    case 'mes': return { from: `${today.slice(0, 7)}-01`, to: today };
    default: {
      const n = Number(window.slice(0, -1));
      return { from: addDays(today, -n), to: yesterday };
    }
  }
}

/** Janela imediatamente anterior, do mesmo tamanho (base de comparação de "sobe" / "cai"). */
export function previousRange(r: DateRange): DateRange {
  const len = daysBetween(r.from, r.to);
  return { from: addDays(r.from, -len), to: addDays(r.from, -1) };
}

export function totalsIn(series: readonly AdDay[], r: DateRange): AdTotals {
  return sumAdTotals(series.filter((d) => d.day >= r.from && d.day <= r.to));
}

const WARN = 0.85; // a 85% do limite já é "atenção"

/** Situação de um valor contra o limite, no sentido da comparação (maior/sobe: passar é ruim; menor/cai: ficar abaixo). */
export function statusAgainst(value: number | null, op: AdCondition['op'], limit: number): AdStatus {
  if (value === null) return 'ok';
  if (op === 'maior' || op === 'sobe') {
    if (value > limit) return 'estourado';
    return limit > 0 && value >= limit * WARN ? 'atencao' : 'ok';
  }
  if (value < limit) return 'estourado';
  return value <= limit / WARN ? 'atencao' : 'ok';
}

export interface ConditionResult {
  condition: AdCondition;
  /** Valor medido: a métrica (maior/menor) ou a variação em % contra a janela anterior (sobe/cai). */
  value: number | null;
  /** Métrica na janela atual (para mensagens), também em sobe/cai. */
  current: number | null;
  met: boolean;
  status: AdStatus;
}

export interface RuleResult {
  fired: boolean;
  status: AdStatus;
  results: ConditionResult[];
}

export interface RuleContext {
  acosTarget?: number | null;
}

export function evaluateCondition(c: AdCondition, series: readonly AdDay[], today: string, ctx: RuleContext = {}): ConditionResult {
  const range = windowRange(c.window, today);
  const current = adMetric(c.metric, totalsIn(series, range), ctx);
  let value = current;
  if (c.op === 'sobe' || c.op === 'cai') {
    const before = adMetric(c.metric, totalsIn(series, previousRange(range)), ctx);
    value = current === null || before === null || before === 0 ? null : Math.round(((current - before) / Math.abs(before)) * 1000) / 10;
    if (value !== null && c.op === 'cai') value = -value; // "caiu mais de 20%" compara a queda como número positivo
  }
  const limit = c.value;
  const met = value !== null && (c.op === 'menor' ? value < limit : value > limit);
  // "cai" vira "maior" depois de inverter o sinal
  const status = statusAgainst(value, c.op === 'cai' ? 'sobe' : c.op, limit);
  return { condition: c, value, current, met, status };
}

/**
 * Avalia a regra: dispara quando todas as condições batem. Sem disparo, fica em "atenção" se toda condição já
 * bateu ou está perto do limite (e ao menos uma está perto).
 */
export function evaluateRule(conditions: readonly AdCondition[], series: readonly AdDay[], today: string, ctx: RuleContext = {}): RuleResult {
  const results = conditions.map((c) => evaluateCondition(c, series, today, ctx));
  const fired = results.length > 0 && results.every((r) => r.met);
  const near = results.every((r) => r.met || r.status === 'atencao') && results.some((r) => !r.met);
  return { fired, status: fired ? 'estourado' : near ? 'atencao' : 'ok', results };
}

/** Frase do alerta: "TACOS dos últimos 7 dias em 5,2% (limite 4,0%) e Cliques …". */
export function ruleMessage(subject: string, r: RuleResult): string {
  const parts = r.results.map(({ condition: c, value, current }) => {
    const label = `${AD_METRIC_INFO[c.metric].label} ${AD_WINDOW_LABELS[c.window]}`;
    if (c.op === 'sobe' || c.op === 'cai') {
      const now = current === null ? '' : ` (agora ${formatAdMetric(c.metric, current)})`;
      return `${label} ${c.op === 'sobe' ? 'subiu' : 'caiu'} ${value === null ? '—' : `${value.toLocaleString('pt-BR')}%`}${now}`;
    }
    return `${label} em ${current === null ? '—' : formatAdMetric(c.metric, current)} (${AD_OP_LABELS[c.op]} ${formatAdMetric(c.metric, c.value)})`;
  });
  return `${subject}: ${parts.join(' e ')}`;
}

/** Pode avisar de novo? Respeita o intervalo mínimo entre alertas da mesma regra e campanha. */
export function canNotify(lastFiredAt: Date | null, now: Date, cooldownHours: number): boolean {
  return lastFiredAt === null || now.getTime() - lastFiredAt.getTime() >= cooldownHours * 3_600_000;
}

// ---------------------------------------------------------------- metas de investimento

export type PaceStatus = 'acima' | 'no_ritmo' | 'abaixo';

export interface GoalPace {
  target: number;
  spent: number;
  /** Quanto deveria ter sido gasto até hoje num ritmo uniforme. */
  idealToDate: number;
  /** Projeção do período no ritmo atual. */
  projected: number;
  /** Fração do período já passada (hoje conta inteiro). */
  elapsed: number;
  /** Projeção vs meta, em % (positivo = acima). */
  paceDiff: number;
  status: PaceStatus;
}

/** Período da meta: o mês ou o ano que começa em periodStart. */
export function goalPeriod(kind: 'gasto_mes' | 'gasto_ano', periodStart: string): DateRange {
  const [y, m] = periodStart.split('-').map(Number) as [number, number];
  const end = kind === 'gasto_ano' ? new Date(Date.UTC(y + 1, 0, 0)) : new Date(Date.UTC(y, m, 0));
  return { from: periodStart, to: end.toISOString().slice(0, 10) };
}

/** Ritmo da meta de gasto. Acima: projeção 3%+ além da meta; abaixo: 10%+ aquém. */
export function goalPace(target: number, spent: number, period: DateRange, today: string): GoalPace {
  const total = daysBetween(period.from, period.to);
  const passed = Math.min(total, Math.max(0, daysBetween(period.from, today)));
  const elapsed = passed / total;
  const projected = passed > 0 ? (spent / passed) * total : 0;
  const paceDiff = Math.round((projected / target - 1) * 1000) / 10;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    target, spent: r2(spent), idealToDate: r2(target * elapsed), projected: r2(projected), elapsed: Math.round(elapsed * 1000) / 1000, paceDiff,
    status: passed === 0 ? 'no_ritmo' : paceDiff > 3 ? 'acima' : paceDiff < -10 ? 'abaixo' : 'no_ritmo',
  };
}

// ---------------------------------------------------------------- simulação

export interface SimulationHit {
  day: string;
  results: ConditionResult[];
}

/**
 * Roda a regra nos últimos `days` dias já guardados, como se cada dia fosse "hoje" quando fechou, e devolve em que
 * dias ela teria avisado (respeitando o intervalo entre alertas).
 */
export function simulateRule(
  conditions: readonly AdCondition[], series: readonly AdDay[], today: string, days: number, cooldownHours: number, ctx: RuleContext = {},
): SimulationHit[] {
  const hits: SimulationHit[] = [];
  const gapDays = Math.max(1, Math.ceil(cooldownHours / 24));
  let last: string | null = null;
  for (let i = days; i >= 1; i--) {
    const day = addDays(today, -i);
    if (last !== null && daysBetween(last, day) - 1 < gapDays) continue;
    // o dia simulado está fechado: "hoje" dele já tem o total do dia
    const r = evaluateRule(conditions, series.filter((d) => d.day <= day), day, ctx);
    if (r.fired) {
      hits.push({ day, results: r.results });
      last = day;
    }
  }
  return hits;
}
