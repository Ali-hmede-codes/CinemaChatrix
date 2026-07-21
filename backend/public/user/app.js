/* ============================================================
   CinemaChatrix — User App (vanilla JS)
   Browse films & series, unlock with codes, and watch.

   SECURITY NOTE
   The ONLY thing this app stores on the device is a "device
   fingerprint" (a hash of stable browser characteristics). It never
   stores, caches, or displays access codes. Ownership is always
   resolved on the server from the codes bound to this device, so a
   user cannot read, copy, or fake codes from the client.
   ============================================================ */

const FP_KEY = 'cc_device_fp';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ---------------- State ---------------- */
const state = {
    fp: null,
    films: [],
    series: [],
    newly: [],
    categoryRows: [],           // [{ id, name, is_main, items:[...] }] for home rails
    catNameById: new Map(),     // id → name for all categories (main + sub)
    carousel: { index: 0, count: 0, timer: null }, // featured fade carousel
    // Ownership sets (ids), derived from the library.
    ownedMovies: new Set(),
    ownedEpisodes: new Set(),
    ownedSeriesFull: new Set(), // whole-series codes
    ownedSeriesAny: new Set(),  // any access (whole or partial)
    library: { films: [], series: [] },
    activeTab: 'home',
    // Paginated, server-searched feeds backing the Films / Series tabs.
    moviesFeed: newFeed(),
    seriesFeed: newFeed(),
    categoryFeed: newFeed(),    // films within a selected main category
    activeCategory: null,       // { id, name } while the category page is open
    mainCategories: [],         // top-level categories for the home grid
    redeemContext: null, // { target?, title } for the redeem modal
    sheetReopen: null,   // fn to re-open the current sheet after a redeem
};

/** A fresh feed descriptor for the paginated tabs. */
function newFeed() {
    return { items: [], page: 0, q: '', total: 0, loading: false, done: false };
}

/* ---------------- Formatters ---------------- */
function fmtDuration(sec) {
    if (!sec) return null;
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    if (h) return `${h}h ${m}m`;
    if (m) return `${m} min`;
    return `${Math.floor(sec)}s`;
}
function fmtClock(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return (h ? `${h}:` : '') + `${mm}:${String(s).padStart(2, '0')}`;
}
function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

/* ---------------- Toast ---------------- */
let toastTimer;
function toast(msg, type = 'ok') {
    const el = $('#toast');
    el.textContent = msg;
    el.className = `toast show ${type}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, 3400);
}

/* ---------------- Device fingerprint ---------------- */
function canvasFingerprint() {
    try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        ctx.textBaseline = 'top';
        ctx.font = "14px 'Arial'";
        ctx.fillStyle = '#f60';
        ctx.fillRect(125, 1, 62, 20);
        ctx.fillStyle = '#069';
        ctx.fillText('CinemaChatrix', 2, 15);
        return canvas.toDataURL();
    } catch {
        return 'no-canvas';
    }
}
async function computeFingerprint() {
    const parts = [
        navigator.userAgent,
        navigator.language,
        `${screen.width}x${screen.height}`,
        screen.colorDepth,
        new Date().getTimezoneOffset(),
        navigator.hardwareConcurrency || 0,
        navigator.platform || '',
        canvasFingerprint(),
    ].join('|');

    if (window.crypto && crypto.subtle) {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts));
        return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    // Fallback hash (very old browsers / insecure context)
    let h = 0;
    for (let i = 0; i < parts.length; i++) { h = (h * 31 + parts.charCodeAt(i)) >>> 0; }
    return 'fb' + h.toString(16);
}
async function getDeviceFp() {
    let fp = localStorage.getItem(FP_KEY);
    if (!fp) {
        fp = await computeFingerprint();
        localStorage.setItem(FP_KEY, fp);
    }
    return fp;
}

/* ---------------- API ---------------- */
async function api(path, { method = 'GET', body = null } = {}) {
    const res = await fetch(`/api${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : null,
    });
    let data = {};
    try { data = await res.json(); } catch { /* no body */ }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
}

/* ================================================================== */
/*  Data loading                                                       */
/* ================================================================== */

async function loadCatalog() {
    const { data } = await api('/catalog/home');
    state.films = data.films || [];
    state.series = data.series || [];
    state.newly = data.newly || [];
    const tree = data.categories || [];
    state.mainCategories = tree;              // mains (each with a `children` array)
    state.catNameById = flattenCatNames(tree);
}

/** Flatten the category tree into a Map of id → name (mains and subs). */
function flattenCatNames(tree) {
    const map = new Map();
    (function walk(nodes) {
        for (const n of nodes) {
            map.set(n.id, n.name);
            if (n.children && n.children.length) walk(n.children);
        }
    })(tree);
    return map;
}

async function loadCategoryRows() {
    try {
        const { data } = await api('/catalog/category-rows?limit=5');
        state.categoryRows = data.rows || [];
    } catch {
        state.categoryRows = []; // non-fatal — home still works without category rails
    }
}

async function loadLibrary() {
    const { data } = await api('/library', { method: 'POST', body: { device_fingerprint: state.fp } });
    state.library = { films: data.films || [], series: data.series || [] };
    state.ownedMovies = new Set(data.movie_ids || []);
    state.ownedEpisodes = new Set(data.episode_ids || []);
    state.ownedSeriesFull = new Set(data.series_ids || []);
    state.ownedSeriesAny = new Set((data.series || []).map((s) => s.id));
}

/* ---------------- Ownership helpers ---------------- */
const filmOwned = (film) => state.ownedMovies.has(film.id);
const seriesOwned = (series) => state.ownedSeriesAny.has(series.id) || state.ownedSeriesFull.has(series.id);
const episodeOwned = (ep, seriesId) => state.ownedSeriesFull.has(seriesId) || state.ownedEpisodes.has(ep.id);

/* ================================================================== */
/*  Rendering — cards                                                  */
/* ================================================================== */

