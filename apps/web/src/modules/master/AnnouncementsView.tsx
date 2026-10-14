import { useEffect, useState, type FormEvent } from 'react';
import type { AnnouncementDto, TenantRowDto } from '@nvs/shared';
import { ApiError } from '../../shared/http';
import { Button } from '../../shared/ui/Button';
import { masterApi } from './master-api';

const LEVEL = { info: 'Informação', success: 'Novidade', warning: 'Atenção', danger: 'Urgente' } as const;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
/** "2026-10-14T09:00" (campo local) → ISO com fuso */
const toIso = (local: string) => (local ? new Date(local).toISOString() : null);

/**
 * Comunicados de transmissão: aparecem como faixa no topo do sistema para todas as empresas ou para as escolhidas,
 * a partir de quando você quiser e até quando quiser. Quem fecha não vê de novo. Avisos de mensalidade em atraso são
 * automáticos (não precisam ser criados aqui).
 */
export function AnnouncementsView() {
  const [rows, setRows] = useState<AnnouncementDto[] | null>(null);
  const [tenants, setTenants] = useState<TenantRowDto[]>([]);
  const [f, setF] = useState({ title: '', body: '', level: 'info', audience: 'all' as 'all' | 'tenants', tenantIds: [] as string[], startsAt: '', endsAt: '' });
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => masterApi.announcements().then(setRows).catch(() => setRows([]));
  useEffect(() => {
    void load();
    void masterApi.tenants().then(setTenants).catch(() => undefined);
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await masterApi.announce({ ...f, startsAt: toIso(f.startsAt), endsAt: toIso(f.endsAt) });
      setNote(f.startsAt ? 'Comunicado agendado.' : 'Comunicado publicado: já aparece para os usuários.');
      setF({ title: '', body: '', level: 'info', audience: 'all', tenantIds: [], startsAt: '', endsAt: '' });
      void load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível publicar.');
    } finally {
      setBusy(false);
    }
  }

  const status = (a: AnnouncementDto) => {
    const now = Date.now();
    if (!a.active || (a.endsAt && Date.parse(a.endsAt) <= now)) return ['Encerrado', 'canceled'];
    if (Date.parse(a.startsAt) > now) return ['Agendado', 'trial'];
    return ['No ar', 'active'];
  };
  const shown = tenants.filter((t) => !filter || t.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="ms-page">
      <header className="ms-head"><div><p className="dash-kicker">Painel Master</p><h1>Comunicados</h1></div></header>
      <div className="ms-two ms-two-wide">
        <form className="ms-card ms-form" onSubmit={submit}>
          <h2>Nova mensagem</h2>
          <label><small>Título</small><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required maxLength={120} placeholder="Ex.: Novidade no Dashboard" /></label>
          <label><small>Mensagem</small><textarea rows={4} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} required maxLength={2000} /></label>
          <div className="ms-grid">
            <label><small>Tipo</small>
              <select value={f.level} onChange={(e) => setF({ ...f, level: e.target.value })}>{Object.entries(LEVEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            </label>
            <label><small>Para quem</small>
              <select value={f.audience} onChange={(e) => setF({ ...f, audience: e.target.value as 'all' | 'tenants' })}>
                <option value="all">Todas as empresas</option><option value="tenants">Empresas escolhidas</option>
              </select>
            </label>
            <label><small>Começa (vazio = agora)</small><input type="datetime-local" value={f.startsAt} onChange={(e) => setF({ ...f, startsAt: e.target.value })} /></label>
            <label><small>Termina (vazio = até encerrar)</small><input type="datetime-local" value={f.endsAt} onChange={(e) => setF({ ...f, endsAt: e.target.value })} /></label>
          </div>
          {f.audience === 'tenants' && (
            <div className="ms-pick">
              <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filtrar empresas…" aria-label="Filtrar empresas" />
              <ul>
                {shown.map((t) => (
                  <li key={t.id}>
                    <label className="full-check">
                      <input type="checkbox" checked={f.tenantIds.includes(t.id)}
                             onChange={(e) => setF({ ...f, tenantIds: e.target.checked ? [...f.tenantIds, t.id] : f.tenantIds.filter((x) => x !== t.id) })} />
                      {t.name}
                    </label>
                  </li>
                ))}
              </ul>
              <small>{f.tenantIds.length} escolhida(s)</small>
            </div>
          )}
          <div className={`ms-preview ms-notice-${f.level}`}><b>{f.title || 'Título do comunicado'}</b><span>{f.body || 'Assim a mensagem aparece no topo do sistema.'}</span></div>
          {error && <p className="banner banner-error">{error}</p>}
          {note && <p className="banner banner-ok">{note}</p>}
          <Button type="submit" loading={busy}>{f.startsAt ? 'Agendar comunicado' : 'Publicar agora'}</Button>
        </form>
        <section className="ms-card">
          <h2>Enviados</h2>
          {!rows ? <div className="promo-skel" aria-hidden="true" /> : !rows.length ? <p className="ms-sub">Nenhum comunicado ainda.</p> : (
            <ul className="ms-ann">
              {rows.map((a) => {
                const [label, s] = status(a);
                return (
                  <li key={a.id}>
                    <header><b>{a.title}</b><span className="ms-pill" data-s={s}>{label}</span></header>
                    <p>{a.body}</p>
                    <small>
                      {LEVEL[a.level]} · {a.audience === 'all' ? 'todas as empresas' : `${a.tenantIds.length} empresa(s)`} · de {when(a.startsAt)}{a.endsAt ? ` até ${when(a.endsAt)}` : ''} · {a.dismissals} pessoa(s) fecharam
                    </small>
                    {s !== 'canceled' && <button type="button" className="link" onClick={() => void masterApi.announcementActive(a.id, false).then(load)}>Encerrar</button>}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
