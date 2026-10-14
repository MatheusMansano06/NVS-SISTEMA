import { useCallback, useEffect, useState } from 'react';
import {
  MARKETING_TOOL_INFO,
  PROMOTION_TYPE_LABEL,
  type MarketingAccountDto,
  type MarketingDto,
  type MarketingListingDto,
  type MarketingTool,
  type MarketingToolStat,
} from '@nvs/shared';
import { AppShell } from '../../app/AppShell';
import { int, money, pct } from '../../shared/format';
import { ApiError } from '../../shared/http';
import { Icon } from '../../shared/ui/Icon';
import { Modal } from '../../shared/ui/Modal';
import { useAuth } from '../auth/AuthContext';
import { ProductThumb } from '../dashboard/components/ProductThumb';
import { HowTo, ListingsNav } from './ListingsNav';
import { listingsApi } from './listings-api';
import '../skus/skus.css';
import './listings.css';
import './marketing.css';

const STEPS = [
  { title: 'Raio-X dos anúncios', text: 'O sistema lê no Mercado Livre, aos poucos, o que cada anúncio ativo usa (atacado, clips, cupom, ofertas, Ads…) e guarda a análise. Relê toda semana ou quando você pede.' },
  { title: 'Veja o que falta', text: 'Cada quadro mostra quantos anúncios usam e quantos não usam a ferramenta. “Elegíveis” são os que o ML já aceita na ferramenta.' },
  { title: 'Abra a lista', text: 'Clique em “Ver quem não usa” para a lista de anúncios e aplique pelo Mercado Livre ou pela Central de Promoção.' },
];

const CAMPAIGN_LABEL: Record<string, string> = { ...PROMOTION_TYPE_LABEL, SELLER_COUPON_CAMPAIGN: 'Cupom do vendedor' };
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

/** Central de Marketing: quanto dos anúncios ativos usa cada ferramenta do ML, por conta. */
export function MarketingPage() {
  const { session } = useAuth();
  const canManage = session?.user.role !== 'viewer';
  const [data, setData] = useState<MarketingDto | null>(null);
  const [error, setError] = useState('');
  const [accountId, setAccountId] = useState<string | null>(null);
  const [open, setOpen] = useState<{ tool: MarketingTool; using: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await listingsApi.marketing();
      setData(r);
      setError('');
      setAccountId((cur) => (cur && r.accounts.some((a) => a.connectionId === cur) ? cur : (r.accounts[0]?.connectionId ?? null)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível carregar a Central de Marketing.');
    }
  }, []);
  useEffect(() => void load(), [load]);
  // enquanto analisa, a tela acompanha
  useEffect(() => {
    if (!data?.scanning) return;
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [data?.scanning, load]);

  const analyze = async () => {
    await listingsApi.marketingRefresh().catch(() => undefined);
    setData((d) => (d ? { ...d, scanning: true } : d));
    setTimeout(() => void load(), 1500);
  };

  const acc = data?.accounts.find((a) => a.connectionId === accountId) ?? null;
  const available = acc?.tools.filter((t) => t.available) ?? [];
  const missing = acc?.tools.filter((t) => !t.available) ?? [];

  return (
    <AppShell>
      <div className="skus listings mkt">
        <header className="skus-head">
          <div>
            <p className="dash-kicker">Mercado Livre</p>
            <h1>Central de Marketing</h1>
          </div>
          {canManage && (
            <button type="button" className="act" onClick={() => void analyze()} disabled={data?.scanning}>
              <Icon name="refresh" size={14} /> {data?.scanning ? 'Analisando…' : 'Analisar agora'}
            </button>
          )}
        </header>
        <ListingsNav />
        <HowTo steps={STEPS} storageKey="nvs:howto:marketing" />

        {error && <p className="banner banner-error" role="alert">{error}</p>}
        {data && !data.accounts.length && <p className="banner banner-error">Conecte uma conta do Mercado Livre para ver a Central de Marketing.</p>}
        {!data && !error && <div className="mkt-grid">{[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="mkt-card skeleton" />)}</div>}

        {data && data.accounts.length > 1 && (
          <nav className="seg mkt-accounts" aria-label="Conta do Mercado Livre">
            {data.accounts.map((a) => (
              <button key={a.connectionId} type="button" role="tab" aria-checked={a.connectionId === accountId} onClick={() => setAccountId(a.connectionId)}>
                {a.nickname}
              </button>
            ))}
          </nav>
        )}

        {acc && (
          <>
            <Coverage acc={acc} scanning={data!.scanning} />

            {acc.analyzed > 0 && (
              <div className="mkt-grid">
                {available.map((t) => (
                  <ToolCard key={t.tool} stat={t} onOpen={(using) => setOpen({ tool: t.tool, using })} />
                ))}
              </div>
            )}

            <section className="mkt-panel" aria-label="Campanhas abertas para a conta">
              <h2>Campanhas que o Mercado Livre oferece a esta conta agora</h2>
              {acc.openCampaigns.length ? (
                <ul className="mkt-chips">
                  {acc.openCampaigns.map((c) => (
                    <li key={c.type}>{CAMPAIGN_LABEL[c.type] ?? c.type} <b>{c.count}</b></li>
                  ))}
                </ul>
              ) : (
                <p className="mkt-muted">Nenhuma campanha aberta para esta conta no momento.</p>
              )}
              <p className="mkt-muted">Para inscrever anúncios nessas campanhas, use a Central de Promoção.</p>
            </section>

            {acc.analyzed > 0 && missing.length > 0 && (
              <section className="mkt-panel mkt-off" aria-label="Ferramentas sem leitura">
                <h2>Sem leitura nesta conta</h2>
                <p className="mkt-muted">
                  O Mercado Livre não informou estas ferramentas para esta conta. Cada conta tem ferramentas diferentes: elas podem não estar
                  liberadas, ou o ML não as disponibiliza pela integração.
                </p>
                <ul className="mkt-chips">
                  {missing.map((t) => <li key={t.tool}>{MARKETING_TOOL_INFO[t.tool].label}</li>)}
                </ul>
              </section>
            )}
          </>
        )}
      </div>

      {open && acc && <ToolListing acc={acc} tool={open.tool} using={open.using} onClose={() => setOpen(null)} />}
    </AppShell>
  );
}

function Coverage({ acc, scanning }: { acc: MarketingAccountDto; scanning: boolean }) {
  const ratio = acc.activeListings ? Math.max(0, Math.min(1, (acc.activeListings - acc.pending) / acc.activeListings)) : 0;
  return (
    <section className="mkt-cover" aria-label="Análise dos anúncios">
      <div>
        <strong>{int(acc.analyzed)} de {int(acc.activeListings)} anúncios ativos analisados</strong>
        <small>
          {scanning
            ? `Analisando agora no Mercado Livre… ${int(acc.pending)} na fila.`
            : acc.pending > 0
              ? `${int(acc.pending)} na fila para (re)ler, aos poucos em segundo plano, sem bater no limite do Mercado Livre. Os números abaixo são da última análise salva.`
              : `Tudo analisado. Última leitura em ${when(acc.lastCheckedAt)}. Releitura automática toda semana, ou ao clicar em "Analisar agora" ou em "Sincronizar" no Dashboard.`}
        </small>
      </div>
      <span className="mkt-bar" aria-hidden="true"><i style={{ width: `${ratio * 100}%` }} /></span>
    </section>
  );
}

function ToolCard({ stat, onOpen }: { stat: MarketingToolStat; onOpen: (using: boolean) => void }) {
  const info = MARKETING_TOOL_INFO[stat.tool];
  const total = stat.using + stat.notUsing;
  const share = total ? stat.using / total : 0;
  return (
    <article className="mkt-card" data-tool={stat.tool}>
      <header>
        <h3>{info.label}</h3>
        <p>{info.hint}</p>
      </header>
      <div className="mkt-body">
        <Donut share={share} />
        <dl>
          <div><dt>Com</dt><dd className="mkt-yes">{int(stat.using)}</dd></div>
          <div><dt>Sem</dt><dd>{int(stat.notUsing)}</dd></div>
          {stat.eligible > 0 && <div><dt>Elegíveis</dt><dd className="mkt-elig">{int(stat.eligible)}</dd></div>}
        </dl>
      </div>
      <footer>
        <button type="button" className="link" onClick={() => onOpen(false)} disabled={!stat.notUsing}>Ver quem não usa</button>
        <button type="button" className="link" onClick={() => onOpen(true)} disabled={!stat.using}>Ver quem usa</button>
      </footer>
    </article>
  );
}

function Donut({ share }: { share: number }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <svg className="mkt-donut" viewBox="0 0 64 64" role="img" aria-label={`${pct(share)} usam`}>
      <circle cx="32" cy="32" r={r} className="mkt-donut-bg" />
      <circle cx="32" cy="32" r={r} className="mkt-donut-fg" strokeDasharray={`${share * c} ${c}`} transform="rotate(-90 32 32)" />
      <text x="32" y="36" textAnchor="middle">{Math.round(share * 100)}%</text>
    </svg>
  );
}