function cardHtml(item, i = 0) {
    const owned = item.type === 'film' ? filmOwned(item) : seriesOwned(item);
    const locked = !owned;
    const sub = item.type === 'film'
        ? (fmtDuration(item.duration) || item.quality || 'Film')
        : `${item.episode_count || 0} episode${item.episode_count === 1 ? '' : 's'}`;

    const badge = locked
        ? `<span class="badge badge-lock">Ticket Req.</span>`
        : `<span class="badge badge-owned">Admitted</span>`;

    // Up to 2 category chips. Items inside a category's own rail carry no
    // `categories` (set server-side), so no redundant tags show there.
    const cats = (item.categories || []).slice(0, 2)
        .map((c) => `<span class="card-cat" dir="auto">${esc(c.name)}</span>`).join('');

    return `
        <div class="card ${locked ? 'locked' : ''}" style="--i:${i}" data-type="${item.type}" data-slug="${esc(item.slug)}" data-id="${item.id}">
            <div class="card-poster">
                <img src="${esc(item.poster)}" alt="${esc(item.title)}" loading="lazy"
                     onerror="this.src='/static/images/default_image.png'" />
                <div class="card-scrim"></div>
                <span class="badge badge-type">${item.type === 'film' ? 'Film' : 'Series'}</span>
                ${badge}
                <div class="card-overlay">
                    <div class="card-title" dir="auto">${esc(item.title)}</div>
                    <div class="card-metarow">
                        <span class="card-sub">${esc(sub)}</span>
                        ${cats}
                    </div>
                </div>
            </div>
        </div>`;
}

function renderCardsInto(container, items, emptyMsg) {
    if (!items.length) {
        container.innerHTML = `
            <div class="grid-empty">
                <div class="ico"><svg viewBox="0 0 48 48" width="42" height="42" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 14a2 2 0 0 1 2-2h32a2 2 0 0 1 2 2v5a3 3 0 0 0 0 6v5a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-5a3 3 0 0 0 0-6v-5Z"/><path d="M28 12v24" stroke-dasharray="3 3"/></svg></div>
                <h3>${esc(emptyMsg.title)}</h3>
                <p>${esc(emptyMsg.body)}</p>
            </div>`;
        return;
    }
    container.innerHTML = items.map(cardHtml).join('');
}

/* ---------------- Home ---------------- */
function renderHome() {
    renderCarousel();
    renderMainCategories();
    $('#rail-new').innerHTML = state.newly.map((it, i) => cardHtml(it, i)).join('')
        || `<p class="card-sub">Nothing showing yet.</p>`;
    renderCategoryRows();
}

/* ---------------- Featured carousel (auto cross-fade) ---------------- */
function renderCarousel() {
    const el = $('#home-carousel');
    if (!el) return;
    const items = state.newly.slice(0, 6);
    stopCarousel();
    if (!items.length) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    el.classList.remove('hidden');

    const slides = items.map((it, i) => {
        const owned = it.type === 'film' ? filmOwned(it) : seriesOwned(it);
        const cats = (it.categories || []).slice(0, 3)
            .map((c) => `<span class="cr-chip" dir="auto">${esc(c.name)}</span>`).join('');
        return `
            <div class="cr-slide${i === 0 ? ' active' : ''}" data-type="${it.type}" data-slug="${esc(it.slug)}" data-id="${it.id}">
                <img class="cr-ambient" src="${esc(it.poster)}" alt="" aria-hidden="true"
                     onerror="this.src='/static/images/default_image.png'" />
                <div class="cr-ambient-scrim"></div>
                <div class="cr-poster-wrap">
                    <img class="cr-poster" src="${esc(it.poster)}" alt="${esc(it.title)}"
                         onerror="this.src='/static/images/default_image.png'" />
                </div>
                <div class="cr-body">
                    <span class="cr-badge">${owned ? 'In your library' : 'Now Showing'}</span>
                    <div class="cr-title" dir="auto">${esc(it.title)}</div>
                    ${cats ? `<div class="cr-cats">${cats}</div>` : ''}
                    <div class="cr-cta"><span class="cr-play">▶</span>${it.type === 'film' ? 'Watch film' : 'Browse series'}</div>
                </div>
            </div>`;
    }).join('');

    const dots = items.length > 1
        ? `<div class="cr-dots">${items.map((_, i) =>
            `<button class="cr-dot${i === 0 ? ' active' : ''}" data-dot="${i}" aria-label="Featured ${i + 1}"></button>`).join('')}</div>`
        : '';

    el.innerHTML = `<div class="cr-track">${slides}</div>${dots}`;
    state.carousel.index = 0;
    state.carousel.count = items.length;
    startCarousel();
}

function startCarousel() {
    stopCarousel();
    if (state.carousel.count > 1 && state.activeTab === 'home') {
        state.carousel.timer = setInterval(() => goToSlide(state.carousel.index + 1), 5200);
    }
}
function stopCarousel() {
    if (state.carousel.timer) clearInterval(state.carousel.timer);
    state.carousel.timer = null;
}

/** Show slide `i` (wraps around) and sync the dots. */
function goToSlide(i) {
    const el = $('#home-carousel');
    const n = state.carousel.count;
    if (!el || !n) return;
    const idx = ((i % n) + n) % n;
    state.carousel.index = idx;
    const track = $('.cr-track', el);
    if (track) track.style.transform = `translateX(-${idx * 100}%)`;
    $$('.cr-slide', el).forEach((s, si) => s.classList.toggle('active', si === idx));
    $$('.cr-dot', el).forEach((d, di) => d.classList.toggle('active', di === idx));
}

