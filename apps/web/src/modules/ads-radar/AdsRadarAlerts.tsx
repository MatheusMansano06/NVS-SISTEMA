import { useState } from 'react';
import type { AdCondition, AdRuleDto, AdRuleScope, AdWindow } from '@nvs/shared';
import { ApiError } from '../../shared/http';
import { Hint } from '../../shared/ui/Hint';
import { adsRadarApi } from './ads-radar-api';
import { conditionText } from './AdsRadarPanels';
import { GLOSSARY } from './glossary';

interface Template {
  id: string;
  /** Frase com o número no meio: antes · [valor] · depois. */
  before: string;
  after: string;
  hint: string;
  /** Explicação técnica do termo, no "?" da frase. */
  term?: string;
  scope: AdRuleScope;
  metric: AdCondition['metric'];
  op: AdCondition['op'];
  value: number | null; // null = sem número para escolher
  windows: AdWindow[];
  name: (v: number, w: AdWindow) => string;
}

const WINDOW_SHORT: Partial<Record<AdWindow, string>> = { hoje: 'hoje', '3d': '3 dias', '7d': '7 dias', '14d': '14 dias', '30d': '30 dias', mes: 'o mês atual' };

/** Alertas prontos: o cliente só escolhe o número e a janela. Viram regras comuns (editáveis no fluxo). */
const TEMPLATES: Template[] = [
  {
    id: 'tacos', before: 'Campanhas com TACOS acima de', after: '%', hint: 'Gasto ÷ todas as vendas dos anúncios da campanha. Bom para segurar a margem.', term: GLOSSARY.TACOS,
    scope: 'campanhas', metric: 'tacos', op: 'maior', value: 4, windows: ['7d', '3d', 'hoje', '14d', '30d', 'mes'],
    name: (v, w) => `TACOS acima de ${v.toLocaleString('pt-BR')}% (${WINDOW_SHORT[w]})`,
  },
  {
    id: 'acos', before: 'Campanhas com ACOS acima de', after: '%', hint: 'Gasto ÷ vendas que vieram do anúncio patrocinado.', term: GLOSSARY.ACOS,
    scope: 'campanhas', metric: 'acos', op: 'maior', value: 8, windows: ['7d', '3d', 'hoje', '14d', '30d', 'mes'],
    name: (v, w) => `ACOS acima de ${v.toLocaleString('pt-BR')}% (${WINDOW_SHORT[w]})`,
  },
  {
    id: 'alvo', before: 'Campanhas com ACOS acima do alvo do Mercado Livre', after: '', hint: 'Usa o ACOS objetivo que cada campanha já tem no ML.', term: GLOSSARY.alvo,
    scope: 'campanhas', metric: 'acos_vs_alvo', op: 'maior', value: null, windows: ['7d', '3d', '14d', '30d', 'mes'],
    name: (_v, w) => `ACOS acima do alvo do ML (${WINDOW_SHORT[w]})`,
  },
  {
    id: 'roas', before: 'Campanhas com ROAS abaixo de', after: 'x', hint: 'Quanto volta em vendas para cada R$ 1 investido.', term: GLOSSARY.ROAS,
    scope: 'campanhas', metric: 'roas', op: 'menor', value: 10, windows: ['7d', '3d', '14d', '30d', 'mes'],
    name: (v, w) => `ROAS abaixo de ${v.toLocaleString('pt-BR')}x (${WINDOW_SHORT[w]})`,
  },
  {
    id: 'gasto', before: 'A conta gastou mais de R$', after: '', hint: 'Soma de todas as campanhas no período.',
    scope: 'conta', metric: 'investimento', op: 'maior', value: 1500, windows: ['hoje', '7d', '14d', '30d', 'mes'],
    name: (v, w) => `Gasto da conta acima de R$ ${v.toLocaleString('pt-BR')} (${WINDOW_SHORT[w]})`,
  },
  {
    id: 'sobe', before: 'O gasto de uma campanha subiu mais de', after: '%', hint: 'Compara com o período anterior do mesmo tamanho.',
    scope: 'campanhas', metric: 'investimento', op: 'sobe', value: 30, windows: ['7d', '3d', '14d', '30d', 'mes'],
    name: (v, w) => `Gasto subiu mais de ${v.toLocaleString('pt-BR')}% (${WINDOW_SHORT[w]})`,
  },
];

