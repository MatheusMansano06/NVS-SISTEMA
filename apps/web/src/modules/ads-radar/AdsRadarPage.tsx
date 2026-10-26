import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AdCampaignDetailDto, AdCampaignDto, AdEventDto, AdRuleDto, AdStatus, AdsRadarOverviewDto } from '@nvs/shared';
import { AppShell } from '../../app/AppShell';
import { change, money } from '../../shared/format';
import { ApiError } from '../../shared/http';
import { Icon } from '../../shared/ui/Icon';
import { Modal } from '../../shared/ui/Modal';
import { useAuth } from '../auth/AuthContext';
import { adsRadarApi } from './ads-radar-api';
import { AlertsPanel } from './AdsRadarAlerts';
import { AdsRadarHome } from './AdsRadarHome';
import { useGuidedTour } from '../../shared/tour/Tour';
import { TOURS } from '../../shared/tour/tours';
import {
  CampaignDrawer, CampaignPanel, EventsPanel, GoalsPanel, OverviewPanel, RobotPanel, RuleEditor, SCOPE_LABEL, STATUS_LABEL, TONE_COLOR,
  conditionText, fmtPct, fmtX, ruleTone, type RuleDraftPreset,
} from './AdsRadarPanels';
import { FlowCanvas, type FlowEdge, type FlowNode } from './FlowCanvas';
import './ads-radar.css';

type Panel =
  | { kind: 'rule'; rule: AdRuleDto | null; preset: RuleDraftPreset }
  | { kind: 'goals' | 'events' | 'overview' | 'robot' | 'campaign' | 'alerts' };

const ACCOUNT_MSG: Record<string, string> = {
  sem_conta: 'Conecte a conta do Mercado Livre em Integrações para o Radar ADS começar a ler as campanhas.',
  sem_anunciante: 'Esta conta ainda não anuncia no Mercado Ads.',
  sem_permissao: 'O Mercado Livre não liberou a leitura de publicidade para esta conta. Reconecte a conta em Integrações.',
  erro: 'A última leitura do Mercado Ads falhou. O sistema tenta de novo na próxima hora.',
};

function Kind({ icon, bg, fg, children }: { icon: string; bg: string; fg: string; children: string }) {
  return <div className="ar-node-kind"><i style={{ background: bg, color: fg }}>{icon}</i>{children}</div>;
}

/** Bloco de regra. Dentro de uma campanha (`only`), a situação mostrada é a dela, não a soma da conta. */
function ruleNode(r: AdRuleDto, x: number, y: number, onOpen: () => void, only?: AdStatus): FlowNode {
  const tone = only ?? ruleTone(r);
  const n = r.now.estourado;
  const badge: FlowNode['badge'] = !r.enabled ? { text: 'Desligada', tone: 'info' }
    : only ? (only === 'ok' ? null : { text: only === 'estourado' ? 'Estourado' : 'Perto do limite', tone: only })
    : n ? { text: r.scope === 'campanhas' ? `${n} estourada${n > 1 ? 's' : ''}` : 'Estourada', tone: 'estourado' } : null;
  return {
    id: `rule-${r.id}`, x, y, label: `Regra ${r.name}`, tone: !r.enabled || tone === 'ok' ? null : tone, onOpen, badge,
    children: (
      <>
        <Kind icon="◇" bg="var(--yellow-soft)" fg="var(--warn-ink)">{SCOPE_LABEL[r.scope]}</Kind>
        <div className="ar-node-title">{r.name}</div>
        <div className="ar-node-sub">{r.conditions.map(conditionText).join(' e ')}</div>
        {r.enabled && r.scope !== 'conta' && !only && (
          <>
            {r.now.estourado > 0 && <span className="ar-chip" data-tone="estourado">{r.now.estourado} acima</span>}
            {r.now.atencao > 0 && <span className="ar-chip" data-tone="atencao">{r.now.atencao} perto</span>}
            <span className="ar-chip" data-tone="ok">{r.now.ok} ok</span>
          </>
        )}
      </>
    ),
  };
}