/* ---------------- Browse-by-category rails ---------------- */
function renderCategoryRows() {
    const box = $('#home-category-rows');
    if (!box) return;
    // Only sub-categories are shown (e.g. "Action"); the parent main category is
    // rendered as a small superscript beside the sub's name — no main-only rails.
    const rows = (state.categoryRows || []).filter((row) => !row.is_main);
    if (!rows.length) { box.innerHTML = ''; return; }
    box.innerHTML = rows.map((row) => {
        const parentName = row.parent_name || state.catNameById.get(row.parent_id) || '';
        const sup = parentName ? `<sup class="cat-parent" dir="auto">${esc(parentName)}</sup>` : '';
        return `
        <div class="rail-block cat-rail cat-sub">
            <div class="rail-head"><h2 dir="auto">${esc(row.name)}${sup}</h2></div>
            <div class="rail">${row.items.map((it, i) => cardHtml(it, i)).join('')}</div>
        </div>`;
    }).join('');
}

/* ---------------- Main categories grid (home browse) ---------------- */
function renderMainCategories() {
    const box = $('#home-main-categories');
    const block = $('#home-categories-block');
    if (!box) return;
    const mains = state.mainCategories || [];
    if (!mains.length) { if (block) block.classList.add('hidden'); box.innerHTML = ''; return; }
    if (block) block.classList.remove('hidden');
    box.innerHTML = mains.map((c) => `
        <button class="cat-chip-btn" data-cat-id="${c.id}" data-cat-name="${esc(c.name)}" dir="auto">
            <span class="cat-chip-name">${esc(c.name)}</span>
            <svg class="cat-chip-arrow" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8.6 16.6 13.2 12 8.6 7.4 10 6l6 6-6 6z"/></svg>
        </button>`).join('');
}

/* ---------------- Movies / Series tabs ---------------- */
/* These are handled by the paginated feed system further below. */

/* ---------------- Library ---------------- */
function renderLibrary() {
    const items = [...state.library.films, ...state.library.series];
    renderCardsInto($('#library-grid'), items, {
        title: 'Your library is empty',
        body: "Got a code? Tap “Add with code” and it'll appear here — unlocked on this device.",
    });
}

function renderAll() {
    renderHome();
    // Re-render already-loaded feeds in place so ownership badges refresh
    // (e.g. after redeeming a code) without re-fetching from the server.
    if (state.moviesFeed.page) rerenderFeed('film');
    if (state.seriesFeed.page) rerenderFeed('series');
    if (state.categoryFeed.page) rerenderFeed('category');
    renderLibrary();
}

/* ================================================================== */
/*  Paginated feeds (Films / Series) — infinite scroll + server search */
/* ================================================================== */

const PAGE_SIZE = 24;

/** Resolve the DOM + state handles for a feed kind ('film' | 'series'). */
function feedRefs(kind) {
    if (kind === 'series') {
        return { feed: state.seriesFeed, grid: $('#series-grid'), statusEl: $('#series-status'), endpoint: '/catalog/series', dataKey: 'series' };
    }
    if (kind === 'category') {
        return { feed: state.categoryFeed, grid: $('#category-grid'), statusEl: $('#category-status'), endpoint: '/catalog/films', dataKey: 'films' };
    }
    return { feed: state.moviesFeed, grid: $('#movies-grid'), statusEl: $('#movies-status'), endpoint: '/catalog/films', dataKey: 'films' };
}

/** A shimmering placeholder card shown while a page is loading. */
function skeletonCardHtml() {
    return `
        <div class="card card-skeleton" aria-hidden="true">
            <div class="card-poster skeleton"></div>
        </div>`;
}
function appendSkeletons(grid, n) {
    grid.insertAdjacentHTML('beforeend', Array.from({ length: n }, skeletonCardHtml).join(''));
}
function removeSkeletons(grid) {
    grid.querySelectorAll('.card-skeleton').forEach((el) => el.remove());
}

/** Empty-state markup for a feed with no results. */
function feedEmptyHtml(kind, q) {
    const noun = kind === 'series' ? 'series' : 'films';
    return `
        <div class="grid-empty">
            <div class="ico">${q
                ? `<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`
                : `<svg viewBox="0 0 48 48" width="42" height="42" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 14a2 2 0 0 1 2-2h32a2 2 0 0 1 2 2v5a3 3 0 0 0 0 6v5a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-5a3 3 0 0 0 0-6v-5Z"/><path d="M28 12v24" stroke-dasharray="3 3"/></svg>`}</div>
            <h3>${q ? `No ${noun} match` : `No ${noun} yet`}</h3>
            <p>${q ? 'Try a different search term.' : 'Check back soon for new titles.'}</p>
        </div>`;
}

/** Load the next page of a feed (or reset to page 1 for a new search). */
async function loadFeed(kind, { reset = false } = {}) {
    const { feed, grid, endpoint, dataKey } = feedRefs(kind);
    if (feed.loading) return;
    if (reset) {
        feed.items = [];
        feed.page = 0;
        feed.total = 0;
        feed.done = false;
        grid.innerHTML = '';
    }
    if (feed.done) return;

    feed.loading = true;
    renderFeedStatus(kind);
    appendSkeletons(grid, feed.items.length ? 6 : 12);

    try {
        const params = new URLSearchParams({ page: String(feed.page + 1), limit: String(PAGE_SIZE) });
        if (feed.q) params.set('q', feed.q);
        if (feed.categoryId) params.set('category', String(feed.categoryId));
        const { data } = await api(`${endpoint}?${params}`);
        const items = data[dataKey] || [];

        removeSkeletons(grid);
        feed.page = data.page || feed.page + 1;
        feed.total = data.total || 0;
        feed.done = !data.has_more;
        feed.items.push(...items);

        // Append with a fresh stagger index so each new batch animates in.
        grid.insertAdjacentHTML('beforeend', items.map((it, i) => cardHtml(it, i)).join(''));
        if (!feed.items.length) grid.innerHTML = feedEmptyHtml(kind, feed.q);
    } catch (err) {
        removeSkeletons(grid);
        toast(err.message, 'err');
        feed.done = true; // don't hammer a failing endpoint on every scroll tick
    } finally {
        feed.loading = false;
        renderFeedStatus(kind);
        // If the freshly loaded page still doesn't fill the screen, keep going.
        if (!feed.done && sentinelVisible(kind)) setTimeout(() => loadFeed(kind), 60);
    }
}

/** Rebuild a loaded feed's cards in place (refreshes ownership badges). */
function rerenderFeed(kind) {
    const { feed, grid } = feedRefs(kind);
    if (!feed.items.length) {
        grid.innerHTML = feed.page ? feedEmptyHtml(kind, feed.q) : '';
        return;
    }
    grid.innerHTML = feed.items.map((it, i) => cardHtml(it, i)).join('');
}

/** The line under a grid: a spinner while loading, an "end" note when done. */
function renderFeedStatus(kind) {
    const { feed, statusEl } = feedRefs(kind);
    if (feed.loading) {
        statusEl.innerHTML = `<span class="feed-spin"></span>Loading…`;
    } else if (feed.items.length && feed.done) {
        statusEl.textContent = `That's everything — ${feed.total} ${feed.total === 1 ? 'title' : 'titles'}.`;
    } else {
        statusEl.textContent = '';
    }
}

