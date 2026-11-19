/* Теги та коментарі до статей. Підключається сервером автоматично до будь-якого звіту.
   Дані зберігаються на сервері (/api), ключ — URL статті. */
(function () {
  'use strict';
  const S = { tags: [], articles: {} };
  const tagById = () => new Map(S.tags.map(t => [t.id, t]));
  const PALETTE = ['#5A3F8C', '#FE391F', '#0F6E56', '#856404', '#1F6FB2', '#B0306A', '#2E2E2E', '#C77C02', '#3E8E7E', '#7A4FBF'];

  // ---------- API ----------
  async function req(method, url, body) {
    const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    return data;
  }
  async function loadState() {
    const d = await req('GET', '/api/state');
    S.tags = d.tags || []; S.articles = d.articles || {};
  }

  // ---------- утиліти ----------
  function textColor(hex) {
    const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) > 160 ? '#000' : '#fff';
  }
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const k in attrs || {}) {
      if (k === 'style') e.style.cssText = attrs[k];
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    }
    kids.flat().forEach(c => c != null && e.append(c));
    return e;
  }
  function nextColor() {
    const used = new Set(S.tags.map(t => t.color.toLowerCase()));
    return PALETTE.find(c => !used.has(c.toLowerCase())) || PALETTE[S.tags.length % PALETTE.length];
  }
  function toast(msg, bad) {
    const t = el('div', { class: 'ann-toast' + (bad ? ' bad' : '') }, msg);
    document.body.append(t);
    setTimeout(() => t.remove(), bad ? 5000 : 2200);
  }

  // ---------- таблиці ----------
  const TABLES = [
    { tbody: 'tbody', fn: 'apply', urlOf: r => r.dataset.url, after: 1 },
    { tbody: 'ntBody', fn: 'ntApply', urlOf: r => (r.querySelector('a[href]') || {}).href, after: 1 },
  ].filter(t => document.getElementById(t.tbody));

  const rowsByUrl = new Map(); // url -> [tr...]

  function renderChip(btn, tagId) {
    const t = tagId && tagById().get(tagId);
    btn.textContent = '';
    if (t) {
      btn.className = 'ann-tag has';
      btn.style.background = t.color; btn.style.color = textColor(t.color); btn.style.borderColor = t.color;
      btn.append(t.name);
    } else {
      btn.className = 'ann-tag';
      btn.style.background = ''; btn.style.color = ''; btn.style.borderColor = '';
      btn.append('+ тег');
    }
  }

  function paintRow(tr) {
    const url = tr._annUrl, a = S.articles[url] || {};
    const tagId = a.tag && tagById().has(a.tag) ? a.tag : '';
    tr.dataset.annTag = tagId;
    renderChip(tr._annBtn, tagId);
    if (document.activeElement !== tr._annInput) {
      tr._annInput.value = a.comment || '';
      tr._annInput.title = a.comment || '';
    }
    tr._annHidden.textContent = ' ' + (a.comment || '');
  }
  function repaintAll() { rowsByUrl.forEach(list => list.forEach(paintRow)); }

  function buildCell(tr, url) {
    const btn = el('button', { type: 'button', class: 'ann-tag', title: 'Вибрати тег', onclick: e => { e.stopPropagation(); openMenu(btn, url); } });
    const input = el('input', { type: 'text', class: 'ann-comment', placeholder: 'коментар…', maxlength: '2000' });
    const status = el('span', { class: 'ann-status' });
    const hidden = el('span', { class: 'ann-sr' });
    let timer = null, inflight = null;
    const save = async () => {
      clearTimeout(timer);
      const v = input.value.trim();
      if (v === ((S.articles[url] || {}).comment || '') || v === inflight) {
        if (status.className.includes('dirty')) status.className = 'ann-status';
        return;
      }
      inflight = v; status.className = 'ann-status saving';
      try {
        const a = await req('PUT', '/api/article', { url, comment: v });
        if (a.tag || a.comment) S.articles[url] = a; else delete S.articles[url];
        status.className = 'ann-status ok';
        (rowsByUrl.get(url) || []).forEach(r => r !== tr && paintRow(r));
        tr._annHidden.textContent = ' ' + v; input.title = v;
        setTimeout(() => { if (status.className === 'ann-status ok') status.className = 'ann-status'; }, 1500);
      } catch (err) { status.className = 'ann-status err'; toast('Коментар не збережено: ' + err.message, true); }
      finally { inflight = null; }
    };
    input.addEventListener('input', () => { status.className = 'ann-status dirty'; clearTimeout(timer); timer = setTimeout(save, 800); });
    input.addEventListener('blur', save);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
    input.addEventListener('click', e => e.stopPropagation());
    tr._annUrl = url; tr._annBtn = btn; tr._annInput = input; tr._annHidden = hidden;
    return el('td', { class: 'ann-cell' }, el('div', { class: 'ann-wrap' }, btn, el('div', { class: 'ann-cwrap' }, input, status)), hidden);
  }

  function enhanceTable(cfg) {
    const tb = document.getElementById(cfg.tbody);
    const thr = tb.closest('table').querySelector('thead tr');
    const ref = thr.children[cfg.after + 1];
    thr.insertBefore(el('th', { style: 'min-width:230px' }, '🏷 Тег · Коментар'), ref);
    for (const tr of tb.rows) {
      const url = cfg.urlOf(tr);
      if (!url) { tr.insertBefore(el('td'), tr.children[cfg.after + 1]); continue; }
      tr.insertBefore(buildCell(tr, url), tr.children[cfg.after + 1]);
      if (!rowsByUrl.has(url)) rowsByUrl.set(url, []);
      rowsByUrl.get(url).push(tr);
      paintRow(tr);
    }
    addControls(cfg, tb);
    wrapApply(cfg, tb);
  }

  // ---------- фільтр/групування ----------
  const controls = [];
  function fillFilterOptions(sel) {
    const cur = sel.value;
    sel.textContent = '';
    sel.append(el('option', { value: '' }, '🏷 Всі теги'), el('option', { value: '__none' }, '— Без тегу'), el('option', { value: '__any' }, '★ Будь-який тег'));
    S.tags.forEach(t => sel.append(el('option', { value: t.id }, '● ' + t.name)));
    sel.value = [...sel.options].some(o => o.value === cur) ? cur : '';
  }
  function addControls(cfg, tb) {
    const card = tb.closest('.card');
    const bar = card.querySelector('.filters > div') || card.querySelector('.filters');
    const sel = el('select', { class: 'ann-filter', title: 'Фільтр за тегом', onchange: () => window[cfg.fn]() });
    const grp = el('input', { type: 'checkbox', onchange: () => window[cfg.fn]() });
    const lbl = el('label', { class: 'ann-group', title: 'Сортувати спочатку за тегом (у порядку зі сторінки тегів), всередині — за обраним сортуванням' }, grp, ' ⇅ Сорт. за тегом');
    const link = el('a', { href: '/tags', class: 'ann-manage' }, '🏷 Теги');
    fillFilterOptions(sel);
    const badge = bar.querySelector('[id$="adge"]');
    [sel, lbl, link].forEach(n => badge ? bar.insertBefore(n, badge) : bar.append(n));
    cfg.sel = sel; cfg.grp = grp; cfg.badge = badge;
    controls.push(sel);
  }
  function matches(tr, f) {
    const t = tr.dataset.annTag || '';
    if (!f) return true;
    if (f === '__none') return !t;
    if (f === '__any') return !!t;
    return t === f;
  }
  function wrapApply(cfg, tb) {
    const orig = window[cfg.fn];
    if (typeof orig !== 'function') return;
    window[cfg.fn] = function () {
      const f = cfg.sel.value, group = cfg.grp.checked;
      const out = f ? [...tb.rows].filter(r => !matches(r, f)) : [];
      out.forEach(r => r.remove());
      const res = orig.apply(this, arguments);
      if (group) {
        const order = new Map(S.tags.map((t, i) => [t.id, i]));
        const vis = [...tb.rows].filter(r => r.style.display !== 'none');
        vis.map((r, i) => [r, i])
          .sort((a, b) => ((order.get(a[0].dataset.annTag) ?? 1e9) - (order.get(b[0].dataset.annTag) ?? 1e9)) || (a[1] - b[1]))
          .forEach(([r]) => tb.appendChild(r));
      }
      out.forEach(r => { r.style.display = 'none'; tb.appendChild(r); });
      if (out.length && cfg.badge) cfg.badge.textContent = cfg.badge.textContent.replace(/з \d+/, 'з ' + tb.rows.length);
      return res;
    };
  }
  function rerunActive() {
    TABLES.forEach(cfg => {
      if (cfg.sel && (cfg.sel.value || cfg.grp.checked)) window[cfg.fn]();
    });
  }

  // ---------- меню вибору тегу ----------
  let menu = null;
  function closeMenu() { if (menu) { menu.remove(); menu = null; } }
  function openMenu(anchor, url) {
    closeMenu();
    const cur = (S.articles[url] || {}).tag || '';
    const assign = async tagId => {
      closeMenu();
      try {
        const a = await req('PUT', '/api/article', { url, tag: tagId || null });
        if (a.tag || a.comment) S.articles[url] = a; else delete S.articles[url];
        (rowsByUrl.get(url) || []).forEach(paintRow);
        rerunActive();
      } catch (e) { toast('Тег не збережено: ' + e.message, true); }
    };
    const list = el('div', { class: 'ann-menu-list' });
    S.tags.forEach(t => list.append(el('button', { type: 'button', class: 'ann-mi' + (t.id === cur ? ' cur' : ''), onclick: () => assign(t.id) },
      el('span', { class: 'ann-dot', style: 'background:' + t.color }), t.name)));
    if (!S.tags.length) list.append(el('div', { class: 'ann-empty' }, 'Тегів ще немає — створіть перший нижче'));
    const newInput = el('input', { type: 'text', placeholder: 'Новий тег + Enter', maxlength: '60' });
    newInput.addEventListener('keydown', async e => {
      if (e.key === 'Escape') return closeMenu();
      if (e.key !== 'Enter' || !newInput.value.trim()) return;
      try {
        const t = await req('POST', '/api/tags', { name: newInput.value.trim(), color: nextColor() });
        S.tags.push(t); controls.forEach(fillFilterOptions);
        assign(t.id);
      } catch (err) { toast(err.message, true); }
    });
    menu = el('div', { class: 'ann-menu', onclick: e => e.stopPropagation() },
      list,
      cur ? el('button', { type: 'button', class: 'ann-mi clear', onclick: () => assign('') }, '✕ Зняти тег') : null,
      el('div', { class: 'ann-new' }, newInput),
      el('a', { href: '/tags', class: 'ann-mlink' }, '⚙ Керувати тегами →'));
    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    const top = r.bottom + window.scrollY + 4;
    const left = Math.min(r.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - menu.offsetWidth - 8);
    menu.style.top = top + 'px'; menu.style.left = Math.max(8, left) + 'px';
    const firstCur = menu.querySelector('.ann-mi.cur'); if (firstCur) firstCur.scrollIntoView({ block: 'nearest' });
  }
  document.addEventListener('click', closeMenu);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
  window.addEventListener('resize', closeMenu);

  // ---------- синхронізація між вкладками/людьми ----------
  async function refresh() {
    try { await loadState(); controls.forEach(fillFilterOptions); repaintAll(); rerunActive(); } catch (e) { /* офлайн — мовчки */ }
  }
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

  // ---------- старт ----------
  async function init() {
    try { await loadState(); }
    catch (e) { toast('Не вдалося завантажити теги/коментарі: ' + e.message, true); return; }
    TABLES.forEach(enhanceTable);
    const want = new URLSearchParams(location.search).get('tag');
    if (want && TABLES[0] && TABLES[0].sel && [...TABLES[0].sel.options].some(o => o.value === want)) {
      TABLES[0].sel.value = want; window[TABLES[0].fn]();
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
