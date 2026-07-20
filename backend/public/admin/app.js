/* ============================================================
   CinemaChatrix Admin — frontend logic (vanilla JS, v3)
   Films & Series manager with add / edit / delete, thumbnails,
   a universal modal, search, and an episode manager view.
   ============================================================ */

const TOKEN_KEY = 'cc_admin_token';
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => root.querySelectorAll(sel);

/* In-memory caches so search/filter is instant. */
const state = {
    films: [],
    series: [],
    filmQuery: '',
    seriesQuery: '',
    currentSeries: null, // series row when the detail view is open
    currentEpisodes: [],
    codes: [],
    codeQuery: '',
    codeStatus: '',
    codeSummary: null,
};

/* ---------------- Token helpers ---------------- */
const getToken = () => localStorage.getItem(TOKEN_KEY);
const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
const clearToken = () => localStorage.removeItem(TOKEN_KEY);

/* ---------------- API wrapper (JSON) ---------------- */
async function api(path, { method = 'GET', body = null, form = false } = {}) {
    const headers = {};
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (!form && body) headers['Content-Type'] = 'application/json';

    const res = await fetch(`/api${path}`, {
        method,
        headers,
        body: form ? body : body ? JSON.stringify(body) : null,
    });

    let data = {};
    try { data = await res.json(); } catch { /* no body */ }

    if (res.status === 401 || res.status === 403) {
        clearToken();
        showLogin();
        throw new Error(data.error || 'Session expired');
    }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
}

/* ---------------- Multipart sender (XHR, with progress) ---------------- */
function sendForm({ url, method = 'POST', formData, progressEl = null }) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open(method, url);
        xhr.setRequestHeader('Authorization', `Bearer ${getToken()}`);

        if (progressEl) {
            const bar = progressEl.querySelector('.bar');
            const label = progressEl.querySelector('span');
            progressEl.classList.remove('hidden');
            bar.classList.add('animate');
            bar.style.width = '0%';
            label.textContent = 'Uploading… 0%';
            xhr.upload.onprogress = (ev) => {
                if (!ev.lengthComputable) return;
                const pct = Math.round((ev.loaded / ev.total) * 100);
                bar.style.width = pct + '%';
                label.textContent = pct < 100 ? `Uploading… ${pct}%` : 'Processing…';
            };
        }

        xhr.onload = () => {
            let data = {};
            try { data = JSON.parse(xhr.responseText); } catch { /* */ }
            if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
            if (xhr.status === 401 || xhr.status === 403) { clearToken(); showLogin(); }
            reject(new Error(data.error || `Request failed (${xhr.status})`));
        };
        xhr.onerror = () => reject(new Error('Network error during upload'));
        xhr.send(formData);
    });
}

