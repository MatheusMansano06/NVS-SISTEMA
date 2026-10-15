// Fala com a API do NVS. Roda no service worker da extensão: com host_permissions o cookie de sessão do NVS
// vai junto e não há bloqueio de CORS (o content script, dentro da página do ML, não conseguiria).
const DEFAULT_API = 'https://nvs-app-production.up.railway.app';

async function apiBase() {
  const { apiBase: saved } = await chrome.storage.sync.get('apiBase');
  return (saved || DEFAULT_API).replace(/\/+$/, '');
}

async function call(path) {
  const base = await apiBase();
  try {
    const res = await fetch(`${base}/api/v1${path}`, { credentials: 'include' });
    const body = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data: res.ok ? body : null, error: res.ok ? null : body?.error ?? null, base };
  } catch {
    return { ok: false, status: 0, data: null, error: { code: 'OFFLINE', message: 'Sem conexão com o NVS' }, base };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'batch') call(`/ml/viabilidade?ids=${encodeURIComponent(msg.ids.join(','))}`).then(reply);
  else if (msg?.type === 'one') call(`/ml/viabilidade/${encodeURIComponent(msg.id)}`).then(reply);
  else if (msg?.type === 'me') call('/auth/me').then(reply);
  else return false;
  return true; // resposta assíncrona
});
