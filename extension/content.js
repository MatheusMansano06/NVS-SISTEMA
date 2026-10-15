// Roda dentro das páginas do Mercado Livre: põe uma etiqueta (data, vendas, tipo) em cada anúncio da página
// e, na página de um anúncio, um painel com o gráfico de visitas.
// Fontes: API do NVS (data de criação e visitas; tudo, para anúncio da própria conta) e a página do anúncio
// no ML (vendas e tipo de anúncio de outro vendedor, que a API do ML não libera). Ambas via background.js.
(() => {
  const BATCH = 60; // limite da rota em lote
  const PAGE_CONCURRENCY = 2; // páginas de anúncio buscadas ao mesmo tempo (devagar, para não parecer robô)
  const CARD_SEL = '.poly-card, li.ui-search-layout__item, .ui-search-result__wrapper';

  const nf = new Intl.NumberFormat('pt-BR');
  const nf2 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('pt-BR') : '—');
  const fmtMonth = (iso) => new Date(iso).toLocaleDateString('pt-BR', { month: '2-digit', year: 'numeric' });
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const REPUTATION = { '5_green': '🟢 verde', '4_light_green': '🟢 verde-claro', '3_yellow': '🟡 amarela', '2_orange': '🟠 laranja', '1_red': '🔴 vermelha' };
  const TYPE_LABEL = { gold_special: 'Clássico', gold_pro: 'Premium', free: 'Grátis' };
  const DAY = 86_400_000;
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
    const filter = (u.searchParams.get('pdp_filters') || '').match(/item_id:(MLB\d+)/i); // link novo /up/MLBU…
    if (filter) return { item: filter[1].toUpperCase() };
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

  /** Vendas escritas no card/página ("+1000 vendidos", "+5 mil vendidos"), usadas até chegar o número exato. */
  function soldText(text) {
    const m = (text || '').match(/\+?\s*([\d.]+)\s*(mil)?\s*vendid/i);
    return m ? `+${nf.format(Number(m[1].replace(/\./g, '')) * (m[2] ? 1000 : 1))}` : null;
  }

  // ---------------------------------------------------------------- estado
  const tagsById = new Map(); // id -> Set<etiqueta>
  const api = new Map(); // id -> dado leve da API (null = sem dados)
  const page = new Map(); // id -> { soldQuantity, listingTypeId, catalog } lido da página do anúncio
  const pendingApi = new Set();
  const pageQueue = [];
  const pageQueued = new Set();
  let pageRunning = 0;
  let pageBlocked = false;
  let blocked = null; // erro do NVS que impede novas consultas (login, recurso, conexão ML)
  let timer = null;

  const viewport = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        viewport.unobserve(e.target);
        queuePage(e.target.dataset.nvsId);
      }
    },
    { rootMargin: '300px' },
  );

  // ---------------------------------------------------------------- etiquetas nos cards
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
      tag.dataset.soldText = soldText(card.textContent) || '';
      tag.dataset.full = /FULL/.test(card.textContent) ? '1' : ''; // selo ⚡FULL do card
      tag.dataset.title = (card.querySelector('h2, h3, .poly-component__title, .ui-search-item__title') || card.querySelector('a[href]'))?.textContent.trim() || '';
      tag.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openModal(id.item || id.product, tag);
      });
      const host = card.querySelector('.poly-card__content, .ui-search-result__content, .ui-search-result__content-wrapper') || card;
      host.appendChild(tag);
      if (id.product) {
        tag.innerHTML = '<span class="nvs-chip nvs-cat">Catálogo</span><span class="nvs-dim">clique para ver os dados</span>';
        continue;
      }
      tag.dataset.nvsId = id.item;
      if (!tagsById.has(id.item)) tagsById.set(id.item, new Set());
      tagsById.get(id.item).add(tag);
      renderTag(tag);
      if (!api.has(id.item)) pendingApi.add(id.item);
      viewport.observe(tag);
    }
    if (pendingApi.size && !timer) timer = setTimeout(flush, 250);
  }

  async function flush() {
    timer = null;
    if (blocked) return showBlocked();
    const ids = [...pendingApi].slice(0, BATCH);
    ids.forEach((i) => pendingApi.delete(i));
    const r = await send({ type: 'batch', ids });
    if (!r?.ok) {
      blocked = r;
      return showBlocked();
    }
    for (const id of ids) {
      api.set(id, r.data[id] ?? null);
      refresh(id);
    }
    if (pendingApi.size) timer = setTimeout(flush, 250);
  }

  // vendas e tipo de anúncio de terceiro: página do anúncio, poucas por vez e só das que aparecem na tela
  function queuePage(id) {
    if (!id || pageQueued.has(id) || pageBlocked) return;
    pageQueued.add(id);
    pageQueue.push(id);
    pumpPages();
  }

  async function pumpPages() {
    while (pageRunning < PAGE_CONCURRENCY && pageQueue.length && !pageBlocked) {
      const id = pageQueue.shift();
      // anúncio da própria conta já vem completo da API
      if (api.get(id)?.fromApi) continue;
      pageRunning++;
      send({ type: 'page', id })
        .then((r) => {
          if (r?.blocked) pageBlocked = true;
          if (r?.ok) {
            page.set(id, r.data);
            refresh(id);
          }
        })
        .finally(() => {
          pageRunning--;
          pumpPages();
        });
    }
  }

  function refresh(id) {
    for (const tag of tagsById.get(id) ?? []) renderTag(tag);
  }

  /** Junta API (data, e tudo se for da conta) com a página do anúncio (vendas e tipo de terceiro). */
  function merged(id, tag) {
    const a = api.get(id);
    const p = page.get(id);
    if (a === undefined && !p) return undefined;
    const createdAt = a?.createdAt ?? null;
    const ageDays = a?.ageDays ?? (createdAt ? Math.max(1, Math.floor((Date.now() - Date.parse(createdAt)) / DAY)) : null);
    const sold = a?.fromApi ? a.soldQuantity : p?.soldQuantity ?? null;
    return {
      createdAt,
      estimated: Boolean(a?.createdAtEstimated),
      ageDays,
      sold,
      soldText: sold == null ? tag?.dataset.soldText || null : null,
      perDay: sold != null && ageDays ? sold / ageDays : null,
      catalog: a?.fromApi ? a.catalog : p ? p.catalog : null,
      type: a?.fromApi ? a.listingType : p ? TYPE_LABEL[p.listingTypeId] ?? p.listingTypeId : null,
      full: a?.fromApi ? a.logisticType === 'fulfillment' : tag?.dataset.full === '1',
    };
  }

  function chips(d) {
    const out = [];
    if (d.createdAt) {
      const when = d.estimated ? `~${fmtMonth(d.createdAt)}` : fmtDate(d.createdAt);
      const title = d.estimated ? 'Data estimada pelo número do anúncio (o ML não informa a de outros vendedores)' : 'Data de criação';
      out.push(`<span class="nvs-chip" title="${title}">📅 ${when}${d.ageDays != null ? ` · ${d.estimated ? '~' : ''}${nf.format(d.ageDays)}d` : ''}</span>`);
    } else out.push('<span class="nvs-chip nvs-dim">📅 —</span>');
    if (d.sold != null) out.push(`<span class="nvs-chip" title="Vendas · média por dia de vida">🛒 ${nf.format(d.sold)}${d.perDay != null ? ` · ${d.estimated ? '~' : ''}${nf2.format(d.perDay)}/dia` : ''}</span>`);
    else if (d.soldText) out.push(`<span class="nvs-chip" title="Vendas mostradas pelo ML (faixa)">🛒 ${esc(d.soldText)}</span>`);
    else out.push('<span class="nvs-chip nvs-dim">🛒 …</span>');
    if (d.catalog != null) out.push(`<span class="nvs-chip ${d.catalog ? 'nvs-cat' : 'nvs-trad'}">${d.catalog ? 'Catálogo' : 'Tradicional'}</span>`);
    if (d.type) out.push(`<span class="nvs-chip">${esc(d.type)}</span>`);
    if (d.full) out.push('<span class="nvs-chip nvs-full">⚡ Full</span>');
    out.push('<span class="nvs-chip nvs-btn" title="Ver visitas dos últimos 6 meses">📈</span>');
    return out.join('');
  }

  function renderTag(tag) {
    if (blocked) return;
    const d = merged(tag.dataset.nvsId, tag);
    tag.innerHTML = d === undefined ? '<span class="nvs-dim">NVS…</span>' : chips(d);
  }

  function blockedHtml(r) {
    const code = r?.error?.code;
    if (r?.status === 401) return `<a class="nvs-link" href="${esc(r.base)}" target="_blank" rel="noopener">Entre no NVS para ver os dados ↗</a>`;
    if (code === 'FEATURE_LOCKED') return '<span class="nvs-dim">Estudo de Viabilidade ainda não liberado para a sua empresa</span>';
    if (r?.status === 409) return '<span class="nvs-dim">Conecte uma conta do Mercado Livre no NVS</span>';
    return `<span class="nvs-dim">NVS: ${esc(r?.error?.message || 'não foi possível consultar agora')}</span>`;
  }

  function showBlocked() {
    for (const tags of tagsById.values()) for (const tag of tags) tag.innerHTML = blockedHtml(blocked);
  }

  // ---------------------------------------------------------------- detalhe (modal e painel da página do anúncio)
  function chart(visits) {
    const days = visits?.daily ?? [];
    const months = visits?.monthly ?? [];
    const monthCells = months
      .map((m) => {
        const [y, mo] = m.month.split('-');
        const label = new Date(Number(y), Number(mo) - 1, 1).toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '');
        return `<div class="nvs-month"><b>${nf.format(m.total)}</b><span>${esc(label)}/${y.slice(2)}</span></div>`;
      })
      .join('');
    if (!days.length && !months.length) return '<p class="nvs-dim">Sem visitas no período.</p>';
    if (!days.length) {
      // só totais por mês: barras
      const max = Math.max(1, ...months.map((m) => m.total));
      const bars = months.map((m) => `<div class="nvs-bar-col"><div class="nvs-bar-fill" style="height:${Math.round((m.total / max) * 100)}%"></div></div>`).join('');
      return `<div class="nvs-bars">${bars}</div><div class="nvs-months">${monthCells}</div>`;
    }
    const W = 560, H = 120, P = 4;
    const max = Math.max(1, ...days.map((d) => d.total));
    const step = (W - P * 2) / Math.max(1, days.length - 1);
    const pts = days.map((d, i) => [P + i * step, H - P - (d.total / max) * (H - P * 2)]);
    const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const area = `${P},${H - P} ${line} ${(P + (days.length - 1) * step).toFixed(1)},${H - P}`;
    return `<svg class="nvs-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Visitas por dia">
        <polygon points="${area}" class="nvs-area"/><polyline points="${line}" class="nvs-line"/></svg>
      <div class="nvs-chart-meta"><span>${fmtDate(days[0].date)}</span><span>pico ${nf.format(max)}/dia</span><span>${fmtDate(days[days.length - 1].date)}</span></div>
      <div class="nvs-months">${monthCells}</div>`;
  }

  /** Dados do anúncio lidos do HTML desta própria página (quando o painel abre na página do anúncio). */
  function pageDataHere() {
    const html = document.documentElement.outerHTML;
    const sold = html.match(/\\?"sold_quantity\\?"\s*:\s*(\d+)/);
    const type = html.match(/\\?"listing_type_id\\?"\s*:\s*\\?"(\w+)/);
    return { soldQuantity: sold ? Number(sold[1]) : null, listingTypeId: type ? type[1] : null, catalog: /\/p\/MLB\d+/i.test(location.pathname) };
  }

  function detailHtml(d, p, tag) {
    const own = d.fromApi;
    const sold = own ? d.soldQuantity : p?.soldQuantity ?? null;
    const soldTxt = sold != null ? nf.format(sold) : tag?.dataset.soldText || 'não informado';
    const perDay = sold != null && d.ageDays ? sold / d.ageDays : null;
    const catalog = own ? d.catalog : p ? p.catalog : null;
    const type = own ? d.listingType : p ? TYPE_LABEL[p.listingTypeId] ?? p.listingTypeId : null;
    const created = d.createdAt
      ? d.createdAtEstimated
        ? `~${fmtMonth(d.createdAt)} (~${nf.format(d.ageDays)} dias) <span class="nvs-dim">· estimada</span>`
        : `${fmtDate(d.createdAt)} (${nf.format(d.ageDays)} dias)`
      : '—';
    const rows = [
      ['Criado em', created],
      ['Vendas', `${soldTxt}${perDay != null ? ` · ${d.createdAtEstimated ? '~' : ''}${nf2.format(perDay)}/dia` : ''}`],
      ['Tipo', `${catalog == null ? '—' : catalog ? 'Catálogo' : 'Tradicional'}${type ? ` · ${esc(type)}` : ''}`],
    ];
    if (own) {
      rows.push(
        ['Envio', `${d.logisticType === 'fulfillment' ? 'Full' : esc(d.logisticType || '—')}${d.freeShipping ? ' · frete grátis' : ''}`],
        ['Preço', d.price != null ? d.price.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '—'],
        ['Estoque', d.availableQuantity != null ? nf.format(d.availableQuantity) : '—'],
        ['Vendedor', d.seller ? `${esc(d.seller.nickname || d.seller.id)}${d.seller.reputation ? ` · ${esc(REPUTATION[d.seller.reputation] ?? d.seller.reputation)}` : ''}` : '—'],
      );
    }
    const visitsTitle = d.visits ? `Visitas · 6 meses · ${nf.format(d.visits.total)} no total` : 'Visitas';
    return `<div class="nvs-head"><b>${esc(d.title || tag?.dataset.title || document.querySelector('.ui-pdp-title, h1')?.textContent.trim() || '')}</b><span class="nvs-dim">${esc(d.itemId)}</span></div>
      <dl class="nvs-grid">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      <h4>${visitsTitle}</h4>
      ${d.visits ? chart(d.visits) : '<p class="nvs-dim">O Mercado Livre não liberou as visitas deste anúncio.</p>'}
      <p class="nvs-foot">Dados do Mercado Livre via NVS · atualizado ${new Date(d.fetchedAt).toLocaleString('pt-BR')}</p>`;
  }

  async function loadDetail(box, id, opts) {
    box.innerHTML = '<p class="nvs-dim">Carregando…</p>';
    const r = await send({ type: 'one', id });
    if (!r?.ok) {
      box.innerHTML = `<p>${blockedHtml(r)}</p>`;
      return;
    }
    let p = opts.here ? pageDataHere() : page.get(id);
    if (!r.data.fromApi && !p) {
      const pr = await send({ type: 'page', id: r.data.itemId });
      if (pr?.ok) p = pr.data;
    }
    box.innerHTML = detailHtml(r.data, p, opts.tag);
  }

  function openModal(id, tag) {
    document.querySelector('.nvs-modal')?.remove();
    const modal = document.createElement('div');
    modal.className = 'nvs-modal';
    modal.innerHTML = '<div class="nvs-card"><button class="nvs-x" aria-label="Fechar">×</button><div class="nvs-body"></div></div>';
    modal.addEventListener('click', (e) => {
      if (e.target === modal || e.target.classList.contains('nvs-x')) modal.remove();
    });
    document.body.appendChild(modal);
    loadDetail(modal.querySelector('.nvs-body'), id, { tag });
  }

  function productPanel() {
    const id = idFromHref(location.href);
    if (!id || document.querySelector('.nvs-panel')) return;
    const panel = document.createElement('aside');
    panel.className = 'nvs-panel';
    panel.innerHTML = '<div class="nvs-bar"><b>NVS · Viabilidade</b><button class="nvs-min" aria-label="Minimizar">–</button></div><div class="nvs-body"></div>';
    panel.querySelector('.nvs-min').addEventListener('click', () => panel.classList.toggle('nvs-collapsed'));
    document.body.appendChild(panel);
    loadDetail(panel.querySelector('.nvs-body'), id.item || id.product, { here: true });
  }

  // ---------------------------------------------------------------- início
  const isProductPage = /\/p\/MLB\d+/i.test(location.pathname) || /\bMLB-\d{6,}/i.test(location.pathname) || /\/up\/MLBU\d+/i.test(location.pathname);
  if (isProductPage) productPanel();
  scan();
  let scanTimer = null;
  new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 300);
  }).observe(document.body, { childList: true, subtree: true });
})();
