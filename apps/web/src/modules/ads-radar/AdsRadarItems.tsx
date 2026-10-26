import { useEffect, useMemo, useState } from 'react';
import { AD_PRINTS_PER_SALE, type AdCampaignDetailDto, type AdCampaignDto, type AdItemDto } from '@nvs/shared';
import { money } from '../../shared/format';
import { Hint } from '../../shared/ui/Hint';
import { adsRadarApi } from './ads-radar-api';
import { fmtPct, fmtX } from './AdsRadarPanels';
import { GLOSSARY as G } from './glossary';

type Sort = 'saude' | 'gasto' | 'impressoes' | 'vendas';
const n0 = (v: number) => v.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
const n1 = (v: number) => v.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
/** Quanto o anúncio vendeu em relação ao esperado pelas impressões (1 = no ponto). */
const ratio = (i: AdItemDto) => (i.expected > 0 ? i.sold / i.expected : null);

/** Anúncios da campanha com as métricas de cada um e a régua impressões ÷ 300 (vendas esperadas). */
export function ItemsPanel({ campaign, onOpenFlow }: { campaign: AdCampaignDto; onOpenFlow: () => void }) {
  const [days, setDays] = useState<7 | 30>(7);
  const [detail, setDetail] = useState<AdCampaignDetailDto | null>(null);
  const [error, setError] = useState(false);
  const [sort, setSort] = useState<Sort>('saude');

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

  const items = useMemo(() => {
    const list = [...(detail?.items ?? [])];
    const by: Record<Sort, (a: AdItemDto, b: AdItemDto) => number> = {
      // abaixo da régua primeiro (pior proporção antes), depois os bons, sem impressões por último
      saude: (a, b) => (ratio(a) ?? 99) - (ratio(b) ?? 99) || b.prints - a.prints,
      gasto: (a, b) => b.last7.cost - a.last7.cost,
      impressoes: (a, b) => b.prints - a.prints,
      vendas: (a, b) => b.sold - a.sold,
    };
    return list.sort(by[sort]);
  }, [detail, sort]);
  const below = items.filter((i) => i.health === 'abaixo').length;
  const rated = items.filter((i) => i.health !== null).length;

  return (
    <div className="ari">
      <div className="ari-head">
        <div>
          <h2>{campaign.name}</h2>
          <p className="ar-sub">Cada anúncio da campanha com impressões, cliques, vendas e a régua de conversão.</p>
        </div>
        <div className="arh-seg" role="tablist" aria-label="Período">
          {([7, 30] as const).map((d) => <button key={d} type="button" role="tab" aria-selected={days === d} onClick={() => setDays(d)}>{d} dias</button>)}
        </div>
      </div>

      <div className="ari-rule">
        <b>Régua: impressões ÷ {AD_PRINTS_PER_SALE} = vendas esperadas</b>
        <span>Vendeu menos que isso, o anúncio recebe tráfego e não converte: <em data-tone="bad">atenção extrema</em> (revise preço, fotos, título e frete). Vendeu mais: <em data-tone="ok">ótimo</em>.</span>
        {detail && rated > 0 && <strong data-tone={below ? 'bad' : 'ok'}>{below ? `${below} de ${rated} anúncios abaixo da régua` : `Todos os ${rated} anúncios acima da régua`}</strong>}
      </div>

      <div className="ari-tools">
        <select className="arh-select" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Ordenar">
          <option value="saude">Piores primeiro</option><option value="gasto">Maior gasto</option><option value="impressoes">Mais impressões</option><option value="vendas">Mais vendas</option>
        </select>
        <button type="button" className="ar-btn" onClick={onOpenFlow}>Abrir fluxo da campanha →</button>
      </div>

      {error ? <p className="arh-empty">Não foi possível carregar os anúncios.</p>
        : !detail ? <p className="arh-empty">Carregando anúncios…</p>
        : !items.length ? <p className="arh-empty">Nenhum anúncio lido nesta campanha ainda.</p>
        : (
          <div className="ari-list" role="table">
            <div className="ari-row ari-row-head" role="row">
              <span role="columnheader">Anúncio</span>
              <span role="columnheader">Impressões</span>
              <span role="columnheader">Cliques</span>
              <span role="columnheader">Vendas</span>
              <span role="columnheader">Esperado</span>
              <span role="columnheader">Régua</span>
              <span role="columnheader">Gasto</span>
              <span role="columnheader">ACOS<Hint label="ACOS">{G.ACOS}</Hint></span>
            </div>
            {items.map((i) => {
              const ctr = i.prints ? (i.clicks / i.prints) * 100 : null;
              return (
                <div key={i.itemId} className="ari-row" role="row" data-health={i.health ?? undefined}>
                  <span className="ari-item" role="cell">
                    {i.thumbnail ? <img src={i.thumbnail.replace(/^http:/, 'https:')} alt="" loading="lazy" /> : <span className="ari-noimg" />}
                    <span><b title={i.title ?? undefined}>{i.title ?? i.itemId}</b><small>{i.itemId}{i.price !== null ? ` · ${money(i.price)}` : ''}{i.status && i.status !== 'active' ? ' · pausado' : ''}</small></span>
                  </span>
                  <span role="cell" data-label="Impressões">{n0(i.prints)}</span>
                  <span role="cell" data-label="Cliques">{n0(i.clicks)}<small>{ctr === null ? '' : ` · CTR ${n1(ctr)}%`}</small></span>
                  <span role="cell" data-label="Vendas"><b>{n0(i.sold)}</b></span>
                  <span role="cell" data-label="Esperado">{n1(i.expected)}</span>
                  <span role="cell" data-label="Régua">
                    {i.health === null ? <em className="ari-badge">Sem impressões</em>
                      : i.health === 'abaixo' ? <em className="ari-badge" data-tone="bad">Atenção extrema</em>
                      : <em className="ari-badge" data-tone="ok">Ótimo</em>}
                  </span>
                  <span role="cell" data-label="Gasto">{money(i.last7.cost)}<small>{i.last7.roas !== null ? ` · ROAS ${fmtX(i.last7.roas)}` : ''}</small></span>
                  <span role="cell" data-label="ACOS">{fmtPct(i.last7.acos)}</span>
                </div>
              );
            })}
          </div>
        )}
    </div>
  );
}
