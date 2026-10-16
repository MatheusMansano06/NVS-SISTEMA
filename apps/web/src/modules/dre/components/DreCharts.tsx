import type { DreDto, DreSectionId } from '@nvs/shared';
import { money } from '../../../shared/format';
import { SECTION_COPY } from '../dre-copy';

const COSTS: DreSectionId[] = ['deducoes', 'cmv', 'variaveis', 'fixas', 'financeiras'];
const total = (d: DreDto, id: DreSectionId) => d.sections.find((s) => s.id === id)?.total ?? 0;
const per100 = (v: number, base: number) => (base > 0 ? (v / base) * 100 : 0);
const reais = (v: number) => `R$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

interface Props {
  data: DreDto;
  focus: DreSectionId | 'lucro' | null;
  onFocus: (id: DreSectionId | 'lucro' | null) => void;
}

/** "De cada R$ 100 vendidos": para onde vai cada real. Passar o mouse (ou tocar) destaca a parte no DRE. */
export function HundredBar({ data, focus, onFocus, compact }: Props & { compact?: boolean }) {
  const base = data.receitaBruta;
  const lucro = data.subtotals.lucro_liquido;
  const parts = [
    ...COSTS.map((id) => ({ id: id as DreSectionId | 'lucro', label: SECTION_COPY[id].label, emoji: SECTION_COPY[id].emoji, v: per100(total(data, id), base) })),
    { id: 'lucro' as const, label: lucro >= 0 ? 'Sobrou para você' : 'Faltou (prejuízo)', emoji: lucro >= 0 ? '💰' : '⚠️', v: per100(lucro, base) },
  ].filter((p) => Math.abs(p.v) >= 0.05);
  // prejuízo: os custos passam de 100; a barra mostra a proporção dos custos e o prejuízo vai na legenda
  const sum = parts.filter((p) => p.v > 0).reduce((a, p) => a + p.v, 0) || 1;

  if (base <= 0) return <p className="dre-muted">Sem vendas neste mês ainda.</p>;
  return (
    <div className="hundred" data-compact={compact || undefined}>
      <div className="hundred-bar" role="img" aria-label={`De cada R$ 100 vendidos: ${parts.map((p) => `${p.label} R$ ${p.v.toFixed(2)}`).join(', ')}`}>
        {parts
          .filter((p) => p.v > 0)
          .map((p) => (
            <span
              key={p.id}
              className="hundred-seg"
              data-sec={p.id}
              data-dim={(focus && focus !== p.id) || undefined}
              style={{ flexGrow: p.v / sum }}
              onMouseEnter={() => onFocus(p.id)}
              onMouseLeave={() => onFocus(null)}
              title={`${p.label}: ${reais(p.v)} de cada R$ 100`}
            />
          ))}
      </div>
      {!compact && (
        <ul className="hundred-legend">
          {parts.map((p) => (
            <li
              key={p.id}
              data-sec={p.id}
              data-dim={(focus && focus !== p.id) || undefined}
              onMouseEnter={() => onFocus(p.id)}
              onMouseLeave={() => onFocus(null)}
            >
              <i aria-hidden="true" />
              <span>{p.emoji} {p.label}</span>
              <b data-neg={p.v < 0 || undefined}>{reais(p.v)}</b>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Cascata: começa no que você vendeu e cada degrau tira um bloco, até o que sobrou. Clicar abre o bloco no DRE. */
export function Waterfall({ data, focus, onFocus, onPick }: Props & { onPick: (id: DreSectionId | 'lucro') => void }) {
  const steps: { id: DreSectionId | 'lucro'; label: string; v: number; from: number; to: number }[] = [];
  let level = data.receitaBruta;
  steps.push({ id: 'receita', label: 'Vendeu', v: level, from: 0, to: level });
  for (const id of COSTS) {
    const v = total(data, id);
    steps.push({ id, label: SECTION_COPY[id].curto, v: -v, from: level, to: level - v });
    level -= v;
  }
  const lucro = data.subtotals.lucro_liquido;
  steps.push({ id: 'lucro', label: lucro >= 0 ? 'Sobrou' : 'Prejuízo', v: lucro, from: 0, to: lucro });

  const W = 760;
  const H = 280;
  const top = 34;
  const bottom = 56;
  const max = Math.max(data.receitaBruta, 1);
  const min = Math.min(0, ...steps.map((s) => s.to));
  const y = (v: number) => top + ((max - v) / (max - min)) * (H - top - bottom);
  const slot = W / steps.length;
  const bw = Math.min(70, slot * 0.62);

  if (data.receitaBruta <= 0) return <p className="dre-muted">Quando houver vendas no mês, a cascata aparece aqui.</p>;
  return (
    <svg className="waterfall" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Cascata do resultado: do que você vendeu até o que sobrou">
      <line x1="0" x2={W} y1={y(0)} y2={y(0)} className="wf-zero" />
      {steps.map((s, i) => {
        const x = i * slot + (slot - bw) / 2;
        const y1 = y(Math.max(s.from, s.to));
        const h = Math.max(2, Math.abs(y(s.from) - y(s.to)));
        const next = steps[i + 1];
        return (
          <g
            key={s.id}
            className="wf-step"
            data-sec={s.id}
            data-neg={s.id === 'lucro' && lucro < 0 ? '' : undefined}
            data-dim={(focus && focus !== s.id) || undefined}
            onMouseEnter={() => onFocus(s.id)}
            onMouseLeave={() => onFocus(null)}
            onClick={() => onPick(s.id)}
            role="button"
            tabIndex={0}
            aria-label={`${s.label}: ${money(s.v)}`}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onPick(s.id)}
          >
            <rect x={x} y={y1} width={bw} height={h} rx="8" style={{ animationDelay: `${i * 70}ms` }} />
            {next && next.id !== 'lucro' && <line className="wf-link" x1={x + bw} x2={x + slot} y1={y(s.to)} y2={y(s.to)} />}
            <text x={x + bw / 2} y={y1 - 8} textAnchor="middle" className="wf-val">
              {s.v < 0 ? '−' : ''}{compact(Math.abs(s.v))}
            </text>
            <text x={x + bw / 2} y={H - bottom + 22} textAnchor="middle" className="wf-label">{s.label}</text>
            <text x={x + bw / 2} y={H - bottom + 40} textAnchor="middle" className="wf-pct">
              {data.receitaBruta > 0 ? `${((Math.abs(s.v) / data.receitaBruta) * 100).toFixed(1).replace('.', ',')}%` : ''}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

const compact = (v: number) =>
  v >= 1000 ? `${(v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: v >= 100_000 ? 0 : 1 })} mil` : v.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
