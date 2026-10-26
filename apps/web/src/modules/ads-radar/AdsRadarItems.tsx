import { useEffect, useMemo, useState } from 'react';
import { AD_PRINTS_PER_CLICK, type AdCampaignDetailDto, type AdCampaignDto, type AdItemDto } from '@nvs/shared';
import { money } from '../../shared/format';
import { Hint } from '../../shared/ui/Hint';
import { adsRadarApi } from './ads-radar-api';

type Sort = 'piores' | 'impressoes' | 'cliques';
const n0 = (v: number) => v.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
const n1 = (v: number) => v.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
const n2 = (v: number) => v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Cliques reais ÷ cliques esperados pelas impressões (1 = no ponto). */
const ratio = (i: AdItemDto) => (i.expected > 0 ? i.clicks / i.expected : null);

const RULE_HINT =
  `Impressões ÷ ${AD_PRINTS_PER_CLICK}: quantos cliques o anúncio deveria ter. Se teve menos cliques que isso (CTR abaixo de 0,33%), ` +
  'ele aparece e ninguém clica — ponto de atenção: revise foto principal, título e preço. Se teve mais, está ótimo.';

/** Anúncios da campanha: impressões, cliques, CTR e impressões ÷ 300 (a régua aparece só na cor e no "?"). */
export function ItemsPanel({ campaign, onOpenFlow }: { campaign: AdCampaignDto; onOpenFlow: () => void }) {
  const [days, setDays] = useState<7 | 30>(7);
  const [detail, setDetail] = useState<AdCampaignDetailDto | null>(null);
  const [error, setError] = useState(false);
  const [sort, setSort] = useState<Sort>('piores');
  const [onlyBad, setOnlyBad] = useState(false);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setError(false);
    adsRadarApi.campaign(campaign.accountId, campaign.campaignId, days).then(
      (d) => alive && setDetail(d),
      () => alive && setError(true),
    );
    return () => {
      alive = false;
    };
  }, [campaign.accountId, campaign.campaignId, days]);

  const all = detail?.items ?? [];
  const bad = all.filter((i) => i.health === 'abaixo').length;
  const items = useMemo(() => {
    const by: Record<Sort, (a: AdItemDto, b: AdItemDto) => number> = {
      // pior proporção antes; sem impressões por último
      piores: (a, b) => (ratio(a) ?? 99) - (ratio(b) ?? 99) || b.prints - a.prints,
      impressoes: (a, b) => b.prints - a.prints,
      cliques: (a, b) => b.clicks - a.clicks,
    };
    return all.filter((i) => !onlyBad || i.health === 'abaixo').sort(by[sort]);
  }, [all, sort, onlyBad]);

  return (
    <div className="ari">
      <div className="ari-head">
        <div>
          <h2>{campaign.name}</h2>
          <p>{all.length || campaign.items} anúncio{(all.length || campaign.items) === 1 ? '' : 's'} na campanha</p>
        </div>
        <div className="arh-seg" role="tablist" aria-label="Período">
          {([7, 30] as const).map((d) => <button key={d} type="button" role="tab" aria-selected={days === d} onClick={() => setDays(d)}>{d} dias</button>)}
        </div>
      </div>

      <div className="ari-tools">
        <select className="arh-select" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Ordenar">
          <option value="piores">Menos cliques primeiro</option><option value="impressoes">Mais impressões</option><option value="cliques">Mais cliques</option>
        </select>
        {bad > 0 && (
          <button type="button" className="ari-chip" aria-pressed={onlyBad} onClick={() => setOnlyBad((v) => !v)}>
            <i /> {bad} com poucos cliques
          </button>
        )}
        <button type="button" className="ar-btn ari-flow" onClick={onOpenFlow}>Fluxo da campanha →</button>
      </div>

      {error ? <p className="arh-empty">Não foi possível carregar os anúncios.</p>
        : !detail ? <p className="arh-empty">Carregando anúncios…</p>
        : !items.length ? <p className="arh-empty">{all.length ? 'Nenhum anúncio neste filtro.' : 'Nenhum anúncio lido nesta campanha ainda.'}</p>
        : (
          <ul className="ari-list">
            <li className="ari-cols" aria-hidden="true">
              <span />
              <span>Impressões</span><span>Cliques</span><span>CTR</span>
              <span>Impr. ÷ {AD_PRINTS_PER_CLICK}<Hint label={`impressões ÷ ${AD_PRINTS_PER_CLICK}`}>{RULE_HINT}</Hint></span>
            </li>
            {items.map((i) => {
              const ctr = i.prints ? (i.clicks / i.prints) * 100 : null;
              return (
                <li key={i.itemId} className="ari-row" data-health={i.health ?? undefined}>
                  <div className="ari-item">
                    {i.thumbnail ? <img src={i.thumbnail.replace(/^http:/, 'https:')} alt="" loading="lazy" /> : <span className="ari-noimg" />}
                    <span>
                      <b title={i.title ?? undefined}>{i.title ?? i.itemId}</b>
                      <small>{i.itemId}{i.price !== null ? ` · ${money(i.price)}` : ''}{i.status && i.status !== 'active' ? ' · pausado' : ''}</small>
                    </span>
                  </div>
                  <div className="ari-m"><small>Impressões</small><b>{n0(i.prints)}</b></div>
                  <div className="ari-m"><small>Cliques</small><b>{n0(i.clicks)}</b></div>
                  <div className="ari-m"><small>CTR</small><b>{ctr === null ? '—' : `${n2(ctr)}%`}</b></div>
                  <div
                    className="ari-m ari-rule-v" data-tone={i.health === 'abaixo' ? 'bad' : i.health === 'ok' ? 'ok' : undefined}
                    title={i.health === null ? 'Sem impressões no período' : `${n0(i.clicks)} cliques para ${n1(i.expected)} esperados`}
                  >
                    <small>Impr. ÷ {AD_PRINTS_PER_CLICK}</small><b>{i.prints ? n1(i.expected) : '—'}</b>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
    </div>
  );
}
