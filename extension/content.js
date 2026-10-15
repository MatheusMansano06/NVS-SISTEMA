// Roda dentro das páginas do Mercado Livre: põe uma etiqueta (data, vendas, tipo) em cada anúncio da página
// e, na página de um anúncio, um painel com o gráfico de visitas.
// Fontes: API do NVS (data de criação e visitas; tudo, para anúncio da própria conta) e a página do anúncio
// no ML (vendas e tipo de anúncio de outro vendedor, que a API do ML não libera). Ambas via background.js.
(() => {
  const BATCH = 60; // limite da rota em lote
  const PAGE_CONCURRENCY = 3; // páginas de anúncio buscadas ao mesmo tempo (devagar, para não parecer robô)
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
        tag.innerHTML = '<div class="nvs-chips"><span class="nvs-chip nvs-cat">Catálogo</span><span class="nvs-loading">clique para ver os dados</span></div>';
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
    if (!id || pageQueued.has(id)) return;
    pageQueued.add(id);
    pageQueue.push(id);
    pumpPages();
  }

  async function pumpPages() {
    while (pageRunning < PAGE_CONCURRENCY && pageQueue.length) {
      const id = pageQueue.shift();
      // anúncio da própria conta já vem completo da API
      if (api.get(id)?.fromApi) continue;
      pageRunning++;
      send({ type: 'page', id })
        .then((r) => {
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

  /** Bloco em destaque: dias no ar, vendas e vendas/dia em números grandes; tipo e Full em chips menores. */
  function chips(d) {
    const approx = d.estimated ? '~' : '';
    const when = d.ageDays != null ? (d.estimated ? `estimado: ~${fmtMonth(d.createdAt)}` : `criado em ${fmtDate(d.createdAt)}`) : '';
    const stat = (value, label, title, dim) =>
      `<div class="nvs-stat${dim ? ' nvs-stat-dim' : ''}" title="${esc(title)}"><b>${value}</b><span>${label}</span></div>`;
    const days = d.ageDays != null ? stat(`${approx}${nf.format(d.ageDays)}`, 'dias no ar', `Dias no ar (${when})`) : stat('—', 'dias no ar', 'Sem data', true);
    const sold =
      d.sold != null
        ? stat(nf.format(d.sold), 'vendas', 'Vendas totais')
        : d.soldText
          ? stat(esc(d.soldText), 'vendas', 'Faixa de vendas mostrada pelo ML')
          : stat('…', 'vendas', 'Carregando', true);
    const perDay = d.perDay != null ? stat(`${approx}${nf2.format(d.perDay)}`, 'vendas/dia', 'Média de vendas por dia no ar') : '';
    const tags = [];
    if (d.catalog != null) tags.push(`<span class="nvs-chip ${d.catalog ? 'nvs-cat' : 'nvs-trad'}">${d.catalog ? 'Catálogo' : 'Tradicional'}</span>`);
    if (d.type) tags.push(`<span class="nvs-chip">${esc(d.type)}</span>`);
    if (d.full) tags.push('<span class="nvs-chip nvs-full">⚡ Full</span>');
    tags.push('<span class="nvs-chip nvs-btn" title="Ver mais detalhes">📈</span>');
    return `<div class="nvs-stats">${days}${sold}${perDay}</div><div class="nvs-chips">${tags.join('')}</div>`;
  }

  function renderTag(tag) {
    if (blocked) return;
    const d = merged(tag.dataset.nvsId, tag);
    tag.innerHTML = d === undefined ? '<span class="nvs-loading">NVS · carregando…</span>' : chips(d);
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
  /**
   * Um ponto por mês: média de visitas por dia naquele mês (assim o mês atual, ainda incompleto, não parece queda).
   * Vem das visitas diárias ou, sem elas, dos totais mensais.
   */
  function monthlyPoints(visits) {
    const days = [...(visits?.daily ?? [])].sort((a, b) => a.date.localeCompare(b.date));
    const today = new Date();
    if (days.length) {
      const by = new Map();
      for (const d of days) {
        const m = d.date.slice(0, 7);
        const cur = by.get(m) ?? { total: 0, n: 0 };
        cur.total += d.total;
        cur.n += 1;
        by.set(m, cur);
      }
      return [...by.entries()].map(([month, v]) => ({ month, total: v.total, days: v.n, perDay: v.total / v.n }));
    }
    return (visits?.monthly ?? []).map((m) => {
      const [y, mo] = m.month.split('-').map(Number);
      const current = y === today.getFullYear() && mo === today.getMonth() + 1;
      const n = current ? today.getDate() : new Date(y, mo, 0).getDate();
      return { month: m.month, total: m.total, days: n, perDay: m.total / n };
    });
  }

  /** Tendência: último mês contra o anterior (se o mês atual tiver menos de 7 dias, compara os dois anteriores). */
  function trend(points) {
    let pts = points;
    if (pts.length >= 3 && pts[pts.length - 1].days < 7) pts = pts.slice(0, -1);
    if (pts.length < 2) return null;
    const now = pts[pts.length - 1].perDay;
    const before = pts[pts.length - 2].perDay;
    if (!before) return now ? { cls: 'nvs-up', text: '↗ Crescendo' } : null;
    const pct = Math.round(((now - before) / before) * 100);
    if (pct > 10) return { cls: 'nvs-up', text: `↗ Crescendo +${pct}%` };
    if (pct < -10) return { cls: 'nvs-down', text: `↘ Caindo ${pct}%` };
    return { cls: 'nvs-flat', text: `→ Estável ${pct > 0 ? '+' : ''}${pct}%` };
  }

  /** Linha mês a mês (sobe, desce ou reta), com o mês embaixo e a média de visitas/dia em cada ponto. */
  function chart(visits) {
    const points = monthlyPoints(visits);
    if (!points.length) return '<p class="nvs-dim">Sem visitas no período.</p>';
    const W = 560, H = 170, L = 30, R = 30, T = 26, B = 30;
    const vals = points.map((p) => p.perDay);
    const max = Math.max(...vals);
    const min = Math.min(...vals);
    const pad = Math.max((max - min) * 0.25, max * 0.1, 0.5);
    const lo = Math.max(0, min - pad), hi = max + pad;
    const step = points.length > 1 ? (W - L - R) / (points.length - 1) : 0;
    const xy = points.map((p, i) => [points.length > 1 ? L + i * step : W / 2, T + (1 - (p.perDay - lo) / (hi - lo)) * (H - T - B)]);
    let d = `M${xy[0][0].toFixed(1)},${xy[0][1].toFixed(1)}`;
    for (let i = 0; i < xy.length - 1; i++) {
      const p0 = xy[i - 1] ?? xy[i], p1 = xy[i], p2 = xy[i + 1], p3 = xy[i + 2] ?? p2;
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
    }
    const t = trend(points);
    const label = (m) => {
      const [y, mo] = m.split('-');
      return `${new Date(Number(y), Number(mo) - 1, 1).toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '')}/${y.slice(2)}`;
    };
    const marks = points
      .map((p, i) => {
        const [x, y] = xy[i];
        const partial = i === points.length - 1 && p.days < 28 ? ' *' : '';
        return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" class="nvs-dot ${t?.cls ?? ''}"/>
          <text x="${x.toFixed(1)}" y="${(y - 10).toFixed(1)}" class="nvs-val">${nf2.format(Math.round(p.perDay * 10) / 10)}</text>
          <text x="${x.toFixed(1)}" y="${H - 8}" class="nvs-lbl">${esc(label(p.month))}${partial}</text>`;
      })
      .join('');
    const partialNote = points[points.length - 1].days < 28 ? '<span class="nvs-dim">* mês em andamento</span>' : '';
    return `<div class="nvs-trend-row">${t ? `<span class="nvs-trend ${t.cls}">${t.text}</span>` : ''}<span class="nvs-dim">visitas por dia, média de cada mês</span></div>
      <svg class="nvs-chart nvs-chart-m" viewBox="0 0 ${W} ${H}" role="img" aria-label="Visitas por mês">
        <path d="${d}" class="nvs-line ${t?.cls ?? ''}"/>${marks}</svg>
      <div class="nvs-chart-meta"><span>${partialNote}</span></div>`;
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
        ? `~${nf.format(d.ageDays)} dias <span class="nvs-dim">· estimado (~${fmtMonth(d.createdAt)})</span>`
        : `${nf.format(d.ageDays)} dias <span class="nvs-dim">· ${fmtDate(d.createdAt)}</span>`
      : '—';
    const rows = [
      ['Tempo no ar', created],
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
    const visitsTitle = d.visits ? `Visitas · últimos 150 dias · ${nf.format(d.visits.total)} no total` : 'Visitas';
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