/* ---------------- Toast ---------------- */
let toastTimer;
function toast(msg, type = 'ok') {
    const el = $('#toast');
    el.textContent = msg;
    el.className = `toast show ${type}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, 3200);
}

/* ---------------- Formatters ---------------- */
function fmtSize(bytes) {
    if (!bytes) return '—';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0, n = bytes;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(1)} ${u[i]}`;
}
function fmtDuration(sec) {
    if (!sec) return '—';
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${s}s`;
    return `${s}s`;
}
function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}
function attr(s) {
    return String(s ?? '').replace(/"/g, '&quot;');
}

/* ============================================================
   MODAL CORE
   ============================================================ */
function openModal(title, bodyHtml) {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = bodyHtml;
    $('#modal-root').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    const firstInput = $('#modal-body input:not([type=hidden]), #modal-body textarea');
    if (firstInput) setTimeout(() => firstInput.focus(), 60);
}
function closeModal() {
    $('#modal-root').classList.add('hidden');
    $('#modal-body').innerHTML = '';
    document.body.style.overflow = '';
}
$('#modal-root').addEventListener('click', (e) => {
    if (e.target.hasAttribute('data-close')) closeModal();
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#modal-root').classList.contains('hidden')) closeModal();
});

/* ---------------- Reusable form fragments ---------------- */
function switchField(name, label, checked) {
    return `<label class="switch">
        <input type="checkbox" name="${name}" ${checked ? 'checked' : ''} />
        <span class="switch-track"><span class="switch-thumb"></span></span>
        <span class="switch-label">${esc(label)}</span>
    </label>`;
}
function progressBar(id) {
    return `<div class="progress hidden" id="${id}"><div class="bar"></div><span></span></div>`;
}
function posterFields(currentUrl) {
    const preview = currentUrl
        ? `<img class="modal-poster-preview" src="${attr(currentUrl)}" alt="poster" />`
        : '';
    return `
        <div class="grid-2">
            <div class="field">
                <label>Poster image ${currentUrl ? '(replace)' : ''}</label>
                <input name="poster" type="file" accept="image/*" />
            </div>
            <div class="field">
                <label>…or Poster URL</label>
                <input name="poster_url" type="url" placeholder="https://…" />
            </div>
        </div>
        ${preview}`;
}

/* ============================================================
   VIEW SWITCHING + LOGIN
   ============================================================ */
function showLogin() {
    $('#app-view').classList.add('hidden');
    $('#login-view').classList.remove('hidden');
}
function showApp() {
    $('#login-view').classList.add('hidden');
    $('#app-view').classList.remove('hidden');
    loadFilms();
    loadSeries();
}

$('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#login-btn');
    btn.disabled = true; btn.textContent = 'Signing in...';
    try {
        const data = await api('/auth/login', {
            method: 'POST',
            body: { username: $('#username').value, password: $('#password').value },
        });
        setToken(data.data.token);
        $('#who').textContent = `👤 ${data.data.admin.username}`;
        showApp();
        toast('Welcome back!');
    } catch (err) {
        toast(err.message, 'err');
    } finally {
        btn.disabled = false; btn.textContent = 'Sign In';
    }
});

$('#logout-btn').addEventListener('click', async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    clearToken();
    showLogin();
    toast('Logged out');
});

/* ---------------- Tabs ---------------- */
$$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
        $$('.tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        const name = tab.dataset.tab;
        $('#tab-films').classList.toggle('hidden', name !== 'films');
        $('#tab-series').classList.toggle('hidden', name !== 'series');
        $('#tab-codes').classList.toggle('hidden', name !== 'codes');
        if (name === 'codes') loadCodes();
    });
});

/* ============================================================
   FILMS
   ============================================================ */
async function loadFilms() {
    const grid = $('#films-grid');
    grid.innerHTML = skeletonGrid(8);
    try {
        const { data } = await api('/movies');
        state.films = data.movies || [];
        renderFilms();
    } catch (err) {
        grid.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    }
}

function renderFilms() {
    const grid = $('#films-grid');
    const q = state.filmQuery.toLowerCase();
    const films = q
        ? state.films.filter((m) => m.title.toLowerCase().includes(q))
        : state.films;

    $('#films-count').textContent = state.films.length;

    if (!state.films.length) {
        grid.innerHTML = `<div class="empty"><div class="em-icon">🎞️</div>No films yet.
            <div><button class="btn btn-primary" id="empty-add-film">＋ Add your first film</button></div></div>`;
        $('#empty-add-film')?.addEventListener('click', () => openFilmModal(null));
        return;
    }
    if (!films.length) {
        grid.innerHTML = '<div class="empty"><div class="em-icon">🔍</div>No films match your search.</div>';
        return;
    }
    grid.innerHTML = films.map(filmCard).join('');
}

function filmCard(m) {
    const poster = m.poster_path || m.thumbnail_path;
    const img = poster
        ? `<img src="${attr(poster)}" alt="" loading="lazy" onerror="this.parentNode.querySelector('.placeholder')?.classList.remove('hidden');this.remove();" /><div class="placeholder hidden">🎬</div>`
        : '<div class="placeholder">🎬</div>';
    const badge = m.is_published
        ? '<span class="card-badge live">● Live</span>'
        : '<span class="card-badge draft">● Draft</span>';
    return `
    <div class="card" data-id="${m.id}" data-act="edit-film">
        <div class="card-poster">
            ${img}${badge}
            <div class="card-hover">
                <button class="icon-btn edit" data-id="${m.id}" data-act="edit-film" title="Edit">✎</button>
                <button class="icon-btn del" data-id="${m.id}" data-act="del-film" title="Delete">🗑</button>
            </div>
        </div>
        <div class="card-body">
            <div class="card-title">${esc(m.title)}</div>
            <div class="card-meta">
                <span>${esc(m.quality || '—')}</span>
                <span>${fmtDuration(m.duration)}</span>
                <span>${fmtSize(m.file_size)}</span>
            </div>
        </div>
    </div>`;
}

/* Films grid interactions (event delegation) */
$('#films-grid').addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const id = Number(el.dataset.id);
    const movie = state.films.find((m) => m.id === id);
    if (el.dataset.act === 'del-film') { e.stopPropagation(); deleteFilm(movie); }
    else if (el.dataset.act === 'edit-film') openFilmModal(movie);
});

$('#films-search').addEventListener('input', (e) => {
    state.filmQuery = e.target.value.trim();
    renderFilms();
});
$('#btn-add-film').addEventListener('click', () => openFilmModal(null));
$('#btn-bulk-films').addEventListener('click', openBulkFilmsModal);

/* ---- Add / Edit film modal ---- */
function openFilmModal(movie) {
    const isEdit = !!movie;
    const m = movie || {};
    const videoSection = isEdit ? '' : `
        <div class="form-divider">Video source</div>
        <div class="grid-2">
            <div class="field">
                <label>Video file</label>
                <input name="video" type="file" accept="video/*" />
            </div>
            <div class="field">
                <label>…or Video URL</label>
                <input name="video_url" type="url" placeholder="https://…" />
            </div>
        </div>`;

    openModal(isEdit ? 'Edit Film' : 'Add Film', `
        <form id="film-form">
            <div class="grid-2">
                <div class="field">
                    <label>Title *</label>
                    <input name="title" type="text" required placeholder="e.g. Inception" value="${attr(m.title)}" />
                </div>
                <div class="field">
                    <label>Quality</label>
                    <input name="quality" type="text" placeholder="1080p" value="${attr(m.quality || '')}" />
                </div>
            </div>
            <div class="field">
                <label>Description</label>
                <textarea name="description" rows="3" placeholder="Short synopsis…">${esc(m.description || '')}</textarea>
            </div>
            ${videoSection}
            <div class="form-divider">Poster</div>
            ${posterFields(m.poster_path)}
            ${switchField('is_published', 'Published', m.is_published ?? 1)}
            ${progressBar('film-progress')}
            <div class="form-actions">
                <button type="button" class="btn btn-ghost" data-close>Cancel</button>
                <button type="submit" class="btn btn-primary">${isEdit ? 'Save changes' : 'Upload film'}</button>
            </div>
        </form>
    `);

    $('#film-form').addEventListener('submit', (e) => submitFilm(e, movie));
}

async function submitFilm(e, movie) {
    e.preventDefault();
    const form = e.target;
    const isEdit = !!movie;

    if (!form.title.value.trim()) { toast('Title is required', 'err'); return; }
    if (!isEdit && !form.video.files.length && !form.video_url.value.trim()) {
        toast('A video file or video URL is required', 'err');
        return;
    }

    const fd = new FormData(form);
    fd.set('is_published', form.is_published.checked ? '1' : '0');
    // Drop empty file inputs so multer doesn't choke on empty parts
    if (!form.querySelector('[name=poster]')?.files.length) fd.delete('poster');
    if (form.video && !form.video.files.length) fd.delete('video');

    const submitBtn = form.querySelector('button[type=submit]');
    submitBtn.disabled = true;
    const progressEl = $('#film-progress');

    try {
        await sendForm({
            url: isEdit ? `/api/movies/${movie.id}` : '/api/movies',
            method: isEdit ? 'PUT' : 'POST',
            formData: fd,
            progressEl: isEdit ? null : progressEl,
        });
        toast(isEdit ? 'Film updated' : 'Film uploaded!');
        closeModal();
        loadFilms();
    } catch (err) {
        toast(err.message, 'err');
        submitBtn.disabled = false;
        progressEl?.classList.add('hidden');
    }
}

async function deleteFilm(movie) {
    if (!movie) return;
    if (!confirm(`Delete film "${movie.title}"? This removes the video file too.`)) return;
    try {
        await api(`/movies/${movie.id}`, { method: 'DELETE' });
        toast('Film deleted');
        loadFilms();
    } catch (err) { toast(err.message, 'err'); }
}

/* ============================================================
   BULK REMOTE IMPORT (films)
   ============================================================ */
function renderImport(container, job) {
    const pct = job.total ? Math.round((job.completed / job.total) * 100) : 0;
    const rows = job.items.map((it) => {
        const icon = { pending: '⏳', downloading: '⬇', processing: '⚙', done: '✅', failed: '❌' }[it.status] || '•';
        const ep = it.episode_number
            ? `<span class="ep-tag">S${it.season_number}·E${it.episode_number}</span> `
            : '';
        const note = it.status === 'failed'
            ? `<span class="imp-err">${esc(it.error || 'failed')}</span>`
            : `<span class="imp-status">${esc(it.status)}</span>`;
        return `<div class="imp-row"><span class="imp-icon">${icon}</span>${ep}<span class="imp-title">${esc(it.title)}</span>${note}</div>`;
    }).join('');
    container.innerHTML = `
        <div class="imp-head">
            <div class="progress"><div class="bar${job.status === 'running' ? ' animate' : ''}" style="width:${pct}%"></div><span>${job.completed}/${job.total} · ✅ ${job.succeeded} · ❌ ${job.failed}</span></div>
        </div>
        <div class="imp-list">${rows}</div>`;
}

async function pollImport(jobId, container, onDone) {
    try {
        const { data } = await api(`/imports/${jobId}`);
        const job = data.job;
        renderImport(container, job);
        if (job.status === 'running') {
            setTimeout(() => pollImport(jobId, container, onDone), 1500);
        } else {
            toast(`Import finished — ${job.succeeded} saved, ${job.failed} failed`, job.failed ? 'err' : 'ok');
            if (onDone) onDone(job);
        }
    } catch (err) {
        container.innerHTML = `<p class="imp-err">${esc(err.message)}</p>`;
    }
}

function openBulkFilmsModal() {
    openModal('Bulk Import Films', `
        <form id="bulk-film-form">
            <div class="field">
                <label>Paste video links — one per line</label>
                <textarea name="text" rows="7" placeholder="https://host/inception.mp4&#10;The Matrix | https://host/matrix.mp4&#10;Dune | https://host/dune.mp4 | https://host/dune-poster.jpg"></textarea>
                <p class="hint">Per line: <code>url</code> · <code>Title | url</code> · <code>Title | url | posterUrl</code>. Missing titles are taken from the filename.</p>
            </div>
            ${switchField('is_published', 'Publish imported films', true)}
            <div class="form-actions">
                <button type="button" class="btn btn-ghost" data-close>Close</button>
                <button type="submit" class="btn btn-primary" id="bulk-film-submit">⬇ Download &amp; Save All</button>
            </div>
            <div id="bulk-film-progress" class="import-progress hidden"></div>
        </form>
    `);

    $('#bulk-film-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = e.target;
        const text = form.text.value.trim();
        if (!text) { toast('Paste at least one link', 'err'); return; }
        const btn = $('#bulk-film-submit');
        const container = $('#bulk-film-progress');
        btn.disabled = true;
        container.classList.remove('hidden');
        container.innerHTML = '<p class="empty">Starting import…</p>';
        try {
            const { data } = await api('/movies/bulk', {
                method: 'POST',
                body: { text, is_published: form.is_published.checked ? '1' : '0' },
            });
            renderImport(container, data.job);
            pollImport(data.job.id, container, () => loadFilms());
        } catch (err) {
            toast(err.message, 'err');
            container.innerHTML = `<p class="imp-err">${esc(err.message)}</p>`;
        } finally {
            btn.disabled = false;
        }
    });
}

/* ============================================================
   SERIES — LIST
   ============================================================ */
async function loadSeries() {
    const grid = $('#series-grid');
    grid.innerHTML = skeletonGrid(6);
    try {
        const { data } = await api('/series');
        state.series = data.series || [];
        renderSeries();
    } catch (err) {
        grid.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    }
}

function renderSeries() {
    const grid = $('#series-grid');
    const q = state.seriesQuery.toLowerCase();
    const series = q
        ? state.series.filter((s) => s.title.toLowerCase().includes(q))
        : state.series;

    $('#series-count').textContent = state.series.length;

    if (!state.series.length) {
        grid.innerHTML = `<div class="empty"><div class="em-icon">📺</div>No series yet.
            <div><button class="btn btn-primary" id="empty-add-series">＋ Add your first series</button></div></div>`;
        $('#empty-add-series')?.addEventListener('click', () => openSeriesModal(null));
        return;
    }
    if (!series.length) {
        grid.innerHTML = '<div class="empty"><div class="em-icon">🔍</div>No series match your search.</div>';
        return;
    }
    grid.innerHTML = series.map(seriesCard).join('');
}

function seriesCard(s) {
    const img = s.poster_path
        ? `<img src="${attr(s.poster_path)}" alt="" loading="lazy" onerror="this.parentNode.querySelector('.placeholder')?.classList.remove('hidden');this.remove();" /><div class="placeholder hidden">📺</div>`
        : '<div class="placeholder">📺</div>';
    const badge = s.is_published
        ? '<span class="card-badge live">● Live</span>'
        : '<span class="card-badge draft">● Draft</span>';
    return `
    <div class="card" data-id="${s.id}" data-act="open-series">
        <div class="card-poster">
            ${img}${badge}
            <div class="card-hover">
                <button class="icon-btn edit" data-id="${s.id}" data-act="edit-series" title="Edit series">✎</button>
                <button class="icon-btn del" data-id="${s.id}" data-act="del-series" title="Delete series">🗑</button>
            </div>
        </div>
        <div class="card-body">
            <div class="card-title">${esc(s.title)}</div>
            <div class="card-meta"><span>Manage episodes →</span></div>
        </div>
    </div>`;
}

$('#series-grid').addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const id = Number(el.dataset.id);
    const s = state.series.find((x) => x.id === id);
    if (el.dataset.act === 'del-series') { e.stopPropagation(); deleteSeries(s); }
    else if (el.dataset.act === 'edit-series') { e.stopPropagation(); openSeriesModal(s); }
    else if (el.dataset.act === 'open-series') openSeriesDetail(s);
});

$('#series-search').addEventListener('input', (e) => {
    state.seriesQuery = e.target.value.trim();
    renderSeries();
});
$('#btn-add-series').addEventListener('click', () => openSeriesModal(null));

/* ---- Add / Edit series modal ---- */
function openSeriesModal(series) {
    const isEdit = !!series;
    const s = series || {};
    openModal(isEdit ? 'Edit Series' : 'Add Series', `
        <form id="series-form">
            <div class="field">
                <label>Title *</label>
                <input name="title" type="text" required placeholder="e.g. Breaking Bad" value="${attr(s.title)}" />
            </div>
            <div class="field">
                <label>Description</label>
                <textarea name="description" rows="3" placeholder="Short synopsis…">${esc(s.description || '')}</textarea>
            </div>
            <div class="form-divider">Poster</div>
            ${posterFields(s.poster_path)}
            ${switchField('is_published', 'Published', s.is_published ?? 1)}
            <div class="form-actions">
                <button type="button" class="btn btn-ghost" data-close>Cancel</button>
                <button type="submit" class="btn btn-primary">${isEdit ? 'Save changes' : 'Create series'}</button>
            </div>
        </form>
    `);
    $('#series-form').addEventListener('submit', (e) => submitSeries(e, series));
}

async function submitSeries(e, series) {
    e.preventDefault();
    const form = e.target;
    const isEdit = !!series;
    if (!form.title.value.trim()) { toast('Title is required', 'err'); return; }

    const fd = new FormData(form);
    fd.set('is_published', form.is_published.checked ? '1' : '0');
    if (!form.poster.files.length) fd.delete('poster');

    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
        await sendForm({
            url: isEdit ? `/api/series/${series.id}` : '/api/series',
            method: isEdit ? 'PUT' : 'POST',
            formData: fd,
        });
        toast(isEdit ? 'Series updated' : 'Series created');
        closeModal();
        await loadSeries();
        // If we edited the currently open series, refresh its detail header.
        if (isEdit && state.currentSeries && state.currentSeries.id === series.id) {
            const fresh = state.series.find((x) => x.id === series.id);
            if (fresh) openSeriesDetail(fresh);
        }
    } catch (err) {
        toast(err.message, 'err');
        btn.disabled = false;
    }
}

async function deleteSeries(s) {
    if (!s) return;
    if (!confirm(`Delete series "${s.title}" and ALL its episodes?`)) return;
    try {
        await api(`/series/${s.id}`, { method: 'DELETE' });
        toast('Series deleted');
        if (state.currentSeries && state.currentSeries.id === s.id) closeSeriesDetail();
        loadSeries();
    } catch (err) { toast(err.message, 'err'); }
}

/* ============================================================
   SERIES — DETAIL (episode manager)
   ============================================================ */
async function openSeriesDetail(s) {
    state.currentSeries = s;
    $('#series-list-view').classList.add('hidden');
    const view = $('#series-detail-view');
    view.classList.remove('hidden');
    view.innerHTML = renderSeriesDetail(s, null);
    bindDetailActions();
    await loadEpisodesInto(s);
}

function closeSeriesDetail() {
    state.currentSeries = null;
    state.currentEpisodes = [];
    $('#series-detail-view').classList.add('hidden');
    $('#series-detail-view').innerHTML = '';
    $('#series-list-view').classList.remove('hidden');
}

function renderSeriesDetail(s, epsHtml) {
    const poster = s.poster_path
        ? `<img class="detail-poster" src="${attr(s.poster_path)}" alt="" onerror="this.classList.add('placeholder');this.removeAttribute('src');this.textContent='📺';" />`
        : '<div class="detail-poster placeholder">📺</div>';
    const badge = s.is_published
        ? '<span class="pill live">● Live</span>'
        : '<span class="pill draft">● Draft</span>';
    return `
        <button class="btn btn-ghost back-btn" id="detail-back">← All series</button>
        <div class="detail-head">
            ${poster}
            <div class="detail-info">
                <div class="detail-badges">${badge}<span class="pill info" id="detail-ep-count">… episodes</span></div>
                <h2>${esc(s.title)}</h2>
                <p>${esc(s.description || 'No description provided.')}</p>
                <div class="detail-actions">
                    <button class="btn btn-primary" id="detail-add-ep">＋ Add Episode</button>
                    <button class="btn btn-ghost" id="detail-bulk-ep">⚡ Bulk Import</button>
                    <button class="btn btn-ghost" id="detail-edit-series">✎ Edit Series</button>
                    <button class="btn btn-danger" id="detail-del-series">🗑 Delete</button>
                </div>
            </div>
        </div>
        <div class="eps-toolbar">
            <h3>Episodes</h3>
        </div>
        <div class="eps-grid" id="eps-grid">${epsHtml || skeletonEps(4)}</div>
    `;
}

function bindDetailActions() {
    const s = state.currentSeries;
    $('#detail-back').addEventListener('click', closeSeriesDetail);
    $('#detail-add-ep').addEventListener('click', () => openEpisodeModal(s, null));
    $('#detail-bulk-ep').addEventListener('click', () => openBulkEpisodesModal(s));
    $('#detail-edit-series').addEventListener('click', () => openSeriesModal(s));
    $('#detail-del-series').addEventListener('click', () => deleteSeries(s));

    $('#eps-grid').addEventListener('click', (e) => {
        const el = e.target.closest('[data-act]');
        if (!el) return;
        if (el.dataset.act === 'add-ep') { openEpisodeModal(state.currentSeries, null); return; }
        const id = Number(el.dataset.id);
        const ep = state.currentEpisodes.find((x) => x.id === id);
        if (el.dataset.act === 'del-ep') { e.stopPropagation(); deleteEpisode(ep); }
        else if (el.dataset.act === 'edit-ep') openEpisodeModal(state.currentSeries, ep);
    });
}

async function loadEpisodesInto(s) {
    try {
        const { data } = await api(`/series/${s.slug}`);
        state.currentEpisodes = data.episodes || [];
        renderEpisodes();
    } catch (err) {
        const grid = $('#eps-grid');
        if (grid) grid.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    }
}

function renderEpisodes() {
    const grid = $('#eps-grid');
    if (!grid) return;
    const eps = state.currentEpisodes;
    const countEl = $('#detail-ep-count');
    if (countEl) countEl.textContent = `${eps.length} episode${eps.length === 1 ? '' : 's'}`;

    const addTile = `<div class="ep-add-tile" data-act="add-ep"><span class="plus">＋</span>Add Episode</div>`;
    grid.innerHTML = eps.map((ep) => episodeCard(ep)).join('') + addTile;
}

function episodeCard(ep) {
    const thumb = ep.thumbnail_path || state.currentSeries?.poster_path || '/static/images/default_image.png';
    const img = thumb
        ? `<img src="${attr(thumb)}" alt="" loading="lazy" onerror="this.parentNode.querySelector('.placeholder')?.classList.remove('hidden');this.remove();" /><div class="placeholder hidden">🎬</div>`
        : '<div class="placeholder">🎬</div>';
    return `
    <div class="ep-card" data-id="${ep.id}" data-act="edit-ep">
        <div class="ep-thumb">
            ${img}
            <span class="ep-num">S${ep.season_number}·E${ep.episode_number}</span>
            ${ep.duration ? `<span class="ep-dur">${fmtDuration(ep.duration)}</span>` : ''}
            <div class="play-ov"><span>✎</span></div>
        </div>
        <div class="ep-card-body">
            <div class="ep-card-title">${esc(ep.title)}</div>
            <div class="ep-card-actions">
                <button class="icon-btn edit" data-id="${ep.id}" data-act="edit-ep" title="Edit">✎</button>
                <button class="icon-btn del" data-id="${ep.id}" data-act="del-ep" title="Delete">🗑</button>
            </div>
        </div>
    </div>`;
}

/* ---- Add / Edit episode modal ---- */
function openEpisodeModal(series, ep) {
    const isEdit = !!ep;
    const e = ep || {};
    // Suggest the next episode number for a new episode in season 1.
    let nextEp = 1;
    if (!isEdit) {
        const s1 = state.currentEpisodes.filter((x) => (x.season_number || 1) === 1);
        nextEp = s1.reduce((max, x) => Math.max(max, x.episode_number), 0) + 1;
    }
    const videoSection = isEdit ? '' : `
        <div class="form-divider">Video source</div>
        <div class="grid-2">
            <div class="field">
                <label>Video file</label>
                <input name="video" type="file" accept="video/*" />
            </div>
            <div class="field">
                <label>…or Video URL</label>
                <input name="video_url" type="url" placeholder="https://…" />
            </div>
        </div>`;

    openModal(isEdit ? 'Edit Episode' : 'Add Episode', `
        <form id="episode-form">
            <div class="grid-2">
                <div class="field">
                    <label>Season #</label>
                    <input name="season_number" type="number" min="1" value="${attr(e.season_number ?? 1)}" />
                </div>
                <div class="field">
                    <label>Episode # *</label>
                    <input name="episode_number" type="number" min="1" required value="${attr(e.episode_number ?? nextEp)}" />
                </div>
            </div>
            <div class="field">
                <label>Title *</label>
                <input name="title" type="text" required placeholder="e.g. Pilot" value="${attr(e.title)}" />
            </div>
            <div class="field">
                <label>Description</label>
                <textarea name="description" rows="2" placeholder="Short synopsis…">${esc(e.description || '')}</textarea>
            </div>
            <div class="field">
                <label>Quality</label>
                <input name="quality" type="text" placeholder="1080p" value="${attr(e.quality || '')}" />
            </div>
            ${videoSection}
            <div class="form-divider">Thumbnail</div>
            ${posterFields(e.thumbnail_path)}
            ${progressBar('episode-progress')}
            <div class="form-actions">
                <button type="button" class="btn btn-ghost" data-close>Cancel</button>
                <button type="submit" class="btn btn-primary">${isEdit ? 'Save changes' : 'Add episode'}</button>
            </div>
        </form>
    `);
    $('#episode-form').addEventListener('submit', (e2) => submitEpisode(e2, series, ep));
}

async function submitEpisode(e, series, ep) {
    e.preventDefault();
    const form = e.target;
    const isEdit = !!ep;

    if (!form.title.value.trim()) { toast('Episode title is required', 'err'); return; }
    if (!form.episode_number.value) { toast('Episode number is required', 'err'); return; }
    if (!isEdit && !form.video.files.length && !form.video_url.value.trim()) {
        toast('A video file or video URL is required', 'err');
        return;
    }

    const fd = new FormData(form);
    if (!form.poster.files.length) fd.delete('poster');
    if (form.video && !form.video.files.length) fd.delete('video');

    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    const progressEl = $('#episode-progress');

    try {
        await sendForm({
            url: isEdit ? `/api/series/episodes/${ep.id}` : `/api/series/${series.id}/episodes`,
            method: isEdit ? 'PUT' : 'POST',
            formData: fd,
            progressEl: isEdit ? null : progressEl,
        });
        toast(isEdit ? 'Episode updated' : 'Episode added');
        closeModal();
        loadEpisodesInto(series);
    } catch (err) {
        toast(err.message, 'err');
        btn.disabled = false;
        progressEl?.classList.add('hidden');
    }
}

async function deleteEpisode(ep) {
    if (!ep) return;
    if (!confirm(`Delete episode S${ep.season_number}·E${ep.episode_number} "${ep.title}"?`)) return;
    try {
        await api(`/series/episodes/${ep.id}`, { method: 'DELETE' });
        toast('Episode deleted');
        loadEpisodesInto(state.currentSeries);
    } catch (err) { toast(err.message, 'err'); }
}

/* ---- Bulk import episodes modal ---- */
function openBulkEpisodesModal(series) {
    openModal(`Bulk Import Episodes · ${esc(series.title)}`, `
        <form id="bulk-ep-form">
            <div class="field">
                <label>Season #</label>
                <input name="season_number" type="number" min="1" value="1" />
            </div>
            <div class="field">
                <label>Paste episode links — one per line (numbered in order)</label>
                <textarea name="text" rows="7" placeholder="https://host/ep01.mp4&#10;Episode Title | https://host/ep02.mp4"></textarea>
                <p class="hint">Episodes are numbered automatically, continuing after the last one in the chosen season.</p>
            </div>
            <div class="form-actions">
                <button type="button" class="btn btn-ghost" data-close>Close</button>
                <button type="submit" class="btn btn-primary" id="bulk-ep-submit">⬇ Download &amp; Save All</button>
            </div>
            <div id="bulk-ep-progress" class="import-progress hidden"></div>
        </form>
    `);

    $('#bulk-ep-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = e.target;
        const text = form.text.value.trim();
        if (!text) { toast('Paste at least one link', 'err'); return; }
        const btn = $('#bulk-ep-submit');
        const container = $('#bulk-ep-progress');
        btn.disabled = true;
        container.classList.remove('hidden');
        container.innerHTML = '<p class="empty">Starting import…</p>';
        try {
            const { data } = await api(`/series/${series.id}/episodes/bulk`, {
                method: 'POST',
                body: { text, season_number: form.season_number.value || 1 },
            });
            renderImport(container, data.job);
            pollImport(data.job.id, container, () => loadEpisodesInto(series));
        } catch (err) {
            toast(err.message, 'err');
            container.innerHTML = `<p class="imp-err">${esc(err.message)}</p>`;
        } finally {
            btn.disabled = false;
        }
    });
}

/* ============================================================
   ACCESS CODES
   ============================================================ */
function fmtDate(s) {
    if (!s) return '—';
    const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function codeTargetLabel(c) {
    const t = c.target || {};
    if (t.type === 'movie') {
        return `<span class="tgt-ico">🎬</span>${esc(t.title || 'Unknown film')}`;
    }
    if (t.type === 'series') {
        return `<span class="tgt-ico">📺</span>${esc(t.title || 'Series')} <span class="ep-tag">All episodes</span>`;
    }
    const se = `S${t.season_number}·E${t.episode_number}`;
    return `<span class="tgt-ico">▶</span>${esc(t.series_title || 'Series')} <span class="ep-tag">${se}</span> ${esc(t.title || '')}`;
}

async function loadCodes() {
    const box = $('#codes-list');
    box.innerHTML = '<div class="empty">Loading codes…</div>';
    try {
        const { data } = await api('/codes');
        state.codes = data.codes || [];
        state.codeSummary = data.summary || null;
        renderCodes();
    } catch (err) {
        box.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    }
}

function renderCodes() {
    const box = $('#codes-list');
    const statsBox = $('#codes-stats');
    const q = state.codeQuery.toLowerCase();
    const status = state.codeStatus;

    $('#codes-count').textContent = state.codes.length;

    // Summary pills
    const sum = state.codeSummary || { total: state.codes.length, available: 0, used: 0, expired: 0 };
    statsBox.innerHTML = `
        <span class="stat-pill"><b>${sum.total}</b> total</span>
        <span class="stat-pill ok"><b>${sum.available}</b> available</span>
        <span class="stat-pill used"><b>${sum.used}</b> used</span>
        <span class="stat-pill exp"><b>${sum.expired}</b> expired</span>`;

    let codes = state.codes;
    if (status) codes = codes.filter((c) => c.status === status);
    if (q) {
        codes = codes.filter((c) => {
            const t = c.target || {};
            return c.code.toLowerCase().includes(q)
                || (t.title || '').toLowerCase().includes(q)
                || (t.series_title || '').toLowerCase().includes(q);
        });
    }

    if (!state.codes.length) {
        box.innerHTML = `<div class="empty"><div class="em-icon">🎟️</div>No codes yet.
            <div><button class="btn btn-primary" id="empty-gen-codes">＋ Generate your first codes</button></div></div>`;
        $('#empty-gen-codes')?.addEventListener('click', openGenerateModal);
        return;
    }
    if (!codes.length) {
        box.innerHTML = '<div class="empty"><div class="em-icon">🔍</div>No codes match your filter.</div>';
        return;
    }

    box.innerHTML = `
        <div class="table-wrap">
        <table class="codes-table">
            <thead><tr>
                <th>Code</th><th>For</th><th>Status</th><th>Created</th><th>Expires</th><th></th>
            </tr></thead>
            <tbody>${codes.map(codeRow).join('')}</tbody>
        </table>
        </div>`;
}

function codeRow(c) {
    const statusLabel = { available: '● Available', used: '● Used', expired: '● Expired' }[c.status] || c.status;
    return `
    <tr data-id="${c.id}">
        <td><span class="code-val">${esc(c.code)}</span>
            <button class="mini-btn" data-act="copy" data-code="${attr(c.code)}" title="Copy">⧉</button></td>
        <td class="tgt-cell">${codeTargetLabel(c)}</td>
        <td><span class="code-status ${c.status}">${statusLabel}</span></td>
        <td class="dim">${fmtDate(c.created_at)}</td>
        <td class="dim">${c.expires_at ? fmtDate(c.expires_at) : 'Never'}</td>
        <td class="row-act"><button class="icon-btn del" data-act="del-code" data-id="${c.id}" title="Delete">🗑</button></td>
    </tr>`;
}

/* Codes interactions (event delegation) */
$('#codes-list').addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    if (el.dataset.act === 'copy') {
        copyText(el.dataset.code);
    } else if (el.dataset.act === 'del-code') {
        const id = Number(el.dataset.id);
        const c = state.codes.find((x) => x.id === id);
        deleteCode(c);
    }
});

$('#codes-search').addEventListener('input', (e) => {
    state.codeQuery = e.target.value.trim();
    renderCodes();
});
$('#codes-filter').addEventListener('change', (e) => {
    state.codeStatus = e.target.value;
    renderCodes();
});
$('#btn-gen-codes').addEventListener('click', openGenerateModal);

function copyText(text) {
    if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(
            () => toast('Copied to clipboard'),
            () => toast('Could not copy', 'err')
        );
    } else {
        // Fallback for non-secure contexts
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); toast('Copied to clipboard'); }
        catch { toast('Could not copy', 'err'); }
        ta.remove();
    }
}

async function deleteCode(c) {
    if (!c) return;
    const warn = c.status === 'used'
        ? `Delete code ${c.code}? It has already been redeemed — the user will lose access.`
        : `Delete code ${c.code}?`;
    if (!confirm(warn)) return;
    try {
        await api(`/codes/${c.id}`, { method: 'DELETE' });
        toast('Code deleted');
        loadCodes();
    } catch (err) { toast(err.message, 'err'); }
}

/* ---- Generate codes modal ---- */
function openGenerateModal() {
    const movieOpts = state.films.length
        ? state.films.map((m) => `<option value="${m.id}">${esc(m.title)}</option>`).join('')
        : '<option value="" disabled>No films yet — add one first</option>';
    const seriesOptsPlain = state.series.length
        ? state.series.map((s) => `<option value="${s.id}">${esc(s.title)}</option>`).join('')
        : '<option value="" disabled>No series yet — add one first</option>';
    const seriesOpts = state.series.length
        ? '<option value="">Select a series…</option>' +
          state.series.map((s) => `<option value="${s.id}">${esc(s.title)}</option>`).join('')
        : '<option value="" disabled>No series yet — add one first</option>';

    openModal('Generate Access Codes', `
        <form id="gen-form">
            <div class="field">
                <label>What is this code for?</label>
                <div class="seg" id="gen-type">
                    <button type="button" class="seg-btn active" data-type="movie">🎬 Film</button>
                    <button type="button" class="seg-btn" data-type="series">📺 Whole Series</button>
                    <button type="button" class="seg-btn" data-type="episode">▶ Episode</button>
                </div>
            </div>

            <div class="field" id="gen-movie-field">
                <label>Film *</label>
                <select id="gen-movie">${movieOpts}</select>
            </div>

            <div class="field hidden" id="gen-wseries-field">
                <label>Series *</label>
                <select id="gen-wseries">${seriesOptsPlain}</select>
                <p class="hint">Unlocks <b>every episode</b> of this series — present and future.</p>
            </div>

            <div class="field hidden" id="gen-series-field">
                <label>Series *</label>
                <select id="gen-series">${seriesOpts}</select>
            </div>
            <div class="field hidden" id="gen-episode-field">
                <label>Episode *</label>
                <select id="gen-episode"><option value="">Select a series first…</option></select>
            </div>

            <div class="grid-2">
                <div class="field">
                    <label>How many codes?</label>
                    <input id="gen-quantity" type="number" min="1" max="500" value="1" />
                </div>
                <div class="field">
                    <label>Expires in (days)</label>
                    <input id="gen-expiry" type="number" min="0" placeholder="0 = never" />
                </div>
            </div>

            <div class="form-actions">
                <button type="button" class="btn btn-ghost" data-close>Cancel</button>
                <button type="submit" class="btn btn-primary" id="gen-submit">Generate</button>
            </div>
            <div id="gen-result" class="gen-result hidden"></div>
        </form>
    `);

    let targetType = 'movie';

    // Segmented control: switch between film / whole-series / episode targets.
    $$('#gen-type .seg-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            targetType = btn.dataset.type;
            $$('#gen-type .seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
            $('#gen-movie-field').classList.toggle('hidden', targetType !== 'movie');
            $('#gen-wseries-field').classList.toggle('hidden', targetType !== 'series');
            $('#gen-series-field').classList.toggle('hidden', targetType !== 'episode');
            $('#gen-episode-field').classList.toggle('hidden', targetType !== 'episode');
        });
    });

    // When a series is chosen (episode mode), load its episodes.
    $('#gen-series').addEventListener('change', async (e) => {
        const sid = Number(e.target.value);
        const epSel = $('#gen-episode');
        const s = state.series.find((x) => x.id === sid);
        if (!s) { epSel.innerHTML = '<option value="">Select a series first…</option>'; return; }
        epSel.innerHTML = '<option value="">Loading…</option>';
        try {
            const { data } = await api(`/series/${s.slug}`);
            const eps = data.episodes || [];
            epSel.innerHTML = eps.length
                ? eps.map((ep) => `<option value="${ep.id}">S${ep.season_number}·E${ep.episode_number} — ${esc(ep.title)}</option>`).join('')
                : '<option value="" disabled>This series has no episodes yet</option>';
        } catch (err) {
            epSel.innerHTML = `<option value="" disabled>${esc(err.message)}</option>`;
        }
    });

    $('#gen-form').addEventListener('submit', (e) => submitGenerate(e, () => targetType));
}

async function submitGenerate(e, getType) {
    e.preventDefault();
    const type = getType();
    const quantity = Number($('#gen-quantity').value) || 1;
    const expiryDays = $('#gen-expiry').value;

    const body = { quantity };
    if (expiryDays && Number(expiryDays) > 0) body.expires_in_days = Number(expiryDays);

    if (type === 'movie') {
        const movieId = Number($('#gen-movie').value);
        if (!movieId) { toast('Pick a film', 'err'); return; }
        body.movie_id = movieId;
    } else if (type === 'series') {
        const seriesId = Number($('#gen-wseries').value);
        if (!seriesId) { toast('Pick a series', 'err'); return; }
        body.series_id = seriesId;
    } else {
        const episodeId = Number($('#gen-episode').value);
        if (!episodeId) { toast('Pick an episode', 'err'); return; }
        body.episode_id = episodeId;
    }

    const btn = $('#gen-submit');
    btn.disabled = true; btn.textContent = 'Generating…';
    try {
        const { data } = await api('/codes/generate', { method: 'POST', body });
        renderGenerateResult(data.codes || []);
        loadCodes(); // refresh the table behind the modal
    } catch (err) {
        toast(err.message, 'err');
    } finally {
        btn.disabled = false; btn.textContent = 'Generate';
    }
}

function renderGenerateResult(codes) {
    const box = $('#gen-result');
    if (!box) return;
    const list = codes.map((c) =>
        `<div class="gen-code"><span class="code-val">${esc(c.code)}</span>
            <button type="button" class="mini-btn" data-copy="${attr(c.code)}" title="Copy">⧉</button></div>`
    ).join('');
    const allText = codes.map((c) => c.code).join('\n');
    box.classList.remove('hidden');
    box.innerHTML = `
        <div class="form-divider">${codes.length} code${codes.length === 1 ? '' : 's'} generated</div>
        <div class="gen-codes-list">${list}</div>
        <button type="button" class="btn btn-ghost btn-block" id="gen-copy-all">⧉ Copy all</button>`;

    box.querySelectorAll('[data-copy]').forEach((el) => {
        el.addEventListener('click', () => copyText(el.dataset.copy));
    });
    $('#gen-copy-all')?.addEventListener('click', () => copyText(allText));
    toast('Codes generated!');
}

/* ============================================================
   SKELETON LOADERS
   ============================================================ */
function skeletonGrid(n) {
    return Array.from({ length: n })
        .map(() => '<div class="card"><div class="skeleton sk-card"></div></div>')
        .join('');
}
function skeletonEps(n) {
    return Array.from({ length: n })
        .map(() => '<div class="ep-card"><div class="skeleton" style="aspect-ratio:16/9"></div></div>')
        .join('');
}

/* ============================================================
   BOOT
   ============================================================ */
(async function boot() {
    if (!getToken()) return showLogin();
    try {
        const { data } = await api('/auth/me');
        $('#who').textContent = `👤 ${data.admin.username}`;
        showApp();
    } catch {
        showLogin();
    }
})();