/** Is a feed's sentinel currently within (or near) the viewport? */
function sentinelVisible(kind) {
    const s = kind === 'series' ? $('#series-sentinel')
        : kind === 'category' ? $('#category-sentinel')
        : $('#movies-sentinel');
    if (!s || s.offsetParent === null) return false; // sentinel is in a hidden tab
    const r = s.getBoundingClientRect();
    return r.top < window.innerHeight + 400 && r.bottom > -400;
}

/** Wire IntersectionObservers so scrolling near a sentinel loads more. */
function setupInfiniteScroll() {
    const obs = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (entry.isIntersecting) loadFeed(entry.target.dataset.kind);
        });
    }, { rootMargin: '400px 0px' });

    const ms = $('#movies-sentinel'); ms.dataset.kind = 'film'; obs.observe(ms);
    const ss = $('#series-sentinel'); ss.dataset.kind = 'series'; obs.observe(ss);
    const cs = $('#category-sentinel'); if (cs) { cs.dataset.kind = 'category'; obs.observe(cs); }
}

/** Debounce a function by `ms` milliseconds. */
function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* ================================================================== */
/*  Tab navigation                                                     */
/* ================================================================== */

function switchTab(tab) {
    state.activeTab = tab;
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.view').forEach((v) => v.classList.add('hidden'));
    $(`#view-${tab}`).classList.remove('hidden');

    // Lazily load a paginated tab the first time it's opened.
    if (tab === 'movies' && !state.moviesFeed.page && !state.moviesFeed.loading) loadFeed('film', { reset: true });
    if (tab === 'series' && !state.seriesFeed.page && !state.seriesFeed.loading) loadFeed('series', { reset: true });

    // The featured carousel only ticks while Home is on screen.
    if (tab === 'home') startCarousel(); else stopCarousel();

    $('#views').scrollTo({ top: 0 });
    window.scrollTo({ top: 0 });
}

/* Open the dedicated page listing all films within a main category. */
function openCategory(id, name) {
    id = Number(id);
    if (!id) return;
    state.activeCategory = { id, name };
    state.activeTab = 'category';
    state.categoryFeed = newFeed();
    state.categoryFeed.categoryId = id;

    $('#category-title').textContent = name || 'Category';
    $('#category-search').value = '';

    $$('.view').forEach((v) => v.classList.add('hidden'));
    $('#view-category').classList.remove('hidden');
    // Category browsing lives under Home — keep Home marked active in the nav.
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'home'));
    stopCarousel();

    $('#views').scrollTo({ top: 0 });
    window.scrollTo({ top: 0 });
    loadFeed('category', { reset: true });
}

/* ================================================================== */
/*  Detail sheet                                                       */
/* ================================================================== */

const sheetRoot = $('#sheet-root');
function openSheet(html) {
    $('#sheet-body').innerHTML = html;
    sheetRoot.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
}
function closeSheet() {
    sheetRoot.classList.add('hidden');
    document.body.style.overflow = '';
    state.sheetReopen = null;
}

async function openFilm(slug) {
    let film;
    try {
        const { data } = await api(`/catalog/film/${encodeURIComponent(slug)}`);
        film = data.film;
    } catch (e) { return toast(e.message, 'err'); }

    const owned = filmOwned(film);
    state.sheetReopen = () => openFilm(slug);

    const metaChips = [
        fmtDuration(film.duration) ? `<span class="chip">${fmtDuration(film.duration)}</span>` : '',
        film.quality ? `<span class="chip">${esc(film.quality)}</span>` : '',
        owned ? `<span class="chip owned">Admitted</span>` : `<span class="chip locked">Ticket required</span>`,
        ...(film.categories || []).map((c) => `<span class="chip cat" dir="auto">${esc(c.name)}</span>`),
    ].join('');

    const action = owned
        ? `<button class="btn btn-primary" data-play data-type="film" data-slug="${esc(film.slug)}" data-id="${film.id}" data-title="${esc(film.title)}">► Play</button>`
        : lockPanelHtml('film', { movie_id: film.id }, film.title);

    openSheet(`
        <div class="detail-hero">
            <img class="detail-hero-bg" src="${esc(film.poster)}" alt="" aria-hidden="true" onerror="this.src='/static/images/default_image.png'" />
            <div class="detail-hero-scrim"></div>
            <img class="detail-hero-poster" src="${esc(film.poster)}" alt="${esc(film.title)}" onerror="this.src='/static/images/default_image.png'" />
        </div>
        <div class="detail-content">
            <div class="detail-title" dir="auto">${esc(film.title)}</div>
            <div class="detail-meta">${metaChips}</div>
            ${owned ? `<div class="detail-actions">${action}</div>` : action}
            ${film.description ? `<p class="detail-desc" dir="auto">${esc(film.description)}</p>` : ''}
        </div>`);
}