function TemplateRow({ t, canWrite, onCreated }: { t: Template; canWrite: boolean; onCreated: () => void }) {
  const [value, setValue] = useState(t.value === null ? '' : String(t.value));
  const [win, setWin] = useState<AdWindow>(t.windows[0]!);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const n = t.value === null ? 0 : Number(value.replace(',', '.'));
  const valid = t.value === null || (Number.isFinite(n) && n > 0);

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      await adsRadarApi.createRule({
        name: t.name(n, win), accountId: null, scope: t.scope, campaignId: null, enabled: true, cooldownHours: 24,
        conditions: [{ metric: t.metric, window: win, op: t.op, value: n }],
      });
      setDone(true);
      onCreated();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Não foi possível criar o alerta.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="ara-tpl" data-done={done || undefined}>
      <div className="ara-sentence">
        <span>{t.before}{t.term && <Hint>{t.term}</Hint>}</span>
        {t.value !== null && (
          <input
            inputMode="decimal" value={value} aria-label="Valor do alerta" onChange={(e) => { setValue(e.target.value); setDone(false); }}
            style={{ width: `${Math.max(2, value.length) + 3}ch` }}
          />
        )}
        {t.after && <span>{t.after}</span>}
        <span>em</span>
        <select value={win} onChange={(e) => { setWin(e.target.value as AdWindow); setDone(false); }} aria-label="Período">
          {t.windows.map((w) => <option key={w} value={w}>{WINDOW_SHORT[w]}</option>)}
        </select>
      </div>
      <small>{t.hint}</small>
      {error && <small className="ara-error">{error}</small>}
      {canWrite && (
        <button type="button" className="ar-btn primary" disabled={busy || !valid || done} onClick={create}>
          {done ? 'Alerta ligado ✓' : busy ? 'Criando…' : 'Ligar alerta'}
        </button>
      )}
    </li>
  );
}

/** Configurar alertas: modelos prontos em linguagem simples + os alertas (regras) que já existem. */
export function AlertsPanel({
  rules, unread, canWrite, onChanged, onEdit, onOpenEvents,
}: {
  rules: AdRuleDto[];
  unread: number;
  canWrite: boolean;
  onChanged: () => void;
  onEdit: (r: AdRuleDto) => void;
  onOpenEvents: () => void;
}) {
  return (
    <div className="ara">
      <h2>Alertas</h2>
      <p className="ar-sub">Escolha quando o Radar deve te avisar. Ele confere a cada hora e o aviso aparece aqui no sistema (no máximo 1 por dia para cada campanha).</p>
      <button type="button" className="ara-events" onClick={onOpenEvents} data-tone={unread ? 'estourado' : undefined}>
        <b>{unread}</b> aviso{unread === 1 ? '' : 's'} não lido{unread === 1 ? '' : 's'} <span>Ver avisos →</span>
      </button>

      <h3>Ligar um alerta</h3>
      <ul className="ara-tpls">{TEMPLATES.map((t) => <TemplateRow key={t.id} t={t} canWrite={canWrite} onCreated={onChanged} />)}</ul>

      <h3>Seus alertas ({rules.length})</h3>
      {rules.length ? (
        <ul className="ara-mine">
          {rules.map((r) => (
            <li key={r.id}>
              <button type="button" onClick={() => onEdit(r)}>
                <i data-on={r.enabled || undefined} />
                <span><b>{r.name}</b><small>{r.conditions.map(conditionText).join(' e ')}{r.enabled ? '' : ' · desligado'}</small></span>
                {r.enabled && r.now.estourado > 0 && <em>{r.now.estourado} agora</em>}
                <span className="ara-edit">Editar</span>
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="ar-sub">Nenhum alerta ainda. Ligue um dos modelos acima.</p>}
    </div>
  );
}
