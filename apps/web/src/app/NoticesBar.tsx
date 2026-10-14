import { useEffect, useState } from 'react';
import type { UserNoticeDto } from '@nvs/shared';
import { http } from '../shared/http';
import './notices.css';

/** Comunicados do NVS Tech (Painel Master) e avisos automáticos da assinatura, no topo do sistema. */
export function NoticesBar() {
  const [notices, setNotices] = useState<UserNoticeDto[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => http<UserNoticeDto[]>('/api/v1/notices').then((n) => alive && setNotices(n)).catch(() => undefined);
    void load();
    const t = window.setInterval(load, 5 * 60_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);
  if (!notices.length) return null;
  return (
    <div className="notices" role="region" aria-label="Avisos do NVS Tech">
      {notices.map((n) => (
        <div key={n.id} className={`notice notice-${n.level}`} role={n.level === 'danger' ? 'alert' : 'status'}>
          <b>{n.title}</b>
          <span>{n.body}</span>
          {!n.automatic && (
            <button
              type="button"
              aria-label="Fechar aviso"
              onClick={() => {
                setNotices((all) => all.filter((x) => x.id !== n.id));
                void http(`/api/v1/notices/${n.id}/dismiss`, { method: 'POST' }).catch(() => undefined);
              }}
            >
              ✕
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
