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

// ---------------------------------------------------------------- dados da página do anúncio (anúncio de terceiro)
// O ML não libera vendas/tipo de outro vendedor pela API, mas a página do anúncio traz esses dados no HTML.
const PAGE_TTL = 6 * 3600 * 1000;

function parseItemPage(html, finalUrl) {
  const sold = html.match(/\\?"sold_quantity\\?"\s*:\s*(\d+)/);
  const type = html.match(/\\?"listing_type_id\\?"\s*:\s*\\?"(\w+)/);
  return {
    soldQuantity: sold ? Number(sold[1]) : null,
    listingTypeId: type ? type[1] : null,
    catalog: /\/p\/MLB\d+/i.test(finalUrl),
  };
}

// páginas de verificação ("não sou robô", login): o ML não entregou o anúncio
const CHALLENGE = /\/captcha\/wall|\/gz\/account-verification|\/challenge|\/gz\/login/i;
let pausedUntil = 0;

async function itemPage(id) {
  const key = `page:${id}`;
  const saved = (await chrome.storage.local.get(key))[key];
  if (saved && Date.now() - saved.at < PAGE_TTL) return { ok: true, data: saved.data };
  if (Date.now() < pausedUntil) return { ok: false, paused: true };
  try {
    // sem cookies, como um visitante: com a sessão do usuário o ML costuma pedir verificação
    const res = await fetch(`https://produto.mercadolivre.com.br/MLB-${id.replace(/^MLB-?/i, '')}`, { credentials: 'omit' });
    if (CHALLENGE.test(res.url)) {
      pausedUntil = Date.now() + 5 * 60_000;
      return { ok: false, paused: true };
    }
    if (res.status === 429) {
      pausedUntil = Date.now() + 60_000;
      return { ok: false, paused: true };
    }
    if (!res.ok) return { ok: false, status: res.status };
    const data = parseItemPage(await res.text(), res.url);
    if (data.soldQuantity !== null || data.listingTypeId !== null) await chrome.storage.local.set({ [key]: { at: Date.now(), data } });
    return { ok: true, data };
  } catch {
    return { ok: false, status: 0 };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'batch') call(`/ml/viabilidade?ids=${encodeURIComponent(msg.ids.join(','))}`).then(reply);
  else if (msg?.type === 'one') call(`/ml/viabilidade/${encodeURIComponent(msg.id)}`).then(reply);
  else if (msg?.type === 'me') call('/auth/me').then(reply);
  else if (msg?.type === 'page') itemPage(msg.id).then(reply);
  else return false;
  return true; // resposta assíncrona
});