async function openSeries(slug) {
    let series, episodes;
    try {
        const { data } = await api(`/catalog/series/${encodeURIComponent(slug)}`);
        series = data.series;
        episodes = data.episodes || [];
    } catch (e) { return toast(e.message, 'err'); }

    state.sheetReopen = () => openSeries(slug);
    const fullyOwned = state.ownedSeriesFull.has(series.id);
    const anyOwned = seriesOwned(series);

    // Group episodes by season
    const bySeason = {};
    episodes.forEach((ep) => { (bySeason[ep.season_number] ||= []).push(ep); });

    let epHtml = '';
    Object.keys(bySeason).sort((a, b) => a - b).forEach((season) => {
        epHtml += `<div class="season-head">Season ${esc(season)}</div><div class="ep-list">`;
        bySeason[season].forEach((ep) => {
            const unlocked = episodeOwned(ep, series.id);
            epHtml += `
                <div class="ep ${unlocked ? '' : 'locked'}"
                     ${unlocked ? `data-play data-type="episode" data-slug="${esc(ep.slug)}" data-id="${ep.id}" data-title="${esc(series.title)} · ${esc(ep.title)}"` : `data-ep-lock data-ep-id="${ep.id}" data-ep-title="${esc(ep.title)}"`}>
                    <div class="ep-thumb">
                        <img src="${esc(ep.thumbnail)}" alt="" onerror="this.src='/static/images/default_image.png'" />
                        ${unlocked
                            ? `<span class="ep-play"><svg viewBox="0 0 24 24" width="26" height="26"><path fill="currentColor" d="M8 5v14l11-7z"/></svg></span>`
                            : `<span class="ep-lock"><svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5Zm-3 8V7a3 3 0 0 1 6 0v3H9Z"/></svg></span>`}
                    </div>
                    <div class="ep-info">
                        <div class="ep-no">E${esc(ep.episode_number)}</div>
                        <div class="ep-title" dir="auto">${esc(ep.title)}</div>
                        <div class="ep-dur">${fmtDuration(ep.duration) || (unlocked ? 'Ready to play' : 'Locked')}</div>
                    </div>
                </div>`;
        });
        epHtml += `</div>`;
    });

    const statusChip = fullyOwned
        ? `<span class="chip owned">Full series admitted</span>`
        : anyOwned
            ? `<span class="chip owned">Some episodes admitted</span>`
            : `<span class="chip locked">Ticket required</span>`;

    const catChips = (series.categories || [])
        .map((c) => `<span class="chip cat" dir="auto">${esc(c.name)}</span>`).join('');

    const unlockPanel = fullyOwned ? '' : lockPanelHtml('series', { series_id: series.id }, series.title,
        anyOwned ? 'Have another code? Unlock more episodes or the whole series.' : null);

    openSheet(`
        <div class="detail-hero">
            <img class="detail-hero-bg" src="${esc(series.poster)}" alt="" aria-hidden="true" onerror="this.src='/static/images/default_image.png'" />
            <div class="detail-hero-scrim"></div>
            <img class="detail-hero-poster" src="${esc(series.poster)}" alt="${esc(series.title)}" onerror="this.src='/static/images/default_image.png'" />
        </div>
        <div class="detail-content">
            <div class="detail-title" dir="auto">${esc(series.title)}</div>
            <div class="detail-meta">
                <span class="chip">${series.episode_count} episode${series.episode_count === 1 ? '' : 's'}</span>
                ${statusChip}
                ${catChips}
            </div>
            ${series.description ? `<p class="detail-desc" dir="auto">${esc(series.description)}</p>` : ''}
            ${unlockPanel}
            ${epHtml || '<p class="detail-desc">No episodes yet.</p>'}
        </div>`);
}

/** A reusable "locked — enter a code" panel used in film/series sheets. */
function lockPanelHtml(kind, target, title, customMsg) {
    const msg = customMsg || (kind === 'series'
        ? 'Enter your access code to unlock this series on this device.'
        : 'Enter your access code to unlock this on this device.');
    const targetAttr = encodeURIComponent(JSON.stringify(target));
    return `
        <div class="lock-panel">
            <div class="lock-ico"><svg viewBox="0 0 24 24" width="26" height="26"><path fill="currentColor" d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5Zm-3 8V7a3 3 0 0 1 6 0v3H9Z"/></svg></div>
            <h4>Ticket required</h4>
            <p>${esc(msg)}</p>
            <button class="btn btn-primary btn-block" data-open-redeem="${targetAttr}" data-redeem-title="${esc(title)}">Enter code</button>
        </div>`;
}

/* ================================================================== */
/*  Redeem code                                                        */
/* ================================================================== */

const redeemRoot = $('#redeem-root');
function openRedeem(context = null) {
    state.redeemContext = context;
    $('#redeem-hint').textContent = context && context.title
        ? `Enter the code for “${context.title}”. It unlocks on this device only.`
        : 'Enter your access code. Tip: open the film or series you want first, then enter the code to unlock it here.';
    $('#redeem-input').value = '';
    redeemRoot.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    setTimeout(() => $('#redeem-input').focus(), 60);
}
function closeRedeem() {
    redeemRoot.classList.add('hidden');
    if (sheetRoot.classList.contains('hidden')) document.body.style.overflow = '';
}

async function submitRedeem(e) {
    e.preventDefault();
    const raw = $('#redeem-input').value.trim();
    if (!raw) return toast('Enter a code first', 'warn');

    const btn = $('#redeem-submit');
    btn.disabled = true;
    btn.textContent = 'Unlocking…';

    const body = { code: raw, device_fingerprint: state.fp };
    if (state.redeemContext && state.redeemContext.target) {
        Object.assign(body, state.redeemContext.target);
    }

    try {
        const { data, message } = await api('/codes/redeem', { method: 'POST', body });
        const label = data && data.target && data.target.title ? data.target.title : 'Content';
        toast(data && data.already_unlocked ? `Already in your library: ${label}` : `Admit one — ${label} unlocked`, 'ok');
        closeRedeem();
        await loadLibrary();
        renderAll();
        // Refresh the open sheet (its lock state may have changed).
        if (state.sheetReopen) state.sheetReopen();
    } catch (err) {
        toast(err.message, 'err');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Unlock';
    }
}

/* Auto-format the code input as CHX-XXXX-XXXX-XXXX while typing.
   Still accepts shorter legacy codes (CHX-XXXX-XXXX). */
function formatCodeInput(el) {
    let v = el.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (v.length > 15) v = v.slice(0, 15);   // CHX + 12 body chars
    let out = v;
    if (v.length > 3) out = v.slice(0, 3) + '-' + v.slice(3);
    if (v.length > 7) out = v.slice(0, 3) + '-' + v.slice(3, 7) + '-' + v.slice(7);
    if (v.length > 11) out = v.slice(0, 3) + '-' + v.slice(3, 7) + '-' + v.slice(7, 11) + '-' + v.slice(11);
    el.value = out;
}

/* ================================================================== */
/*  Player                                                             */
/* ================================================================== */

const player = {
    root: $('#player-root'),
    stage: $('#player-stage'),
    video: $('#player-video'),
    ui: $('#player-ui'),
    status: $('#player-status'),
    statusText: $('#player-status-text'),
    progress: $('#pl-progress'),
    cur: $('#pl-cur'),
    dur: $('#pl-dur'),
    playIco: $('#pl-play-ico'),
    bigPlay: $('#pl-bigplay'),
    muteIco: $('#pl-mute-ico'),
    rateBtn: $('#pl-rate'),
    title: $('#pl-title'),
    ctx: null,          // { type, slug, id, title }
    saveTimer: null,
    idleTimer: null,
    seeking: false,
};

const RATES = [1, 1.25, 1.5, 2, 0.5];
const PLAY_SVG = '<path fill="currentColor" d="M8 5v14l11-7z"/>';
const PAUSE_SVG = '<path fill="currentColor" d="M6 5h4v14H6zM14 5h4v14h-4z"/>';

async function openPlayer(ctx) {
    player.ctx = ctx;
    player.title.textContent = ctx.title || '';
    player.root.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    player.status.classList.remove('hidden');
    player.statusText.textContent = 'Preparing secure stream…';
    player.bigPlay.classList.add('hidden');

    try {
        // 1. Get a short-lived, scoped stream ticket (verifies access server-side).
        const { data } = await api('/watch/authorize', {
            method: 'POST',
            body: { device_fingerprint: state.fp, type: ctx.type, slug: ctx.slug },
        });
        const src = `/api/watch/stream/${ctx.type}/${encodeURIComponent(ctx.slug)}?token=${encodeURIComponent(data.token)}`;
        player.video.src = src;

        // 2. Fetch resume position.
        let resumeAt = 0;
        try {
            const idKey = ctx.type === 'film' ? { movie_id: ctx.id } : { episode_id: ctx.id };
            const prog = await api('/watch/progress/get', {
                method: 'POST',
                body: { device_fingerprint: state.fp, ...idKey },
            });
            if (prog.data && prog.data.current_time > 5 && !prog.data.is_completed) {
                resumeAt = prog.data.current_time;
            }
        } catch { /* progress is best-effort */ }

        player.video.load();
        player.video.onloadedmetadata = () => {
            if (resumeAt > 0 && resumeAt < player.video.duration) {
                player.video.currentTime = resumeAt;
                toast('Resuming where you left off', 'ok');
            }
            player.status.classList.add('hidden');
            player.video.play().catch(() => {
                // Autoplay blocked — show the big play button.
                player.bigPlay.classList.remove('hidden');
            });
        };
        player.video.onerror = () => {
            player.statusText.textContent = 'This video could not be played.';
            player.status.classList.remove('hidden');
        };

        startProgressSaver();
    } catch (err) {
        player.statusText.textContent = err.message || 'Could not start playback.';
        toast(err.message, 'err');
    }
}

function closePlayer() {
    saveProgressNow();
    stopProgressSaver();
    player.video.pause();
    player.video.removeAttribute('src');
    player.video.load();
    player.root.classList.add('hidden');
    player.ctx = null;
    exitFullscreen();
    player.root.classList.remove('pseudo-fs');
    document.body.style.overflow = sheetRoot.classList.contains('hidden') ? '' : 'hidden';
}

/* ---- Progress persistence ---- */
function saveProgressNow() {
    const v = player.video;
    if (!player.ctx || !v.duration || v.currentTime < 3) return;
    const idKey = player.ctx.type === 'film' ? { movie_id: player.ctx.id } : { episode_id: player.ctx.id };
    // Fire-and-forget; keepalive lets it complete during unload.
    fetch('/api/watch/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
            device_fingerprint: state.fp,
            ...idKey,
            current_time: v.currentTime,
            duration: v.duration,
        }),
    }).catch(() => {});
}
function startProgressSaver() {
    stopProgressSaver();
    player.saveTimer = setInterval(() => { if (!player.video.paused) saveProgressNow(); }, 10000);
}
function stopProgressSaver() {
    if (player.saveTimer) clearInterval(player.saveTimer);
    player.saveTimer = null;
}

/* ---- Controls ---- */
function togglePlay() {
    if (player.video.paused) player.video.play(); else player.video.pause();
}
function syncPlayIcons() {
    const paused = player.video.paused;
    player.playIco.innerHTML = paused ? PLAY_SVG : PAUSE_SVG;
    player.bigPlay.classList.toggle('hidden', !paused);
}
function updateSeek() {
    if (player.seeking) return;
    const v = player.video;
    const pct = v.duration ? (v.currentTime / v.duration) * 1000 : 0;
    player.progress.value = pct;
    player.cur.textContent = fmtClock(v.currentTime);
    player.dur.textContent = fmtClock(v.duration || 0);
}
function showUi() {
    player.ui.classList.remove('idle');
    clearTimeout(player.idleTimer);
    player.idleTimer = setTimeout(() => {
        if (!player.video.paused) player.ui.classList.add('idle');
    }, 3200);
}

/* ---- Fullscreen (cross-device) ----
   Fullscreen behaves very differently across devices, so we try, in order:
     1. The standard Fullscreen API on the whole stage — desktop, Android,
        iPad and modern smart-TVs. This keeps our own controls on screen.
        Older TV browsers expose it only behind a webkit/moz/ms prefix.
     2. iPhone (iOS Safari) supports NO element fullscreen — the only way in
        is the native video method webkitEnterFullscreen(), which shows
        Apple's built-in controls. This is what fixes iPhone.
     3. Very old TV browsers with no Fullscreen API at all fall back to a CSS
        "pseudo fullscreen" that simply pins the player above everything. */
function fsElement() {
    return document.fullscreenElement
        || document.webkitFullscreenElement
        || document.webkitCurrentFullScreenElement
        || document.mozFullScreenElement
        || document.msFullscreenElement
        || null;
}
function requestElementFs(el) {
    const fn = el.requestFullscreen
        || el.webkitRequestFullscreen
        || el.webkitRequestFullScreen
        || el.mozRequestFullScreen
        || el.msRequestFullscreen;
    return fn ? fn.call(el) : null;
}
function exitDocumentFs() {
    const fn = document.exitFullscreen
        || document.webkitExitFullscreen
        || document.webkitCancelFullScreen
        || document.mozCancelFullScreen
        || document.msExitFullscreen;
    return fn ? fn.call(document) : null;
}

/** True when the player is fullscreen by ANY of the three mechanisms. */
function isPlayerFullscreen() {
    return !!fsElement()
        || !!player.video.webkitDisplayingFullscreen
        || player.root.classList.contains('pseudo-fs');
}

/** iOS-only native video fullscreen. Returns true if it was invoked. */
function enterVideoFullscreen(v) {
    const enter = v.webkitEnterFullscreen || v.webkitEnterFullScreen;
    if (enter) {
        try { enter.call(v); return true; } catch { /* metadata not ready yet */ }
    }
    return false;
}

function enterFullscreen() {
    const v = player.video;
    // 1. Standard element fullscreen (keeps our custom controls visible).
    if (player.stage.requestFullscreen || player.stage.webkitRequestFullscreen
        || player.stage.webkitRequestFullScreen || player.stage.mozRequestFullScreen
        || player.stage.msRequestFullscreen) {
        try {
            const p = requestElementFs(player.stage);
            if (p && typeof p.catch === 'function') p.catch(() => { if (!enterVideoFullscreen(v)) pseudoFs(true); });
            return;
        } catch { /* fall through to the video / CSS fallbacks */ }
    }
    // 2. iPhone: native video fullscreen.
    if (enterVideoFullscreen(v)) return;
    // 3. Ancient TV browsers: CSS pseudo-fullscreen.
    pseudoFs(true);
}

function exitFullscreen() {
    if (fsElement()) { try { exitDocumentFs(); } catch { /* ignore */ } return; }
    const v = player.video;
    if (v.webkitDisplayingFullscreen && v.webkitExitFullscreen) {
        try { v.webkitExitFullscreen(); } catch { /* ignore */ }
        return;
    }
    pseudoFs(false);
}

function pseudoFs(on) {
    player.root.classList.toggle('pseudo-fs', on);
    syncFsButton();
}

function toggleFullscreen() {
    if (isPlayerFullscreen()) exitFullscreen(); else enterFullscreen();
}

const FS_ENTER_SVG = 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z';
const FS_EXIT_SVG = 'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z';

/** Keep the fullscreen button's icon + label in sync with the real state. */
function syncFsButton() {
    const ico = $('#pl-fs-ico');
    const btn = $('#pl-fs');
    if (!ico || !btn) return;
    const on = isPlayerFullscreen();
    ico.setAttribute('d', on ? FS_EXIT_SVG : FS_ENTER_SVG);
    btn.setAttribute('aria-label', on ? 'Exit fullscreen' : 'Fullscreen');
}

function initPlayerControls() {
    const v = player.video;
    v.addEventListener('timeupdate', updateSeek);
    v.addEventListener('play', syncPlayIcons);
    v.addEventListener('pause', () => { syncPlayIcons(); saveProgressNow(); });
    v.addEventListener('ended', () => { saveProgressNow(); player.ui.classList.remove('idle'); });
    v.addEventListener('volumechange', () => {
        player.muteIco.style.opacity = v.muted || v.volume === 0 ? '0.45' : '1';
    });

    $('#pl-close').addEventListener('click', closePlayer);
    $('#pl-play').addEventListener('click', togglePlay);
    player.bigPlay.addEventListener('click', togglePlay);
    $('#pl-back').addEventListener('click', () => { v.currentTime = Math.max(0, v.currentTime - 10); });
    $('#pl-fwd').addEventListener('click', () => { v.currentTime = Math.min(v.duration || 0, v.currentTime + 10); });
    $('#pl-mute').addEventListener('click', () => { v.muted = !v.muted; });

    player.rateBtn.addEventListener('click', () => {
        const i = RATES.indexOf(v.playbackRate);
        const next = RATES[(i + 1) % RATES.length];
        v.playbackRate = next;
        player.rateBtn.textContent = `${next}×`;
    });

    $('#pl-fs').addEventListener('click', toggleFullscreen);

    // Keep the fullscreen icon/state correct no matter how it changed: our
    // button, the keyboard, iOS's native gesture, or a TV remote's Back key.
    ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange']
        .forEach((ev) => document.addEventListener(ev, syncFsButton));
    v.addEventListener('webkitbeginfullscreen', syncFsButton);
    v.addEventListener('webkitendfullscreen', syncFsButton);
    syncFsButton();

    // Seek slider
    const startSeek = () => { player.seeking = true; };
    const doSeek = () => {
        if (player.video.duration) {
            player.cur.textContent = fmtClock((player.progress.value / 1000) * player.video.duration);
        }
    };
    const endSeek = () => {
        if (player.video.duration) {
            player.video.currentTime = (player.progress.value / 1000) * player.video.duration;
        }
        player.seeking = false;
    };
    player.progress.addEventListener('input', () => { startSeek(); doSeek(); });
    player.progress.addEventListener('change', endSeek);

    // Show controls on interaction; auto-hide while playing.
    ['mousemove', 'touchstart', 'click'].forEach((ev) =>
        player.stage.addEventListener(ev, showUi));

    // Tapping the video toggles play (but not when tapping a control).
    v.addEventListener('click', (e) => { e.stopPropagation(); togglePlay(); });

    // Keyboard shortcuts when the player is open.
    document.addEventListener('keydown', (e) => {
        if (player.root.classList.contains('hidden')) return;
        if (e.key === ' ' || e.key === 'k') { e.preventDefault(); togglePlay(); }
        else if (e.key === 'ArrowRight') v.currentTime = Math.min(v.duration || 0, v.currentTime + 10);
        else if (e.key === 'ArrowLeft') v.currentTime = Math.max(0, v.currentTime - 10);
        else if (e.key === 'f') $('#pl-fs').click();
        else if (e.key === 'm') v.muted = !v.muted;
        else if (e.key === 'Escape') { if (isPlayerFullscreen()) exitFullscreen(); else closePlayer(); }
    });
}

/* ================================================================== */
/*  Global event delegation                                            */
/* ================================================================== */

function onCardActivate(el) {
    const type = el.dataset.type;
    const slug = el.dataset.slug;
    if (!type || !slug) return;
    if (type === 'film') openFilm(slug); else openSeries(slug);
}

function bindEvents() {
    // Bottom nav
    $$('.nav-item').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    $$('[data-goto]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.goto)));

    // Redeem entry points
    $('#btn-topbar-redeem').addEventListener('click', () => openRedeem(null));
    $('#btn-library-redeem').addEventListener('click', () => openRedeem(null));

    // Search — server-side, debounced. Resets the feed and re-queries, so a
    // title that hasn't been paged in yet is still found.
    const onSearch = (kind) => debounce((e) => {
        const { feed } = feedRefs(kind);
        feed.q = e.target.value.trim();
        loadFeed(kind, { reset: true });
    }, 350);
    $('#movies-search').addEventListener('input', onSearch('film'));
    $('#series-search').addEventListener('input', onSearch('series'));
    $('#category-search').addEventListener('input', onSearch('category'));

    // Category page back button → return to Home.
    $('#category-back').addEventListener('click', () => switchTab('home'));

    // Redeem modal
    $('#redeem-form').addEventListener('submit', submitRedeem);
    $('#redeem-input').addEventListener('input', (e) => formatCodeInput(e.target));
    $$('#redeem-root [data-close]').forEach((el) => el.addEventListener('click', closeRedeem));

    // Sheet close
    $$('#sheet-root [data-close]').forEach((el) => el.addEventListener('click', closeSheet));

    // Delegated clicks (cards, play buttons, redeem-open, locked episodes)
    document.addEventListener('click', (e) => {
        const playBtn = e.target.closest('[data-play]');
        if (playBtn) {
            e.stopPropagation();
            openPlayer({
                type: playBtn.dataset.type,
                slug: playBtn.dataset.slug,
                id: Number(playBtn.dataset.id),
                title: playBtn.dataset.title,
            });
            return;
        }

        const openRedeemBtn = e.target.closest('[data-open-redeem]');
        if (openRedeemBtn) {
            const target = JSON.parse(decodeURIComponent(openRedeemBtn.dataset.openRedeem));
            openRedeem({ target, title: openRedeemBtn.dataset.redeemTitle });
            return;
        }

        const epLock = e.target.closest('[data-ep-lock]');
        if (epLock) {
            openRedeem({ target: { episode_id: Number(epLock.dataset.epId) }, title: epLock.dataset.epTitle });
            return;
        }

        const catChip = e.target.closest('.cat-chip-btn');
        if (catChip) { openCategory(catChip.dataset.catId, catChip.dataset.catName); return; }

        const dot = e.target.closest('[data-dot]');
        if (dot) { goToSlide(Number(dot.dataset.dot)); startCarousel(); return; }

        const slide = e.target.closest('.cr-slide');
        if (slide && slide.dataset.slug) { onCardActivate(slide); return; }

        const card = e.target.closest('.card');
        if (card) onCardActivate(card);
    });

    // Carousel swipe (touch) — bound once on the persistent container.
    const carouselEl = $('#home-carousel');
    if (carouselEl) {
        let sx = 0, sy = 0, swiping = false;
        carouselEl.addEventListener('touchstart', (e) => {
            const t = e.changedTouches[0]; sx = t.clientX; sy = t.clientY; swiping = true;
        }, { passive: true });
        carouselEl.addEventListener('touchend', (e) => {
            if (!swiping) return; swiping = false;
            const t = e.changedTouches[0];
            const dx = t.clientX - sx, dy = t.clientY - sy;
            if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
                goToSlide(state.carousel.index + (dx < 0 ? 1 : -1));
                startCarousel();
            }
        }, { passive: true });
    }

    // Save progress if the page is hidden/closed mid-playback.
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            stopCarousel();
            if (player.ctx) saveProgressNow();
        } else if (state.activeTab === 'home') {
            startCarousel();
        }
    });
    window.addEventListener('beforeunload', () => { if (player.ctx) saveProgressNow(); });
}

/* ================================================================== */
/*  Boot                                                               */
/* ================================================================== */

async function boot() {
    initPlayerControls();
    bindEvents();
    setupInfiniteScroll();
    try {
        state.fp = await getDeviceFp();
        await Promise.all([loadCatalog(), loadLibrary(), loadCategoryRows()]);
        renderAll();
    } catch (err) {
        toast(err.message || 'Failed to load. Please refresh.', 'err');
    } finally {
        $('#app-loader').classList.add('hidden');
    }
}

boot();