/** Radar ADS: abre na tela inicial (resumo + campanhas); clique numa campanha abre o fluxo dela, e o fluxo geral vale para a conta toda. */
export function AdsRadarPage() {
  const { session } = useAuth();
  const canWrite = session?.user.role !== 'viewer';
  const [overview, setOverview] = useState<AdsRadarOverviewDto | null>(null);
  const [campaigns, setCampaigns] = useState<AdCampaignDto[]>([]);
  const [events, setEvents] = useState<AdEventDto[]>([]);
  const [view, setView] = useState<'inicio' | 'geral'>('inicio');
  const [selected, setSelected] = useState<AdCampaignDto | null>(null);
  const [detail, setDetail] = useState<AdCampaignDetailDto | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [filter, setFilter] = useState<AdStatus | 'all'>('all');
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [o, c] = await Promise.all([adsRadarApi.overview(), adsRadarApi.campaigns()]);
      setOverview(o);
      setCampaigns(c);
      setError('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Não foi possível carregar o Radar ADS.');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const loadDetail = useCallback(async (c: AdCampaignDto) => {
    setDetail(await adsRadarApi.campaign(c.accountId, c.campaignId).catch(() => null));
  }, []);
  useEffect(() => {
    setDetail(null);
    if (selected) void loadDetail(selected);
  }, [selected, loadDetail]);

  // ⌘K / Ctrl+K abre a gaveta de campanhas; Esc fecha
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setFilter('all');
        setDrawer(true);
      } else if (e.key === 'Escape') setDrawer(false);
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, []);

  const openDrawer = (f: AdStatus | 'all') => {
    setFilter(f);
    setDrawer(true);
  };
  const pick = (c: AdCampaignDto) => {
    setDrawer(false);
    setPanel(null);
    setSelected(c);
  };
  const goHome = () => {
    setSelected(null);
    setView('inicio');
  };
  const home = !selected && view === 'inicio';
  const tour = useGuidedTour('radar-ads', TOURS['radar-ads'], home && !!overview && campaigns.length > 0);
  const openEvents = async () => {
    setEvents(await adsRadarApi.events(50).catch(() => []));
    setPanel({ kind: 'events' });
  };
  const newRule = (preset: RuleDraftPreset) => setPanel({ kind: 'rule', rule: null, preset });
  const editRule = (r: AdRuleDto) => setPanel({ kind: 'rule', rule: r, preset: { scope: r.scope, campaignId: r.campaignId, accountId: r.accountId } });
  const afterChange = async () => {
    await load();
    if (selected) await loadDetail(selected);
  };
  const sync = async () => {
    setSyncing(true);
    try {
      await adsRadarApi.sync();
      setTimeout(() => {
        void afterChange();
        setSyncing(false);
      }, 20_000);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Não foi possível atualizar agora.');
      setSyncing(false);
    }
  };

  // ---------------------------------------------------------------- fluxo da conta
  const accountFlow = useMemo((): { nodes: FlowNode[]; edges: FlowEdge[] } => {
    if (!overview) return { nodes: [], edges: [] };
    const active = campaigns.filter((c) => c.mlStatus === 'active');
    const rules = overview.rules.filter((r) => r.scope !== 'campanha');
    const goals = overview.goals;
    const nodes: FlowNode[] = [];
    const edges: FlowEdge[] = [];
    nodes.push({
      id: 'trg', x: 0, y: 250, label: 'Gatilho: a cada 1 hora', onOpen: () => setPanel({ kind: 'robot' }),
      children: (<><Kind icon="⏱" bg="var(--purple-soft)" fg="#7c5cff">Gatilho</Kind><div className="ar-node-title">A cada 1 hora</div><div className="ar-node-sub">Lê o Mercado Ads e avalia as regras</div></>),
    });
    const tacosGoal = goals.find((g) => g.kind === 'tacos');
    nodes.push({
      id: 'acc', x: 300, y: 250, label: 'Conta: abrir visão geral', onOpen: () => setPanel({ kind: 'overview' }),
      children: (
        <>
          <Kind icon="◎" bg="var(--blue-soft)" fg="var(--blue-deep)">Conta</Kind>
          <div className="ar-node-title">Mercado Livre</div>
          <div className="ar-node-sub">{active.length} campanhas ativas</div>
          <span className="ar-chip" data-tone={tacosGoal?.status}>TACOS {fmtPct(overview.last7.tacos)}</span>
          <span className="ar-chip">{money(overview.last7.cost)} em 7d</span>
          <div className="ar-node-open">Ver visão geral →</div>
        </>
      ),
    });
    edges.push({ from: 'trg', to: 'acc' });

    // coluna do meio: metas e regras
    let y = 20;
    if (goals.length) {
      const g = goals.find((x) => x.kind === 'gasto_mes') ?? goals[0]!;
      nodes.push({
        id: 'goal', x: 620, y, label: 'Metas de investimento', tone: g.status === 'ok' ? null : g.status, onOpen: () => setPanel({ kind: 'goals' }),
        badge: g.status === 'estourado' ? { text: 'Acima do ritmo', tone: 'estourado' } : null,
        children: (
          <>
            <Kind icon="◔" bg="var(--yellow-soft)" fg="var(--warn-ink)">Metas</Kind>
            {g.kind === 'tacos' ? (
              <div className="ar-node-title">TACOS do mês {fmtPct(g.current)} · objetivo {fmtPct(g.target)}</div>
            ) : (
              <>
                <div className="ar-node-title">{g.kind === 'gasto_mes' ? 'Mês' : 'Ano'}: {money(g.target)}</div>
                <div className="ar-track"><span className="proj" style={{ width: `${Math.min(100, (g.pace!.projected / g.target) * 100)}%` }} /><span className="fill" style={{ width: `${Math.min(100, ((g.current ?? 0) / g.target) * 100)}%` }} /><span className="mark" style={{ left: `${g.pace!.elapsed * 100}%` }} /></div>
                <div className="ar-node-sub">Gasto {money(g.current ?? 0)} · fecha em ~{money(g.pace!.projected)}</div>
              </>
            )}
            {goals.length > 1 && <div className="ar-node-open">+ {goals.length - 1} meta{goals.length > 2 ? 's' : ''} →</div>}
          </>
        ),
      });
      edges.push({ from: 'acc', to: 'goal' });
      if (g.status === 'estourado') edges.push({ from: 'goal', to: 'ntf', label: 'sim', hot: true });
      y += 200;
    }
    for (const r of rules) {
      nodes.push(ruleNode(r, 620, y, () => editRule(r)));
      edges.push({ from: 'acc', to: `rule-${r.id}` });
      if (r.enabled) edges.push({ from: `rule-${r.id}`, to: r.scope === 'conta' ? 'ntf' : 'g-estourado', label: 'sim', hot: r.now.estourado > 0 });
      y += 175;
    }
    // só aparece o que a empresa criou: sem regra nem meta, o fluxo fica em Gatilho → Conta
    if (!rules.length && !goals.length) return { nodes, edges };

    // campanhas por situação (só quando alguma regra olha campanhas)
    const campaignRules = rules.some((r) => r.scope !== 'conta');
    const groups: { s: AdStatus; y: number; sub: string }[] = [
      { s: 'estourado', y: 40, sub: 'acima do limite' }, { s: 'atencao', y: 260, sub: 'perto do limite (85%+)' }, { s: 'ok', y: 470, sub: 'dentro do limite' },
    ];
    for (const g of campaignRules ? groups : []) {
      const list = active.filter((c) => c.status === g.s);
      nodes.push({
        id: `g-${g.s}`, x: 960, y: g.y, stack: true, label: `${STATUS_LABEL[g.s]}: ${list.length} campanhas`, onOpen: () => openDrawer(g.s),
        children: (
          <>
            <Kind icon={g.s === 'estourado' ? '!' : g.s === 'atencao' ? '~' : '✓'} bg={`color-mix(in srgb, ${TONE_COLOR[g.s]} 16%, transparent)`} fg={TONE_COLOR[g.s]}>{STATUS_LABEL[g.s]}</Kind>
            <div className="ar-node-big" style={{ color: TONE_COLOR[g.s] }}>{list.length}</div>
            <div className="ar-node-sub">{g.sub}</div>
            <div className="ar-dots">{list.slice(0, 40).map((c) => <span key={c.campaignId} title={c.name} style={{ background: TONE_COLOR[g.s] }} />)}</div>
            <div className="ar-node-open">Ver campanhas →</div>
          </>
        ),
      });
    }
    if (campaignRules) edges.push({ from: 'g-estourado', to: 'ntf', label: 'sim', hot: overview.campaigns.estourado > 0 });

    nodes.push({
      id: 'ntf', x: 1300, y: 60, label: `Avisos: ${overview.unread} não lidos`, onOpen: openEvents,
      badge: overview.unread ? { text: `${overview.unread} novo${overview.unread > 1 ? 's' : ''}`, tone: 'estourado' } : null,
      children: (<><Kind icon="🔔" bg="var(--ok-soft)" fg="var(--ok-ink)">Avisar</Kind><div className="ar-node-title">No sistema</div><div className="ar-node-sub">WhatsApp e e-mail chegam depois</div><div className="ar-node-open">Ver alertas →</div></>),
    });
    return { nodes, edges };
  }, [overview, campaigns]);

  // ---------------------------------------------------------------- fluxo de uma campanha
  const campaignFlow = useMemo((): { nodes: FlowNode[]; edges: FlowEdge[] } => {
    if (!selected) return { nodes: [], edges: [] };
    const c = detail?.campaign ?? selected;
    const rules = detail?.rules ?? [];
    const nodes: FlowNode[] = [];
    const edges: FlowEdge[] = [];
    const vals = (detail?.series ?? []).map((d) => d.acos ?? 0);
    const max = Math.max(...vals, 0.01);
    nodes.push({
      id: 'trg', x: 0, y: 220, label: 'Gatilho: a cada 1 hora',
      children: (<><Kind icon="⏱" bg="var(--purple-soft)" fg="#7c5cff">Gatilho</Kind><div className="ar-node-title">A cada 1 hora</div><div className="ar-node-sub">Herdado da conta</div></>),
    });
    nodes.push({
      id: 'cmp', x: 300, y: 220, label: `Campanha ${c.name}: ver detalhes`, tone: c.status === 'ok' ? null : c.status, onOpen: () => setPanel({ kind: 'campaign' }),
      children: (
        <>
          <Kind icon="◎" bg="var(--blue-soft)" fg="var(--blue-deep)">Campanha</Kind>
          <div className="ar-node-title">{c.name}</div>
          <div className="ar-node-sub">Alvo de ACOS {fmtPct(c.acosTarget)}{c.budget !== null ? ` · orçamento ${money(c.budget)}` : ''}</div>
          <span className="ar-chip" data-tone={c.status}>ACOS {fmtPct(c.last7.acos)}</span>
          <span className="ar-chip">TACOS {fmtPct(c.last7.tacos)}</span>
          <span className="ar-chip">{money(c.last7.cost)} em 7d</span>
          {vals.length > 1 && (
            <svg viewBox={`0 0 ${(vals.length - 1) * 10} 30`} preserveAspectRatio="none" style={{ width: '100%', height: 30, marginTop: 8 }} aria-hidden="true">
              <polyline points={vals.map((v, i) => `${i * 10},${28 - (v / max) * 26}`).join(' ')} fill="none" stroke={TONE_COLOR[c.status]} strokeWidth="2" vectorEffect="non-scaling-stroke" />
            </svg>
          )}
          <div className="ar-node-open">Anúncios e histórico →</div>
        </>
      ),
    });
    edges.push({ from: 'trg', to: 'cmp' });
    let y = 40;
    for (const r of rules) {
      nodes.push(ruleNode(r, 610, y, () => editRule(r), c.status));
      const hot = r.enabled && c.status === 'estourado';
      edges.push(
        { from: 'cmp', to: `rule-${r.id}` }, { from: `rule-${r.id}`, to: 'ntf', label: 'sim', hot },
        { from: `rule-${r.id}`, to: 'reg', label: 'não' },
      );
      y += 175;
    }
    if (!rules.length) return { nodes, edges };
    const evs = detail?.events ?? [];
    nodes.push({
      id: 'ntf', x: 930, y: 40, label: 'Avisos desta campanha', onOpen: openEvents,
      badge: evs.some((e) => !e.read) ? { text: 'Novo', tone: 'estourado' } : null,
      children: (<><Kind icon="🔔" bg="var(--ok-soft)" fg="var(--ok-ink)">Avisar</Kind><div className="ar-node-title">No sistema</div><div className="ar-node-sub">{evs.length ? `${evs.length} alerta${evs.length > 1 ? 's' : ''} desta campanha` : 'Nenhum alerta ainda'}</div></>),
    });
    nodes.push({
      id: 'reg', x: 930, y: 250, label: 'Senão: só registra',
      children: (<><Kind icon="✓" bg="var(--gray-100)" fg="var(--gray-500)">Senão</Kind><div className="ar-node-title">Só registra no histórico</div><div className="ar-node-sub">Os números ficam guardados para a simulação</div></>),
    });
    return { nodes, edges };
  }, [selected, detail]);

  const flow = selected ? campaignFlow : accountFlow;
  const flowKey = selected ? `c:${selected.accountId}:${selected.campaignId}` : 'conta';
  const o = overview;
  const costDelta = o ? change(o.last7.cost, o.prev7.cost) : null;
  const monthGoal = o?.goals.find((g) => g.kind === 'gasto_mes');
  const tacosGoal = o?.goals.find((g) => g.kind === 'tacos');
  const banner = o && (o.account.status !== 'ok' ? { tone: o.account.status === 'erro' || o.account.status === 'sem_permissao' ? 'erro' : undefined, text: ACCOUNT_MSG[o.account.status] }
    : o.account.error ? { tone: 'erro', text: `O Mercado Livre recusou a leitura das métricas: ${o.account.error}` }
    : !o.account.backfilled ? { tone: undefined, text: 'Primeira leitura em andamento: o Radar está trazendo os últimos 90 dias do Mercado Ads. Os números aparecem em alguns minutos.' } : null);

  const closePanel = () => setPanel(null);
  return (
    <AppShell>
      <div className="ar" data-view={home ? 'inicio' : 'fluxo'}>
        <header className="ar-head">
          <div className="ar-brand">
            <span className="ar-brand-ico"><Icon name="target" /></span>
            <div><b>Radar ADS</b><small>{selected ? selected.name : !home ? 'Fluxo geral da conta' : o ? `${o.campaigns.total} campanhas ativas · últimos 7 dias` : 'Mercado Ads'}</small></div>
          </div>
          {o && !home && (
            <div className="ar-kpis">
              <button type="button" className="ar-kpi" onClick={() => setPanel({ kind: 'overview' })}>
                Investimento 7d<b>{money(o.last7.cost)}{costDelta !== null && <small style={{ color: costDelta > 0 ? 'var(--danger)' : 'var(--ok)' }}>{costDelta > 0 ? '▲' : '▼'} {Math.abs(Math.round(costDelta * 100))}%</small>}</b>
              </button>
              <button type="button" className="ar-kpi" data-tone={tacosGoal?.status} onClick={() => setPanel({ kind: 'goals' })}>TACOS 7d<b>{fmtPct(o.last7.tacos)}</b></button>
              <button type="button" className="ar-kpi" onClick={() => setPanel({ kind: 'overview' })}>ACOS · ROAS<b>{fmtPct(o.last7.acos)} · {fmtX(o.last7.roas)}</b></button>
              {monthGoal && (
                <button type="button" className="ar-kpi" data-tone={monthGoal.status} onClick={() => setPanel({ kind: 'goals' })}>Meta do mês<b>{money(monthGoal.current ?? 0)} / {money(monthGoal.target)}</b></button>
              )}
              <button type="button" className="ar-kpi" data-tone={o.unread ? 'estourado' : undefined} onClick={openEvents}>Alertas<b>{o.unread}</b></button>
            </div>
          )}
          <button type="button" className="link ar-tour" onClick={tour.start}>Rever com a Gertrudez</button>
          <div className="ar-spacer" />
          {!home && <button type="button" className="ar-btn" onClick={() => openDrawer('all')}>Campanhas <kbd>⌘K</kbd></button>}
          {home && <button type="button" className="ar-btn" onClick={() => setView('geral')}>Fluxo geral</button>}
          {canWrite && <button type="button" className="ar-btn" disabled={syncing} onClick={sync}><Icon name="refresh" size={16} />{syncing ? 'Atualizando…' : 'Atualizar'}</button>}
          {canWrite && !selected && <button type="button" className="ar-btn" onClick={() => setPanel({ kind: 'goals' })}>+ Meta</button>}
          {canWrite && !home && <button type="button" className="ar-btn primary" onClick={() => newRule(selected ? { scope: 'campanha', campaignId: selected.campaignId, accountId: selected.accountId } : { scope: 'campanhas', campaignId: null, accountId: null })}>+ Regra</button>}
        </header>

        {error ? <p className="ar-banner" data-tone="erro" role="alert">{error}</p> : banner ? <p className="ar-banner" data-tone={banner.tone}>{banner.text}</p> : <div />}

        {home ? (
          o ? (
            <AdsRadarHome
              overview={o} campaigns={campaigns} onOpenCampaign={pick} onOpenGeneral={() => setView('geral')}
              onOpenGoals={() => setPanel({ kind: 'goals' })} onOpenAlerts={() => setPanel({ kind: 'alerts' })}
            />
          ) : !error && <div className="arh-empty">Carregando o Radar…</div>
        ) : (
        <FlowCanvas nodes={flow.nodes} edges={flow.edges} flowKey={flowKey}>
          <div className="ar-crumb">
            <button type="button" className="ar-btn" onClick={goHome}>Início</button>
            {selected ? (
              <><button type="button" className="ar-btn" onClick={() => { setSelected(null); setView('geral'); }}>Fluxo geral</button><span>{selected.name}</span></>
            ) : <span>Fluxo geral</span>}
          </div>
          <div className="ar-hint">Arraste o fundo · roda do mouse dá zoom · clique em qualquer bloco</div>
          {!o && !error && <div className="ar-empty">Carregando o Radar…</div>}
          <CampaignDrawer
            open={drawer} campaigns={campaigns} filter={filter} onFilter={setFilter}
            selected={selected ? `${selected.accountId}:${selected.campaignId}` : null} onPick={pick} onClose={() => setDrawer(false)}
          />
          {flow.nodes.length <= 2 && o && (
            <div className="ar-start">
              <b>{selected ? 'Esta campanha ainda não tem regra' : 'Nenhuma regra geral ainda'}</b>
              <p>{selected ? 'Crie uma regra e o Radar passa a vigiar esta campanha a cada hora.' : 'Regras gerais valem para todas as campanhas. Metas controlam o gasto do mês.'}</p>
              {canWrite && (
                <div>
                  <button type="button" className="ar-btn primary" onClick={() => newRule(selected ? { scope: 'campanha', campaignId: selected.campaignId, accountId: selected.accountId } : { scope: 'campanhas', campaignId: null, accountId: null })}>+ Criar regra</button>
                  {!selected && <button type="button" className="ar-btn" onClick={() => setPanel({ kind: 'goals' })}>+ Meta de gasto</button>}
                </div>
              )}
            </div>
          )}
        </FlowCanvas>
        )}
      </div>

      <Modal open={panel?.kind === 'rule'} onClose={closePanel} label="Regra" wide>
        {panel?.kind === 'rule' && (
          <RuleEditor
            key={panel.rule?.id ?? 'nova'} rule={panel.rule} preset={panel.preset} campaigns={campaigns} canWrite={canWrite}
            onDone={(changed) => { closePanel(); if (changed) void afterChange(); }}
          />
        )}
      </Modal>
      <Modal open={panel?.kind === 'alerts'} onClose={closePanel} label="Alertas" wide>
        {o && (
          <AlertsPanel
            rules={o.rules} unread={o.unread} canWrite={canWrite} onChanged={() => void load()}
            onEdit={editRule} onOpenEvents={openEvents}
          />
        )}
      </Modal>
      <Modal open={panel?.kind === 'goals'} onClose={closePanel} label="Metas" wide>
        {o && <GoalsPanel goals={o.goals} today={o.today} canWrite={canWrite} onChanged={() => void load()} />}
      </Modal>
      <Modal open={panel?.kind === 'events'} onClose={closePanel} label="Alertas">
        <EventsPanel
          events={events}
          onOpenCampaign={(e) => {
            const c = campaigns.find((x) => x.campaignId === e.campaignId && (e.accountId === null || x.accountId === e.accountId));
            if (c) pick(c);
            else closePanel();
          }}
          onReadAll={async () => { await adsRadarApi.markRead(); setEvents((es) => es.map((e) => ({ ...e, read: true }))); void load(); }}
        />
      </Modal>
      <Modal open={panel?.kind === 'overview'} onClose={closePanel} label="Visão geral" wide>
        {o && <OverviewPanel overview={o} campaigns={campaigns} onPick={pick} />}
      </Modal>
      <Modal open={panel?.kind === 'robot'} onClose={closePanel} label="Robô"><RobotPanel /></Modal>
      <Modal open={panel?.kind === 'campaign'} onClose={closePanel} label="Campanha" wide>
        {detail ? <CampaignPanel detail={detail} /> : <p className="ar-sub">Carregando…</p>}
      </Modal>
      {tour.element}
    </AppShell>
  );
}
