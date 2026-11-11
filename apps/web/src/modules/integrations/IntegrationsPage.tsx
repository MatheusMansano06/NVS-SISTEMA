import { useCallback, useEffect, useState } from 'react';
import type { MlStatusDto, ShopeeStatusDto, TiktokStatusDto } from '@nvs/shared';
import { AppShell } from '../../app/AppShell';
import { useFeature } from '../../shared/features';
import { Button } from '../../shared/ui/Button';
import { goToMercadoLivre, mlApi } from '../mercado-livre/ml-api';
import { consumeTiktokReturn, goToTiktokShop, tiktokApi } from '../tiktok-shop/tiktok-api';
import { consumeShopeeReturn, goToShopee, shopeeApi } from '../shopee/shopee-api';
import '../dashboard/dashboard.css';
import './integrations.css';

const POLL_RUNNING_MS = 4000; // sincronizando: acompanha de perto
const time = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : null;

interface Row {
  id: string;
  nickname: string;
  state: 'ok' | 'warn' | 'busy';
  detail: string;
}

/** Um marketplace: contas conectadas, conectar outra e sincronizar. */
function Card(p: {
  title: string;
  text: string;
  rows: Row[] | null;
  onConnect: () => Promise<void>;
  onSync: (id: string) => Promise<unknown>;
  onChange: () => void;
}) {
  const [error, setError] = useState('');
  const run = (fn: () => Promise<unknown>, fail: string) => {
    setError('');
    fn().then(p.onChange).catch(() => setError(fail));
  };
  return (
    <section className="panel integ-card" aria-label={p.title}>
      <div className="panel-head">
        <div>
          <h2>{p.title}</h2>
          <p>{p.text}</p>
        </div>
        <Button onClick={() => run(p.onConnect, `Não foi possível abrir a autorização do ${p.title}. Tente novamente.`)}>
          {p.rows?.length ? 'Conectar outra conta' : 'Conectar conta'}
        </Button>
      </div>
      {error && <p className="banner banner-error" role="alert">{error}</p>}
      {p.rows === null ? null : p.rows.length === 0 ? (
        <p className="integ-empty">Nenhuma conta conectada ainda.</p>
      ) : (
        <ul className="integ-list">
          {p.rows.map((r) => (
            <li key={r.id}>
              <span className="integ-dot" data-state={r.state} aria-hidden="true" />
              <div>
                <strong>{r.nickname}</strong>
                <small>{r.detail}</small>
              </div>
              {r.state === 'warn' ? (
                <button type="button" className="link" onClick={() => run(p.onConnect, 'Não foi possível abrir a autorização.')}>Reconectar</button>
              ) : (
                r.state === 'ok' && (
                  <button type="button" className="link" onClick={() => run(() => p.onSync(r.id), 'Não foi possível iniciar a sincronização.')}>
                    Sincronizar agora
                  </button>
                )
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const mlRows = (s: MlStatusDto): Row[] =>
  s.connections.map((c) => {
    const busy = c.sync?.status === 'running' || c.history.running;
    return {
      id: c.id,
      nickname: c.nickname,
      state: c.status !== 'active' ? 'warn' : busy ? 'busy' : 'ok',
      detail:
        c.status !== 'active'
          ? (c.lastError ?? 'A autorização precisa ser renovada.')
          : c.sync?.status === 'running'
            ? `Sincronizando: ${c.sync.progress}%`
            : `Atualizada ${time(c.lastSyncedAt) ?? 'há pouco'} · automática a cada hora`,
    };
  });

const tiktokRows = (s: TiktokStatusDto): Row[] =>
  s.connections.map((c) => ({
    id: c.id,
    nickname: c.nickname,
    state: c.status !== 'active' ? 'warn' : c.syncing ? 'busy' : 'ok',
    detail:
      c.status !== 'active'
        ? (c.lastError ?? 'A autorização precisa ser renovada.')
        : c.syncing
          ? `${c.historyDone ? 'Atualizando' : 'Trazendo o histórico de vendas'}: ${c.ordersImported} pedido(s) até agora (pode usar o sistema)`
          : (c.syncError ?? `${c.ordersImported} pedido(s) · atualizada ${time(c.lastSyncedAt) ?? 'há pouco'} · automática a cada hora`),
  }));

const shopeeRows = (s: ShopeeStatusDto): Row[] =>
  tiktokRows(s).map((row, i) => {
    const exp = s.connections[i]!.authExpiresAt;
    const days = exp ? Math.ceil((new Date(exp).getTime() - Date.now()) / 86_400_000) : null;
    // a autorização da Shopee vence (até 1 ano): avisa no último mês
    return row.state === 'ok' && days !== null && days <= 30
      ? { ...row, state: 'warn', detail: `A autorização vence em ${Math.max(0, days)} dia(s). Clique em conectar para renovar.` }
      : row;
  });

/** Integrações: contas de marketplace conectadas à empresa (várias por marketplace). */
export function IntegrationsPage() {
  const hasTiktok = useFeature('tiktok_shop');
  const [ml, setMl] = useState<MlStatusDto | null>(null);
  const [tiktok, setTiktok] = useState<TiktokStatusDto | null>(null);
  const hasShopee = useFeature('shopee');
  const [shopee, setShopee] = useState<ShopeeStatusDto | null>(null);
  const [back] = useState(consumeTiktokReturn);
  const [backShopee] = useState(consumeShopeeReturn);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let alive = true;
    let timer = 0;
    void Promise.all([
      mlApi.status().catch(() => null),
      hasTiktok ? tiktokApi.status().catch(() => null) : null,
      hasShopee ? shopeeApi.status().catch(() => null) : null,
    ]).then(([m, t, sh]) => {
      if (!alive) return;
      if (m) setMl(m);
      if (t) setTiktok(t);
      if (sh) setShopee(sh);
      const busy =
        m?.connections.some((c) => c.sync?.status === 'running') || t?.connections.some((c) => c.syncing) || sh?.connections.some((c) => c.syncing) ||
        (back?.connected && !t?.connections.length) || (backShopee?.connected && !sh?.connections.length);
      if (busy) timer = window.setTimeout(reload, POLL_RUNNING_MS);
    });
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [hasTiktok, hasShopee, tick, back, backShopee, reload]);

  return (
    <AppShell>
      <div className="integ">
        <header className="dash-head">
          <div>
            <p className="dash-kicker">Configurações</p>
            <h1>Integrações</h1>
          </div>
        </header>
        {back?.connected && <p className="banner banner-ok" role="status">Loja do TikTok Shop conectada. Estou trazendo o histórico de vendas em segundo plano.</p>}
        {back?.error && <p className="banner banner-error" role="alert">{back.error}</p>}
        {backShopee?.connected && <p className="banner banner-ok" role="status">Loja da Shopee conectada. Estou trazendo o histórico de vendas em segundo plano.</p>}
        {backShopee?.error && <p className="banner banner-error" role="alert">{backShopee.error}</p>}

        {ml?.configured !== false && (
          <Card
            title="Mercado Livre"
            text="Vendas, anúncios, fretes e Mercado Ads. Você pode conectar mais de uma conta."
            rows={ml ? mlRows(ml) : null}
            onConnect={goToMercadoLivre}
            onSync={(id) => mlApi.sync(id)}
            onChange={reload}
          />
        )}
        {hasTiktok && tiktok?.configured !== false && (
          <Card
            title="TikTok Shop"
            text="Vendas e tarifas da loja, para a Análise Financeira (aba TikTok Shop). Você pode conectar mais de uma loja."
            rows={tiktok ? tiktokRows(tiktok) : null}
            onConnect={goToTiktokShop}
            onSync={(id) => tiktokApi.sync(id)}
            onChange={reload}
          />
        )}
        {hasShopee && shopee?.configured !== false && (
          <Card
            title="Shopee"
            text="Vendas e repasses da loja, para a Análise Financeira (aba Shopee). Você pode conectar mais de uma loja."
            rows={shopee ? shopeeRows(shopee) : null}
            onConnect={goToShopee}
            onSync={(id) => shopeeApi.sync(id)}
            onChange={reload}
          />
        )}
      </div>
    </AppShell>
  );
}