function ToolListing({ acc, tool, using, onClose }: { acc: MarketingAccountDto; tool: MarketingTool; using: boolean; onClose: () => void }) {
  const [rows, setRows] = useState<MarketingListingDto[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const label = MARKETING_TOOL_INFO[tool].label;

  useEffect(() => {
    setLoading(true);
    listingsApi
      .marketingListings(acc.connectionId, tool, using, offset)
      .then((r) => {
        setRows(r.items);
        setTotal(r.total);
        setError('');
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Não foi possível carregar os anúncios.'))
      .finally(() => setLoading(false));
  }, [acc.connectionId, tool, using, offset]);

  return (
    <Modal open onClose={onClose} label={label} wide>
      <h2 className="mkt-modal-title">{label}: {using ? 'anúncios que usam' : 'anúncios que não usam'}</h2>
      <p className="mkt-muted">{acc.nickname} · {int(total)} anúncio(s){!using && ' · elegíveis primeiro'}</p>
      {error && <p className="banner banner-error" role="alert">{error}</p>}
      <ul className="mkt-list" aria-busy={loading}>
        {rows.map((l) => (
          <li key={l.id}>
            <ProductThumb src={l.pictureUrl} alt={l.title} />
            <span className="mkt-list-title">
              <b title={l.title}>{l.title}</b>
              <small>{l.sku ?? '—'} · <a href={l.permalink ?? undefined} target="_blank" rel="noreferrer">{l.id}</a></small>
            </span>
            {l.eligible && <span className="mkt-tag">Elegível</span>}
            <b className="mkt-price">{l.price === null ? '—' : money(l.price)}</b>
          </li>
        ))}
        {!loading && !rows.length && !error && <li className="mkt-muted">Nenhum anúncio.</li>}
      </ul>
      {total > 20 && (
        <div className="lsales-pager">
          <button type="button" className="act" disabled={offset === 0} onClick={() => setOffset((o) => Math.max(0, o - 20))}>‹ Anteriores</button>
          <span>{offset + 1}–{Math.min(total, offset + 20)} de {int(total)}</span>
          <button type="button" className="act" disabled={offset + 20 >= total} onClick={() => setOffset((o) => o + 20)}>Próximos ›</button>
        </div>
      )}
    </Modal>
  );
}
