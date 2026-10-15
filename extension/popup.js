const DEFAULT_API = 'https://nvs-app-production.up.railway.app';
const $ = (id) => document.getElementById(id);

async function refresh() {
  const { apiBase } = await chrome.storage.sync.get('apiBase');
  const base = (apiBase || DEFAULT_API).replace(/\/+$/, '');
  $('api').value = base;
  $('open').href = base;
  const status = $('status');
  status.className = '';
  status.textContent = 'Verificando…';
  const r = await chrome.runtime.sendMessage({ type: 'me' });
  if (r?.ok) {
    const tenant = r.data?.tenant;
    const on = tenant?.features?.includes('viabilidade');
    status.className = on ? 'ok' : 'err';
    status.textContent = on ? `Conectado: ${tenant.name}` : `${tenant?.name ?? 'Empresa'}: recurso ainda não liberado no plano`;
  } else {
    status.className = 'err';
    status.textContent = r?.status === 401 ? 'Você não está logado no NVS neste navegador.' : 'Não foi possível falar com o NVS.';
  }
}

$('save').addEventListener('click', async () => {
  await chrome.storage.sync.set({ apiBase: $('api').value.trim() });
  refresh();
});
$('reset').addEventListener('click', async () => {
  await chrome.storage.sync.remove('apiBase');
  refresh();
});
refresh();
