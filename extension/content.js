// Roda dentro das páginas do Mercado Livre: põe uma etiqueta (data, vendas, tipo) em cada anúncio da página
// e, na página de um anúncio, um painel com o gráfico de visitas. Os dados vêm da API do NVS (via background.js).
(() => {
  const BATCH = 60; // limite da rota em lote
  const CARD_SEL = '.poly-card, li.ui-search-layout__item, .ui-search-result__wrapper';

  const nf = new Intl.NumberFormat('pt-BR');
  const nf2 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('pt-BR') : '—');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const REPUTATION = { '5_green': '🟢 verde', '4_light_green': '🟢 verde-claro', '3_yellow': '🟡 amarela', '2_orange': '🟠 laranja', '1_red': '🔴 vermelha' };
  const send = (msg) => new Promise((ok) => chrome.runtime.sendMessage(msg, ok));

  // ---------------------------------------------------------------- ID do anúncio a partir de um link
  /** { item: 'MLB…' } para anúncio; { product: 'MLB…' } para página de catálogo sem o anúncio vencedor. */
  function idFromHref(href, depth = 0) {
    let u;
    try {
      u = new URL(href, location.href);
    } catch {
      return null;
    }
    const inner = u.searchParams.get('url'); // links patrocinados passam por um redirecionador
    if (inner && depth < 2) return idFromHref(inner, depth + 1);
    const wid = u.searchParams.get('wid') || new URLSearchParams(u.hash.slice(1)).get('wid');
    if (wid && /^MLB\d+$/i.test(wid)) return { item: wid.toUpperCase() };
    let m = u.pathname.match(/\/p\/(MLB\d+)/i);
    if (m) return { product: m[1].toUpperCase() };
    m = u.pathname.match(/\bMLB-?(\d{6,})/i);
    if (m) return { item: `MLB${m[1]}` };
    return null;
  }

  function idOfCard(card) {
    for (const a of card.querySelectorAll('a[href]')) {
      const id = idFromHref(a.href);
      if (id) return id;
    }
    return null;
  }

  // ---------------------------------------------------------------- etiquetas nos cards
  const cardsById = new Map(); // id -> Set<elemento da etiqueta>
  const data = new Map(); // id -> dado leve (ou null = ML não devolveu)
  const pending = new Set();
  let blocked = null; // erro que impede novas consultas (login, recurso, conexão ML)
  let timer = null;

  function scan() {
    let cards = document.querySelectorAll('.poly-card');
    if (!cards.length) cards = document.querySelectorAll(CARD_SEL);
    for (const card of cards) {
      if (card.dataset.nvs || card.closest('[data-nvs]')) continue;
      const id = idOfCard(card);
      if (!id) continue;
      card.dataset.nvs = '1';
      const tag = document.createElement('div');
      tag.className = 'nvs-tag';
      tag.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openModal(id.item || id.product);
      });
      const host = card.querySelector('.poly-card__content, .ui-search-result__content, .ui-search-result__content-wrapper') || card;
      host.appendChild(tag);
      if (id.product) {
        tag.innerHTML = '<span class="nvs-chip nvs-cat">Catálogo</span><span class="nvs-dim">clique para ver os dados</span>';
        continue;
      }
      if (!cardsById.has(id.item)) cardsById.set(id.item, new Set());
      cardsById.get(id.item).add(tag);
      if (data.has(id.item)) renderTag(tag, data.get(id.item));
      else {
        renderTag(tag, undefined);
        pending.add(id.item);
      }
    }
    if (pending.size && !timer) timer = setTimeout(flush, 250);
  }

  async function flush() {
    timer = null;
    if (blocked) return showBlocked();
    const ids = [...pending].slice(0, BATCH);
    ids.forEach((i) => pending.delete(i));
    const r = await send({ type: 'batch', ids });
    if (!r?.ok) {
      blocked = r;
      return showBlocked();
    }
    for (const id of ids) {
      data.set(id, r.data[id] ?? null);
      for (const tag of cardsById.get(id) ?? []) renderTag(tag, data.get(id));
    }
    if (pending.size) timer = setTimeout(flush, 250);
  }

  function blockedHtml(r) {
    const code = r?.error?.code;
    if (r?.status === 401) return `<a class="nvs-link" href="${esc(r.base)}" target="_blank" rel="noopener">Entre no NVS para ver os dados ↗</a>`;
    if (code === 'FEATURE_LOCKED') return '<span class="nvs-dim">Estudo de Viabilidade ainda não liberado para a sua empresa</span>';
    if (r?.status === 409) return '<span class="nvs-dim">Conecte uma conta do Mercado Livre no NVS</span>';
    return `<span class="nvs-dim">NVS: ${esc(r?.error?.message || 'não foi possível consultar agora')}</span>`;
  }

  function showBlocked() {
    for (const tags of cardsById.values()) for (const tag of tags) if (!tag.dataset.done) tag.innerHTML = blockedHtml(blocked);
  }

  function chips(d) {
    const out = [];
    out.push(`<span class="nvs-chip" title="Data de criação">📅 ${fmtDate(d.createdAt)}${d.ageDays != null ? ` · ${nf.format(d.ageDays)}d` : ''}</span>`);
    if (d.soldQuantity != null)
      out.push(`<span class="nvs-chip" title="Vendas · média por dia de vida">🛒 ${nf.format(d.soldQuantity)}${d.salesPerDay != null ? ` · ${nf2.format(d.salesPerDay)}/dia` : ''}</span>`);
    else out.push('<span class="nvs-chip nvs-dim" title="O ML não informou as vendas deste anúncio">🛒 —</span>');
    if (d.catalog != null) out.push(`<span class="nvs-chip ${d.catalog ? 'nvs-cat' : 'nvs-trad'}">${d.catalog ? 'Catálogo' : 'Tradicional'}</span>`);
    if (d.listingType) out.push(`<span class="nvs-chip">${esc(d.listingType)}</span>`);
    if (d.logisticType === 'fulfillment') out.push('<span class="nvs-chip nvs-full">⚡ Full</span>');
    return out.join('');
  }

  function renderTag(tag, d) {
    if (d === undefined) {
      tag.innerHTML = '<span class="nvs-dim">NVS…</span>';
      return;
    }
    tag.dataset.done = '1';
    tag.innerHTML = d ? `${chips(d)}<span class="nvs-chip nvs-btn" title="Ver visitas dos últimos 6 meses">📈</span>` : '<span class="nvs-dim">NVS: sem dados deste anúncio</span>';
  }

  // ---------------------------------------------------------------- detalhe (modal e painel da página do anúncio)
  function chart(visits) {
    const days = visits?.daily ?? [];
    if (!days.length) return '<p class="nvs-dim">Sem visitas no período.</p>';
    const W = 560, H = 120, P = 4;
    const max = Math.max(1, ...days.map((d) => d.total));
    const step = (W - P * 2) / Math.max(1, days.length - 1);
    const pts = days.map((d, i) => [P + i * step, H - P - (d.total / max) * (H - P * 2)]);
    const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const area = `${P},${H - P} ${line} ${(P + (days.length - 1) * step).toFixed(1)},${H - P}`;
    const months = (visits.monthly ?? [])
      .map((m) => {
        const [y, mo] = m.month.split('-');
        const label = new Date(Number(y), Number(mo) - 1, 1).toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '');
        return `<div class="nvs-month"><b>${nf.format(m.total)}</b><span>${esc(label)}/${y.slice(2)}</span></div>`;
      })
      .join('');
    return `<svg class="nvs-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Visitas por dia">
        <polygon points="${area}" class="nvs-area"/><polyline points="${line}" class="nvs-line"/></svg>
      <div class="nvs-chart-meta"><span>${fmtDate(days[0].date)}</span><span>pico ${nf.format(max)}/dia</span><span>${fmtDate(days[days.length - 1].date)}</span></div>
      <div class="nvs-months">${months}</div>`;
  }

  /** Vendas escritas na página do anúncio ("+500 vendidos", "+5 mil vendidos"), quando a API não informa. */
  function soldFromPage() {
    const t = document.querySelector('.ui-pdp-subtitle, .ui-pdp-header__subtitle')?.textContent ?? '';
    const m = t.match(/\+?\s*([\d.]+)\s*(mil)?\s*vendid/i);
    if (!m) return null;
    return `+${nf.format(Number(m[1].replace(/\./g, '')) * (m[2] ? 1000 : 1))} (página)`;
  }

  function detailHtml(d, withSoldFallback) {
    const sold = d.soldQuantity != null ? nf.format(d.soldQuantity) : (withSoldFallback && soldFromPage()) || 'não informado pelo ML';
    const rows = [
      ['Criado em', `${fmtDate(d.createdAt)}${d.ageDays != null ? ` (${nf.format(d.ageDays)} dias)` : ''}`],
      ['Vendas', `${sold}${d.salesPerDay != null ? ` · ${nf2.format(d.salesPerDay)}/dia` : ''}`],
      ['Tipo', `${d.catalog == null ? '—' : d.catalog ? 'Catálogo' : 'Tradicional'}${d.listingType ? ` · ${esc(d.listingType)}` : ''}`],
      ['Envio', `${d.logisticType === 'fulfillment' ? 'Full' : esc(d.logisticType || '—')}${d.freeShipping ? ' · frete grátis' : ''}`],
      ['Preço', d.price != null ? d.price.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '—'],
      ['Estoque', d.availableQuantity != null ? nf.format(d.availableQuantity) : '—'],
      ['Vendedor', d.seller ? `${esc(d.seller.nickname || d.seller.id)}${d.seller.reputation ? ` · ${esc(REPUTATION[d.seller.reputation] ?? d.seller.reputation)}` : ''}` : '—'],
    ];
    const visitsTitle = d.visits ? `Visitas · 6 meses · ${nf.format(d.visits.total)} no total` : 'Visitas';
    return `<div class="nvs-head"><b>${esc(d.title)}</b><span class="nvs-dim">${esc(d.itemId)}</span></div>
      <dl class="nvs-grid">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      <h4>${visitsTitle}</h4>
      ${d.visits ? chart(d.visits) : '<p class="nvs-dim">O Mercado Livre não liberou as visitas deste anúncio.</p>'}
      <p class="nvs-foot">Dados do Mercado Livre via NVS · atualizado ${new Date(d.fetchedAt).toLocaleString('pt-BR')}</p>`;
  }

  async function loadDetail(box, id, withSoldFallback) {
    box.innerHTML = '<p class="nvs-dim">Carregando…</p>';
    const r = await send({ type: 'one', id });
    box.innerHTML = r?.ok ? detailHtml(r.data, withSoldFallback) : `<p>${blockedHtml(r)}</p>`;
  }

  function openModal(id) {
    document.querySelector('.nvs-modal')?.remove();
    const modal = document.createElement('div');
    modal.className = 'nvs-modal';
    modal.innerHTML = '<div class="nvs-card"><button class="nvs-x" aria-label="Fechar">×</button><div class="nvs-body"></div></div>';
    modal.addEventListener('click', (e) => {
      if (e.target === modal || e.target.classList.contains('nvs-x')) modal.remove();
    });
    document.body.appendChild(modal);
    loadDetail(modal.querySelector('.nvs-body'), id, false);
  }

  function productPanel() {
    const id = idFromHref(location.href);
    if (!id || document.querySelector('.nvs-panel')) return;
    const panel = document.createElement('aside');
    panel.className = 'nvs-panel';
    panel.innerHTML = '<div class="nvs-bar"><b>NVS · Viabilidade</b><button class="nvs-min" aria-label="Minimizar">–</button></div><div class="nvs-body"></div>';
    panel.querySelector('.nvs-min').addEventListener('click', () => panel.classList.toggle('nvs-collapsed'));
    document.body.appendChild(panel);
    loadDetail(panel.querySelector('.nvs-body'), id.item || id.product, true);
  }

  // ---------------------------------------------------------------- início
  const isProductPage = /\/p\/MLB\d+/i.test(location.pathname) || /\bMLB-\d{6,}/i.test(location.pathname);
  if (isProductPage) productPanel();
  scan();
  let scanTimer = null;
  new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 300);
  }).observe(document.body, { childList: true, subtree: true });
})();
