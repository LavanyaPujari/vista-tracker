/* ==========================================================================
   Vista Tracker — application logic
   --------------------------------------------------------------------------
   1  Config & constants
   2  Small helpers
   3  Column resolution + row normalisation
   4  Data loading (paged, so >1000 rows come through)
   5  State + URL routing
   6  Filtering & aggregation
   7  UI primitives (multi-select, tables, colour scale)
   8  Views
   9  Chrome (sidebar, tab strip, filter bar)
   10 Boot
   ========================================================================== */

/* 1 ------------------------------------------------------- config & constants */

const ENV = import.meta.env;

const SUPABASE_URL   = (ENV.VITE_SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY   = ENV.VITE_SUPABASE_ANON_KEY || '';
const SUPABASE_TABLE = ENV.VITE_SUPABASE_TABLE || 'agreement track';

/* Optional. If set, the Live Properties nav item opens this URL instead of the
   in-app Live Properties page. Either way it opens in a new browser tab. */
const LIVE_PROPERTIES_URL = ENV.VITE_LIVE_PROPERTIES_URL || '';

const PAGE_SIZE = 1000; // Supabase returns at most 1000 rows per request

/* The seven MIS columns, in MIS order. "Grand Total" is derived. */
const STATUS_ORDER = [
  'Email Confirmation',
  'Expired',
  'Founder/Partner Approved',
  'Not Signed',
  'To Expire',
  'Valid',
];

const UNMAPPED = 'Unmapped';

const STATUS_COLOR = {
  'Email Confirmation':       '#9cccfb',
  'Expired':                  '#b4433f',
  'Founder/Partner Approved': '#c9b8e4',
  'Not Signed':               '#e9a0a7',
  'To Expire':                '#fcd4a8',
  'Valid':                    '#2e7d5b',
  [UNMAPPED]:                 '#d6cec2',
};

const BLANK = '(blank)';

/* 2 -------------------------------------------------------------- small helpers */

const $  = (sel, root = document) => root.querySelector(sel);

/** Build an element. children may be nodes or strings (always set as text). */
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const clean = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');

const nf = new Intl.NumberFormat('en-IN');
const fmtInt = (n) => nf.format(n);
const fmtPct = (n) => (n === null || Number.isNaN(n) ? '—' : `${Math.round(n)}%`);

function collator() {
  return new Intl.Collator('en', { sensitivity: 'base', numeric: true });
}
const cmp = collator().compare;

function isTruthy(v) {
  const n = norm(v);
  return ['live', 'yes', 'y', 'true', '1', 'active', 'onboarded', 'golive'].includes(n);
}

/* 3 ------------------------------ column resolution + row normalisation ------ */

/**
 * Column names in the sheet drift (spaces, casing, renames). Resolve each field
 * we need by matching against a list of normalised candidates, so a rename in
 * the Acq Master doesn't silently empty out a whole tab.
 */
function resolveColumns(sample) {
  const keys = Object.keys(sample || {});
  const index = keys.map((k) => ({ key: k, n: norm(k) }));

  const pick = (tests) => {
    for (const test of tests) {
      const hit = index.find(test);
      if (hit) return hit.key;
    }
    return null;
  };

  const has = (...parts) => (c) => parts.every((p) => c.n.includes(p));
  const is  = (...names) => (c) => names.includes(c.n);

  return {
    kam: pick([
      is('ownerfacingaccountmanager'),
      has('ownerfacing', 'manager'),
      has('account', 'manager'),
      is('kam', 'kamname', 'accountmanager'),
    ]),
    squad: pick([
      is('newsquadmapping'),
      has('newsquad'),
      has('squad', 'mapping'),
      has('squad'),
      is('cluster', 'region', 'location'),
    ]),
    status: pick([
      is('agreementstatus'),
      has('agreement', 'status'),
      is('status'),
      has('agreement'),
    ]),
    property: pick([
      is('propertyname'),
      has('property', 'name'),
      is('villaname', 'listingname', 'vistaname'),
      has('villa'),
      is('name', 'title'),
    ]),
    url: pick([
      has('property', 'link'),
      has('listing', 'url'),
      has('live', 'link'),
      has('url'),
      has('link'),
      has('website'),
    ]),
    live: pick([
      is('livestatus', 'islive', 'live'),
      has('live', 'status'),
      has('golive'),
      has('live'),
    ]),
    code: pick([
      is('propertycode', 'propertyid', 'vistacode', 'code', 'id'),
      has('property', 'code'),
    ]),
  };
}

/**
 * Map whatever the sheet says into the seven MIS buckets.
 * Order matters: "Not Signed" is tested before "Signed", "To Expire" before
 * "Expired", otherwise substrings swallow each other.
 */
function normalizeStatus(raw) {
  const n = norm(raw);
  if (!n) return UNMAPPED;
  if (n.includes('emailconfirm') || n.includes('confirmationemail')) return 'Email Confirmation';
  if (n.includes('founder') || n.includes('partnerapproved') || n.includes('partnerapproval')) return 'Founder/Partner Approved';
  if (n.includes('notsigned') || n.includes('unsigned') || n.includes('yettosign') || n.includes('pendingsignature')) return 'Not Signed';
  if (n.includes('toexpire') || n.includes('abouttoexpire') || n.includes('expiringsoon') || n.includes('nearingexpiry')) return 'To Expire';
  if (n.includes('expired') || n.includes('expiry')) return 'Expired';
  if (n.includes('valid') || n.includes('active') || n.includes('signed')) return 'Valid';
  return UNMAPPED;
}

function normalizeRows(raw, cols) {
  return raw.map((r, i) => ({
    __i: i,
    __kam:      clean(cols.kam      ? r[cols.kam]      : '') || BLANK,
    __squad:    clean(cols.squad    ? r[cols.squad]    : '') || BLANK,
    __statusRaw: clean(cols.status  ? r[cols.status]   : ''),
    __status:   normalizeStatus(cols.status ? r[cols.status] : ''),
    __property: clean(cols.property ? r[cols.property] : '') || '—',
    __code:     clean(cols.code     ? r[cols.code]     : ''),
    __url:      clean(cols.url      ? r[cols.url]      : ''),
    __live:     cols.live ? isTruthy(r[cols.live]) : null,
    __raw: r,
  }));
}

/* 4 ------------------------------------------------------------- data loading */

/** Fetch every row, 1000 at a time. Without this the tabs silently cap at 1000. */
async function fetchAllRows() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Check your .env file (or Vercel environment variables) and redeploy.');
  }

  const endpoint = `${SUPABASE_URL}/rest/v1/${encodeURIComponent(SUPABASE_TABLE)}?select=*`;
  const out = [];
  let from = 0;

  for (let guard = 0; guard < 60; guard++) {
    const res = await fetch(endpoint, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Range-Unit': 'items',
        Range: `${from}-${from + PAGE_SIZE - 1}`,
        Prefer: 'count=exact',
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Supabase returned ${res.status}. ${body.slice(0, 240)}`);
    }

    const batch = await res.json();
    out.push(...batch);

    const total = Number((res.headers.get('content-range') || '').split('/')[1]);
    if (batch.length < PAGE_SIZE) break;
    if (Number.isFinite(total) && out.length >= total) break;
    from += PAGE_SIZE;
  }

  return out;
}

/* 5 ------------------------------------------------------- state + routing --- */

const VIEWS = [
  { id: 'overview',        label: 'Overview',           group: 'Summary' },
  { id: 'kam',             label: 'KAM-wise Summary',   group: 'Summary' },
  { id: 'squad',           label: 'Squad-wise Summary', group: 'Summary' },
  { id: 'properties',      label: 'Properties',         group: 'Detail'  },
  { id: 'live-properties', label: 'Live Properties',    group: 'Detail', external: true },
];

const SUBTABS = {
  overview:        [{ id: 'snapshot', label: 'Snapshot' }, { id: 'detail', label: 'Status detail' }],
  kam:             [{ id: 'counts', label: 'Counts' }, { id: 'ranking', label: 'Valid % ranking' }],
  squad:           [{ id: 'counts', label: 'Counts' }, { id: 'ranking', label: 'Valid % ranking' }],
  properties:      [
    { id: 'all',        label: 'All' },
    { id: 'notsigned',  label: 'Not signed' },
    { id: 'expired',    label: 'Expired' },
    { id: 'toexpire',   label: 'To expire' },
    { id: 'valid',      label: 'Valid' },
  ],
  'live-properties': [{ id: 'all', label: 'All live' }],
};

const state = {
  user: null,
  rows: [],
  cols: {},
  loading: true,
  error: null,
  view: 'overview',
  sub: 'snapshot',
  filters: { squads: [], kams: [], statuses: [] },
  search: '',
  sort: {}, // per view: { key, dir }
};

const validView = (v) => VIEWS.some((x) => x.id === v) ? v : 'overview';

function defaultSub(view) {
  return (SUBTABS[view] || [{ id: 'all' }])[0].id;
}

function readUrl() {
  const p = new URLSearchParams(location.search);
  state.view = validView(p.get('view') || 'overview');
  const subs = SUBTABS[state.view] || [];
  const sub = p.get('tab');
  state.sub = subs.some((s) => s.id === sub) ? sub : defaultSub(state.view);
  const split = (v) => (v ? v.split('~').map(clean).filter(Boolean) : []);
  state.filters.squads   = split(p.get('squad'));
  state.filters.kams     = split(p.get('kam'));
  state.filters.statuses = split(p.get('status'));
  state.search = p.get('q') || '';
}

function urlFor(view, sub) {
  const p = new URLSearchParams();
  if (view && view !== 'overview') p.set('view', view);
  const s = sub || (view === state.view ? state.sub : defaultSub(view));
  if (s && s !== defaultSub(view)) p.set('tab', s);
  if (state.filters.squads.length)   p.set('squad',  state.filters.squads.join('~'));
  if (state.filters.kams.length)     p.set('kam',    state.filters.kams.join('~'));
  if (state.filters.statuses.length) p.set('status', state.filters.statuses.join('~'));
  if (state.search) p.set('q', state.search);
  const qs = p.toString();
  return qs ? `?${qs}` : location.pathname;
}

function syncUrl() {
  history.replaceState(null, '', urlFor(state.view, state.sub));
}

function go(view, sub) {
  state.view = validView(view);
  state.sub = sub || defaultSub(state.view);
  closeDrawer();
  syncUrl();
  render();
  window.scrollTo({ top: 0, behavior: 'auto' });
}

/* 6 ------------------------------------------------- filtering & aggregation - */

function matchesSearch(r, q) {
  if (!q) return true;
  const needle = q.toLowerCase();
  return [r.__property, r.__kam, r.__squad, r.__status, r.__code]
    .some((v) => String(v).toLowerCase().includes(needle));
}

/** Rows matching every filter except `skip` — used for cross-filtered counts. */
function filterRows(skip = null) {
  const { squads, kams, statuses } = state.filters;
  return state.rows.filter((r) =>
    (skip === 'squad'  || !squads.length   || squads.includes(r.__squad)) &&
    (skip === 'kam'    || !kams.length     || kams.includes(r.__kam)) &&
    (skip === 'status' || !statuses.length || statuses.includes(r.__status)) &&
    (skip === 'search' || matchesSearch(r, state.search))
  );
}

function activeRows() { return filterRows(null); }

function hasAnyFilter() {
  const f = state.filters;
  return !!(f.squads.length || f.kams.length || f.statuses.length || state.search);
}

/** All statuses actually present, in MIS order, plus Unmapped only if it occurs. */
function statusColumns(rows) {
  const seen = new Set(rows.map((r) => r.__status));
  const cols = STATUS_ORDER.slice();
  if (seen.has(UNMAPPED)) cols.push(UNMAPPED);
  return cols;
}

/** Build the MIS pivot: one row per key, one count per status, plus totals. */
function buildPivot(rows, field, statuses) {
  const map = new Map();
  for (const r of rows) {
    const key = r[field] || BLANK;
    let e = map.get(key);
    if (!e) {
      e = { key, total: 0, counts: Object.fromEntries(statuses.map((s) => [s, 0])) };
      map.set(key, e);
    }
    if (e.counts[r.__status] === undefined) e.counts[r.__status] = 0;
    e.counts[r.__status] += 1;
    e.total += 1;
  }

  const list = [...map.values()].map((e) => ({
    ...e,
    validPct: e.total ? (e.counts['Valid'] || 0) * 100 / e.total : null,
  }));
  list.sort((a, b) => cmp(a.key, b.key));

  const grand = { key: 'Grand Total', total: 0, counts: Object.fromEntries(statuses.map((s) => [s, 0])) };
  for (const e of list) {
    grand.total += e.total;
    for (const s of statuses) grand.counts[s] += e.counts[s] || 0;
  }
  grand.validPct = grand.total ? (grand.counts['Valid'] || 0) * 100 / grand.total : null;

  return { list, grand, statuses };
}

function uniqueValues(field, skip) {
  const rows = filterRows(skip);
  const counts = new Map();
  for (const r of rows) counts.set(r[field], (counts.get(r[field]) || 0) + 1);
  // every option stays listed even at zero, so a selection is never invisible
  for (const r of state.rows) if (!counts.has(r[field])) counts.set(r[field], 0);
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => cmp(a.value, b.value));
}

/* 7 ----------------------------------------------------------- UI primitives - */

/** Excel-style 3-colour scale (red → yellow → green) for the Valid % column. */
function makeScale(values) {
  const nums = values.filter((v) => typeof v === 'number' && !Number.isNaN(v)).sort((a, b) => a - b);
  if (!nums.length) return () => '';
  const min = nums[0];
  const max = nums[nums.length - 1];
  const mid = nums[Math.floor(nums.length / 2)];
  const stops = [
    { at: min, rgb: [248, 105, 107] },
    { at: mid, rgb: [255, 235, 132] },
    { at: max, rgb: [ 99, 190, 123] },
  ];
  return (v) => {
    if (typeof v !== 'number' || Number.isNaN(v)) return '';
    if (max === min) return 'rgb(99,190,123)';
    const i = v <= mid ? 0 : 1;
    const a = stops[i];
    const b = stops[i + 1];
    const span = b.at - a.at;
    const t = span === 0 ? 1 : Math.min(1, Math.max(0, (v - a.at) / span));
    const c = a.rgb.map((ch, k) => Math.round(ch + (b.rgb[k] - ch) * t));
    return `rgb(${c.join(',')})`;
  };
}

/**
 * Multi-select dropdown: search, select-all/clear, live counts, and a trigger
 * that always shows what's currently chosen.
 */
function multiSelect({ key, label, options, selected, onChange }) {
  const wrap = el('div', { class: 'ms' });
  const panelId = `ms-${key}-panel`;

  const valueSpan = el('span', { class: 'ms-value' });
  const badge = el('span', { class: 'ms-badge' });
  const trigger = el('button', {
    type: 'button',
    class: 'ms-trigger',
    'aria-haspopup': 'listbox',
    'aria-expanded': 'false',
    'aria-controls': panelId,
  }, [
    el('span', { class: 'ms-key', text: label }),
    valueSpan,
    badge,
    el('span', { class: 'ms-caret', text: '▾' }),
  ]);

  function paintTrigger() {
    const n = selected.length;
    wrap.classList.toggle('has-selection', n > 0);
    badge.style.display = n ? '' : 'none';
    badge.textContent = String(n);
    if (n === 0)      valueSpan.textContent = 'All';
    else if (n === 1) valueSpan.textContent = selected[0];
    else if (n === 2) valueSpan.textContent = selected.join(', ');
    else              valueSpan.textContent = `${selected[0]} +${n - 1} more`;
    trigger.title = n ? `${label}: ${selected.join(', ')}` : `${label}: all`;
  }

  const search = el('input', { class: 'ms-search', type: 'search', placeholder: `Search ${label.toLowerCase()}…`, 'aria-label': `Search ${label}` });
  const countLabel = el('span', { class: 'ms-count' });
  const list = el('div', { class: 'ms-list', role: 'listbox', 'aria-multiselectable': 'true' });

  const selectAll = el('button', { type: 'button', text: 'Select all' });
  const clearAll  = el('button', { type: 'button', text: 'Clear' });

  const panel = el('div', { class: 'ms-panel', id: panelId, hidden: true }, [
    search,
    el('div', { class: 'ms-actions' }, [selectAll, clearAll, countLabel]),
    list,
  ]);

  function paintList() {
    const q = search.value.trim().toLowerCase();
    const shown = options.filter((o) => !q || o.value.toLowerCase().includes(q));
    list.replaceChildren();

    if (!shown.length) {
      list.append(el('div', { class: 'ms-empty', text: 'No matches' }));
    } else {
      for (const o of shown) {
        const box = el('input', { type: 'checkbox', checked: selected.includes(o.value) });
        box.addEventListener('change', () => {
          if (box.checked) { if (!selected.includes(o.value)) selected.push(o.value); }
          else selected.splice(selected.indexOf(o.value), 1);
          paintTrigger();
          countLabel.textContent = `${selected.length} selected`;
          onChange(selected.slice());
        });
        list.append(el('label', { class: 'ms-opt', role: 'option', 'aria-selected': selected.includes(o.value) }, [
          box,
          el('span', { class: 'opt-label', text: o.value, title: o.value }),
          el('span', { class: 'opt-count', text: fmtInt(o.count) }),
        ]));
      }
    }
    countLabel.textContent = `${selected.length} selected`;
  }

  selectAll.addEventListener('click', () => {
    const q = search.value.trim().toLowerCase();
    const pool = options.filter((o) => !q || o.value.toLowerCase().includes(q)).map((o) => o.value);
    selected = [...new Set([...selected, ...pool])];
    paintTrigger(); paintList(); onChange(selected.slice());
  });

  clearAll.addEventListener('click', () => {
    selected = [];
    paintTrigger(); paintList(); onChange(selected.slice());
  });

  search.addEventListener('input', paintList);
  search.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });

  function open() {
    document.querySelectorAll('.ms.open').forEach((m) => m !== wrap && m._close?.());
    wrap.classList.add('open');
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    // keep the panel on-screen on narrow viewports
    const room = window.innerWidth - wrap.getBoundingClientRect().left;
    panel.classList.toggle('flip-right', room < 280 && window.innerWidth > 760);
    paintList();
    search.focus();
  }
  function close() {
    wrap.classList.remove('open');
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    search.value = '';
  }
  wrap._close = close;

  trigger.addEventListener('click', () => (panel.hidden ? open() : close()));
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) { close(); trigger.focus(); } });

  /* Refresh options/selection without rebuilding the node, so the panel can
     stay open while several values are ticked. */
  wrap._sync = (nextOptions, nextSelected) => {
    options = nextOptions;
    selected = nextSelected.slice();
    paintTrigger();
    if (!panel.hidden) paintList();
  };

  paintTrigger();
  wrap.append(trigger, panel);
  return wrap;
}

document.addEventListener('click', (e) => {
  document.querySelectorAll('.ms.open').forEach((m) => { if (!m.contains(e.target)) m._close?.(); });
});

/** Sortable, frozen-first-column pivot table shared by the KAM and Squad tabs. */
function pivotTable(pivot, labelHeader) {
  const sort = state.sort[state.view] || { key: '__label', dir: 'asc' };
  const cols = [
    { key: '__label', label: labelHeader, freeze: true },
    ...pivot.statuses.map((s) => ({ key: s, label: s })),
    { key: '__total', label: 'Grand Total' },
    { key: '__pct',   label: 'Agreement Valid %' },
  ];

  const rows = pivot.list.slice().sort((a, b) => {
    const dir = sort.dir === 'desc' ? -1 : 1;
    if (sort.key === '__label') return dir * cmp(a.key, b.key);
    const av = sort.key === '__total' ? a.total : sort.key === '__pct' ? (a.validPct ?? -1) : (a.counts[sort.key] || 0);
    const bv = sort.key === '__total' ? b.total : sort.key === '__pct' ? (b.validPct ?? -1) : (b.counts[sort.key] || 0);
    return av === bv ? cmp(a.key, b.key) : dir * (av - bv);
  });

  const scale = makeScale(rows.map((r) => r.validPct));

  const headCells = cols.map((c) => {
    const active = sort.key === c.key;
    const th = el('th', {
      scope: 'col',
      class: `sortable${c.freeze ? ' freeze' : ''}`,
      'aria-sort': active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none',
      title: `Sort by ${c.label}`,
    }, [c.label, el('span', { class: 'sort-arrow', text: active ? (sort.dir === 'asc' ? '▲' : '▼') : '⇅' })]);
    th.addEventListener('click', () => {
      const same = sort.key === c.key;
      // names read best A→Z first; numbers read best biggest-first
      const firstDir = c.key === '__label' ? 'asc' : 'desc';
      state.sort[state.view] = { key: c.key, dir: same ? (sort.dir === 'asc' ? 'desc' : 'asc') : firstDir };
      renderView();
    });
    return th;
  });

  const body = rows.map((r) => el('tr', {}, [
    el('td', { class: 'freeze', 'data-label': labelHeader, text: r.key }),
    ...pivot.statuses.map((s) => {
      const v = r.counts[s] || 0;
      return el('td', { class: v ? '' : 'zero', 'data-label': s, text: v ? fmtInt(v) : '–' });
    }),
    el('td', { 'data-label': 'Grand Total', text: fmtInt(r.total) }),
    (() => {
      const td = el('td', { class: 'pct-cell', 'data-label': 'Agreement Valid %', text: fmtPct(r.validPct) });
      td.style.background = scale(r.validPct);
      return td;
    })(),
  ]));

  const foot = el('tr', {}, [
    el('td', { class: 'freeze', text: 'Grand Total' }),
    ...pivot.statuses.map((s) => el('td', { text: pivot.grand.counts[s] ? fmtInt(pivot.grand.counts[s]) : '–' })),
    el('td', { text: fmtInt(pivot.grand.total) }),
    el('td', { class: 'pct-cell', text: fmtPct(pivot.grand.validPct) }),
  ]);

  const table = el('table', { class: 'grid' }, [
    el('thead', {}, [el('tr', {}, headCells)]),
    el('tbody', {}, body.length ? body : [el('tr', {}, [el('td', { colspan: cols.length, class: 'freeze', text: 'No rows match the current filters.' })])]),
    el('tfoot', {}, [foot]),
  ]);

  return el('div', { class: 'table-wrap' }, [table]);
}

function statusPill(status) {
  const c = STATUS_COLOR[status] || '#d6cec2';
  const dark = ['Valid', 'Expired'].includes(status);
  return el('span', {
    class: 'pill',
    text: status,
    style: `background:${c}; color:${dark ? '#fff' : '#1e1e1e'}`,
  });
}

/** Row-level property table. Restacks into cards under 540px via data-label. */
function propertyTable(rows) {
  const head = ['Property', 'Squad', 'KAM', 'Agreement status', 'Link'];
  const capped = rows.slice(0, 500);

  const body = capped.map((r) => el('tr', {}, [
    el('td', { class: 'freeze', 'data-label': 'Property' }, [
      r.__url
        ? el('a', { class: 'link-out', href: r.__url, target: '_blank', rel: 'noopener noreferrer' }, [r.__property, el('span', { class: 'ext', text: '↗' })])
        : r.__property,
    ]),
    el('td', { 'data-label': 'Squad', style: 'text-align:left', text: r.__squad }),
    el('td', { 'data-label': 'KAM', style: 'text-align:left', text: r.__kam }),
    el('td', { 'data-label': 'Agreement status', style: 'text-align:left' }, [statusPill(r.__status)]),
    el('td', { 'data-label': 'Link', style: 'text-align:left' }, [
      r.__url
        ? el('a', { class: 'link-out', href: r.__url, target: '_blank', rel: 'noopener noreferrer' }, ['Open', el('span', { class: 'ext', text: '↗' })])
        : el('span', { class: 'zero', text: '–' }),
    ]),
  ]));

  const table = el('table', { class: 'grid stacked' }, [
    el('thead', {}, [el('tr', {}, head.map((h, i) => el('th', { scope: 'col', class: i === 0 ? 'freeze' : '', style: i ? 'text-align:left' : '', text: h })))]),
    el('tbody', {}, body.length ? body : [el('tr', {}, [el('td', { colspan: head.length, class: 'freeze', text: 'No properties match the current filters.' })])]),
  ]);

  const wrap = el('div', { class: 'table-wrap stacked-wrap' }, [table]);
  if (rows.length > capped.length) {
    return el('div', {}, [wrap, el('div', { class: 'scroll-hint', style: 'display:block', text: `Showing the first ${fmtInt(capped.length)} of ${fmtInt(rows.length)} properties — narrow the filters to see the rest.` })]);
  }
  return wrap;
}

/* 8 -------------------------------------------------------------------- views */

function kpiCard(label, value, sub, accent) {
  return el('div', { class: `kpi${accent ? ` accent-${accent}` : ''}` }, [
    el('div', { class: 'k-label', text: label }),
    el('div', { class: 'k-value', text: value }),
    sub ? el('div', { class: 'k-sub', text: sub }) : null,
  ]);
}

function pageHead(title, desc) {
  return el('div', { class: 'page-head' }, [
    el('h2', { text: title }),
    desc ? el('p', { text: desc }) : null,
  ]);
}

function viewOverview(rows) {
  const statuses = statusColumns(rows);
  const counts = Object.fromEntries(statuses.map((s) => [s, 0]));
  for (const r of rows) counts[r.__status] = (counts[r.__status] || 0) + 1;
  const total = rows.length;
  const valid = counts['Valid'] || 0;
  const needsAction = (counts['Not Signed'] || 0) + (counts['Expired'] || 0) + (counts['To Expire'] || 0);

  const frag = el('div', {}, [
    pageHead('Agreement summary', 'The same seven buckets as the Acq Master MIS, recalculated live from Supabase. Every filter above applies to all tabs.'),
  ]);

  if (state.sub === 'snapshot') {
    frag.append(
      el('div', { class: 'kpi-grid' }, [
        kpiCard('Grand total', fmtInt(total), 'properties in scope', 'sky'),
        kpiCard('Valid', fmtInt(valid), fmtPct(total ? valid * 100 / total : null) + ' of total', 'good'),
        kpiCard('Needs action', fmtInt(needsAction), 'not signed, expired or expiring', 'bad'),
        kpiCard('Squads', fmtInt(new Set(rows.map((r) => r.__squad)).size), 'in scope'),
        kpiCard('KAMs', fmtInt(new Set(rows.map((r) => r.__kam)).size), 'in scope'),
      ]),
    );

    const bar = el('div', { class: 'dist-bar' });
    const legend = el('div', { class: 'dist-legend' });
    for (const s of statuses) {
      const n = counts[s] || 0;
      if (!n) continue;
      const pct = n * 100 / total;
      bar.append(el('div', { class: 'dist-seg', style: `width:${pct}%; background:${STATUS_COLOR[s]}`, title: `${s}: ${fmtInt(n)}` }));
      legend.append(el('div', { class: 'item' }, [
        el('span', { class: 'swatch', style: `background:${STATUS_COLOR[s]}` }),
        el('span', { text: s }),
        el('span', { class: 'n', text: fmtInt(n) }),
        el('span', { class: 'pct', text: `(${fmtPct(pct)})` }),
      ]));
    }

    frag.append(el('div', { class: 'panel' }, [
      el('div', { class: 'panel-head' }, [
        el('h3', { text: 'Agreement status split' }),
        el('span', { class: 'hint right', text: `${fmtInt(total)} properties` }),
      ]),
      el('div', { class: 'panel-body' }, [bar, legend]),
    ]));
  } else {
    const table = el('table', { class: 'grid stacked' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { scope: 'col', class: 'freeze', text: 'Agreement status' }),
        el('th', { scope: 'col', text: 'Properties' }),
        el('th', { scope: 'col', text: 'Share of total' }),
      ])]),
      el('tbody', {}, statuses.map((s) => el('tr', {}, [
        el('td', { class: 'freeze', 'data-label': 'Status' }, [statusPill(s)]),
        el('td', { 'data-label': 'Properties', text: fmtInt(counts[s] || 0) }),
        el('td', { 'data-label': 'Share', text: fmtPct(total ? (counts[s] || 0) * 100 / total : null) }),
      ]))),
      el('tfoot', {}, [el('tr', {}, [
        el('td', { class: 'freeze', text: 'Grand Total' }),
        el('td', { text: fmtInt(total) }),
        el('td', { text: '100%' }),
      ])]),
    ]);

    frag.append(el('div', { class: 'panel' }, [
      el('div', { class: 'panel-head' }, [el('h3', { text: 'Status detail' })]),
      el('div', { class: 'table-wrap stacked-wrap' }, [table]),
    ]));
  }

  return frag;
}

function viewPivot(rows, field, labelHeader, title, desc) {
  const statuses = statusColumns(rows);
  const pivot = buildPivot(rows, field, statuses);
  const frag = el('div', {}, [pageHead(title, desc)]);

  if (state.sub === 'ranking') {
    const ranked = pivot.list.slice().sort((a, b) => (b.validPct ?? -1) - (a.validPct ?? -1) || cmp(a.key, b.key));
    const scale = makeScale(ranked.map((r) => r.validPct));
    const body = ranked.map((r, i) => el('tr', {}, [
      el('td', { class: 'freeze', 'data-label': labelHeader, text: `${i + 1}. ${r.key}` }),
      el('td', { 'data-label': 'Valid', text: fmtInt(r.counts['Valid'] || 0) }),
      el('td', { 'data-label': 'Grand Total', text: fmtInt(r.total) }),
      (() => {
        const td = el('td', { class: 'pct-cell', 'data-label': 'Agreement Valid %', text: fmtPct(r.validPct) });
        td.style.background = scale(r.validPct);
        return td;
      })(),
    ]));

    frag.append(el('div', { class: 'panel' }, [
      el('div', { class: 'panel-head' }, [
        el('h3', { text: 'Ranked by agreement validity' }),
        el('span', { class: 'hint right', text: 'Highest valid share first' }),
      ]),
      el('div', { class: 'table-wrap stacked-wrap' }, [
        el('table', { class: 'grid stacked' }, [
          el('thead', {}, [el('tr', {}, [
            el('th', { scope: 'col', class: 'freeze', text: labelHeader }),
            el('th', { scope: 'col', text: 'Valid' }),
            el('th', { scope: 'col', text: 'Grand Total' }),
            el('th', { scope: 'col', text: 'Agreement Valid %' }),
          ])]),
          el('tbody', {}, body.length ? body : [el('tr', {}, [el('td', { colspan: 4, class: 'freeze', text: 'No rows match the current filters.' })])]),
        ]),
      ]),
    ]));
    return frag;
  }

  frag.append(el('div', { class: 'panel' }, [
    el('div', { class: 'panel-head' }, [
      el('h3', { text: `${labelHeader} × agreement status` }),
      el('span', { class: 'hint', text: 'Tap a column heading to sort' }),
      el('span', { class: 'hint right', text: `${fmtInt(pivot.list.length)} rows · ${fmtInt(pivot.grand.total)} properties` }),
    ]),
    pivotTable(pivot, labelHeader),
    el('div', { class: 'scroll-hint', text: 'Swipe the table sideways to see every status column.' }),
  ]));

  return frag;
}

function viewProperties(rows) {
  const bySub = {
    notsigned: 'Not Signed',
    expired:   'Expired',
    toexpire:  'To Expire',
    valid:     'Valid',
  }[state.sub];

  const shown = bySub ? rows.filter((r) => r.__status === bySub) : rows;

  return el('div', {}, [
    pageHead('Properties', 'Every row behind the summaries. Property links open in a new browser tab.'),
    el('div', { class: 'panel' }, [
      el('div', { class: 'panel-head' }, [
        el('h3', { text: bySub ? `${bySub} agreements` : 'All properties' }),
        el('span', { class: 'hint right', text: `${fmtInt(shown.length)} properties` }),
      ]),
      propertyTable(shown),
    ]),
  ]);
}

function viewLiveProperties(rows) {
  const hasLiveCol = !!state.cols.live;
  const shown = hasLiveCol ? rows.filter((r) => r.__live) : rows;

  const statuses = statusColumns(shown);
  const counts = Object.fromEntries(statuses.map((s) => [s, 0]));
  for (const r of shown) counts[r.__status] = (counts[r.__status] || 0) + 1;

  return el('div', {}, [
    pageHead('Live properties', hasLiveCol
      ? 'Properties currently live, with their agreement status. Filters carry over from the tab you opened this from.'
      : 'No live/not-live column was found in the table, so every property is listed. Add one to the Acq Master and it will filter here automatically.'),
    el('div', { class: 'kpi-grid' }, [
      kpiCard('Live properties', fmtInt(shown.length), 'in scope', 'sky'),
      kpiCard('Valid', fmtInt(counts['Valid'] || 0), fmtPct(shown.length ? (counts['Valid'] || 0) * 100 / shown.length : null) + ' of live', 'good'),
      kpiCard('Not signed', fmtInt(counts['Not Signed'] || 0), 'need chasing', 'bad'),
      kpiCard('Expiring', fmtInt(counts['To Expire'] || 0), 'renew before expiry', 'warn'),
    ]),
    el('div', { class: 'panel' }, [
      el('div', { class: 'panel-head' }, [
        el('h3', { text: 'Live property list' }),
        el('span', { class: 'hint right', text: `${fmtInt(shown.length)} properties` }),
      ]),
      propertyTable(shown),
    ]),
  ]);
}

/* 9 ------------------------------------------------------------------- chrome */

function renderSidebar() {
  const nav = $('#sidebar');
  nav.replaceChildren();

  const rows = activeRows();
  const countFor = {
    overview: rows.length,
    kam: new Set(rows.map((r) => r.__kam)).size,
    squad: new Set(rows.map((r) => r.__squad)).size,
    properties: rows.length,
    'live-properties': state.cols.live ? rows.filter((r) => r.__live).length : rows.length,
  };

  for (const group of ['Summary', 'Detail']) {
    const g = el('div', { class: 'nav-group' }, [el('div', { class: 'nav-label', text: group })]);

    for (const v of VIEWS.filter((x) => x.group === group)) {
      if (v.external) {
        const href = LIVE_PROPERTIES_URL || `${location.pathname}${urlFor(v.id, defaultSub(v.id))}`;
        g.append(el('a', {
          class: 'nav-item',
          href,
          target: '_blank',
          rel: 'noopener noreferrer',
          title: 'Opens in a new browser tab',
        }, [
          el('span', { class: 'dot' }),
          el('span', { class: 'label', text: v.label }),
          el('span', { class: 'nav-count', text: fmtInt(countFor[v.id] ?? 0) }),
          el('span', { class: 'ext', text: '↗' }),
        ]));
        continue;
      }

      const a = el('a', {
        class: 'nav-item',
        href: urlFor(v.id, defaultSub(v.id)),
        'aria-current': state.view === v.id ? 'page' : null,
      }, [
        el('span', { class: 'dot' }),
        el('span', { class: 'label', text: v.label }),
        el('span', { class: 'nav-count', text: fmtInt(countFor[v.id] ?? 0) }),
      ]);
      a.addEventListener('click', (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // let the browser open a new tab
        e.preventDefault();
        go(v.id);
      });
      g.append(a);
    }
    nav.append(g);
  }
}

function renderTabs() {
  const strip = $('#tab-strip');
  strip.replaceChildren();
  const subs = SUBTABS[state.view] || [];
  if (subs.length < 2) return;

  for (const s of subs) {
    const b = el('button', {
      type: 'button',
      class: 'tab',
      role: 'tab',
      'aria-selected': state.sub === s.id ? 'true' : 'false',
      text: s.label,
    });
    b.addEventListener('click', () => { state.sub = s.id; syncUrl(); renderTabs(); renderView(); });
    strip.append(b);
  }
  strip.setAttribute('role', 'tablist');
}

/* The three dropdowns are built once and kept mounted. Rebuilding them on every
   change closed the panel after a single tick, which made multi-select useless. */
const filterUI = { built: false, controls: {}, note: null, reset: null };

const FILTER_FIELDS = {
  squads:   { field: '__squad',  skip: 'squad',  key: 'squad',  label: 'Squad'  },
  kams:     { field: '__kam',    skip: 'kam',    key: 'kam',    label: 'KAM'    },
  statuses: { field: '__status', skip: 'status', key: 'status', label: 'Status' },
};

function renderFilters() {
  const bar = $('#filter-bar');
  if (!bar) return;

  if (state.loading || state.error) {
    bar.replaceChildren();
    filterUI.built = false;
    filterUI.controls = {};
    return;
  }
  if (filterUI.built && bar.firstChild) { updateFilters(); return; }

  bar.replaceChildren();
  const row = el('div', { class: 'filter-row' });

  for (const [stateKey, cfg] of Object.entries(FILTER_FIELDS)) {
    const ms = multiSelect({
      key: cfg.key,
      label: cfg.label,
      options: uniqueValues(cfg.field, cfg.skip),
      selected: state.filters[stateKey].slice(),
      onChange: (vals) => { state.filters[stateKey] = vals; onFiltersChanged(); },
    });
    filterUI.controls[stateKey] = ms;
    row.append(ms);
  }

  const search = el('input', {
    class: 'filter-search',
    type: 'search',
    placeholder: 'Search property, KAM or squad…',
    'aria-label': 'Search',
    value: state.search,
  });
  let t;
  search.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      state.search = search.value.trim();
      onFiltersChanged();
    }, 180);
  });
  row.append(search);

  const reset = el('button', { type: 'button', class: 'reset-btn', text: 'Reset filters', disabled: !hasAnyFilter() });
  reset.addEventListener('click', () => {
    state.filters = { squads: [], kams: [], statuses: [] };
    state.search = '';
    onFiltersChanged();
  });
  row.append(reset);

  const note = el('span', { class: 'result-note' });
  row.append(note);

  filterUI.search = search;
  filterUI.reset = reset;
  filterUI.note = note;
  filterUI.built = true;

  bar.append(row, el('div', { class: 'active-filters', id: 'active-filters' }));
  updateFilters();
}

/** Refresh what the mounted filter bar shows, without replacing its nodes. */
function updateFilters() {
  if (!filterUI.built) return;

  for (const [stateKey, cfg] of Object.entries(FILTER_FIELDS)) {
    filterUI.controls[stateKey]?._sync(
      uniqueValues(cfg.field, cfg.skip),
      state.filters[stateKey],
    );
  }

  if (filterUI.search
      && document.activeElement !== filterUI.search
      && filterUI.search.value !== state.search) {
    filterUI.search.value = state.search;
  }
  if (filterUI.reset) filterUI.reset.disabled = !hasAnyFilter();
  if (filterUI.note) {
    const shown = activeRows().length;
    filterUI.note.textContent = hasAnyFilter()
      ? `${fmtInt(shown)} of ${fmtInt(state.rows.length)} properties`
      : `${fmtInt(state.rows.length)} properties`;
  }

  renderActiveFilters();
}

/** The visible readout of what's selected — chips, each individually removable. */
function renderActiveFilters() {
  const box = $('#active-filters');
  if (!box) return;
  box.replaceChildren();
  if (!hasAnyFilter()) return;

  box.append(el('span', { class: 'af-title', text: 'Filtering by' }));

  const addChips = (list, key, keyLabel, cls) => {
    list.forEach((v) => {
      const x = el('button', { class: 'chip-x', type: 'button', 'aria-label': `Remove ${keyLabel} ${v}`, text: '×' });
      x.addEventListener('click', () => {
        state.filters[key] = state.filters[key].filter((s) => s !== v);
        onFiltersChanged();
      });
      box.append(el('span', { class: `chip ${cls}`, title: `${keyLabel}: ${v}` }, [
        el('span', { class: 'chip-key', text: keyLabel }),
        el('span', { class: 'chip-val', text: v }),
        x,
      ]));
    });
  };

  addChips(state.filters.squads,   'squads',   'Squad',  'chip-squad');
  addChips(state.filters.kams,     'kams',     'KAM',    'chip-kam');
  addChips(state.filters.statuses, 'statuses', 'Status', 'chip-status');

  if (state.search) {
    const x = el('button', { class: 'chip-x', type: 'button', 'aria-label': 'Clear search', text: '×' });
    x.addEventListener('click', () => { state.search = ''; onFiltersChanged(); });
    box.append(el('span', { class: 'chip chip-search' }, [
      el('span', { class: 'chip-key', text: 'Search' }),
      el('span', { class: 'chip-val', text: state.search }),
      x,
    ]));
  }

  const clearAll = el('button', { class: 'chip-x', type: 'button', 'aria-label': 'Clear all filters', text: '×' });
  clearAll.addEventListener('click', () => {
    state.filters = { squads: [], kams: [], statuses: [] };
    state.search = '';
    onFiltersChanged();
  });
  box.append(el('span', { class: 'chip', style: 'border-style:dashed' }, [
    el('span', { class: 'chip-val', text: 'Clear all' }),
    clearAll,
  ]));
}

function onFiltersChanged() {
  syncUrl();
  renderSidebar();
  updateFilters();
  renderView();
}

function renderView() {
  const root = $('#view-root');
  root.replaceChildren();

  if (state.loading) {
    root.append(el('div', { class: 'state' }, [
      el('div', { class: 'spinner' }),
      el('h3', { text: 'Loading from Supabase' }),
      el('p', { text: `Reading the “${SUPABASE_TABLE}” table.` }),
    ]));
    return;
  }

  if (state.error) {
    const retry = el('button', { type: 'button', text: 'Try again' });
    retry.addEventListener('click', boot);
    root.append(el('div', { class: 'state error' }, [
      el('h3', { text: 'Could not load the data' }),
      el('p', { text: state.error }),
      el('p', { html: 'If the table loads but comes back empty, it is almost always Row Level Security — add a <code>SELECT</code> policy on the table in Supabase.' }),
      retry,
    ]));
    return;
  }

  if (!state.rows.length) {
    root.append(el('div', { class: 'state' }, [
      el('h3', { text: 'No rows came back' }),
      el('p', { html: `The <code>${SUPABASE_TABLE}</code> table returned zero rows. Check that a <code>SELECT</code> policy exists under Supabase → Authentication → Policies.` }),
    ]));
    return;
  }

  const rows = activeRows();

  switch (state.view) {
    case 'kam':
      root.append(viewPivot(rows, '__kam', 'Owner Facing Account Manager', 'KAM-wise summary',
        'Agreement status by Owner Facing Account Manager, matching the MIS pivot.'));
      break;
    case 'squad':
      root.append(viewPivot(rows, '__squad', 'New Squad Mapping', 'Squad-wise summary',
        'Agreement status by squad, matching the MIS pivot.'));
      break;
    case 'properties':
      root.append(viewProperties(rows));
      break;
    case 'live-properties':
      root.append(viewLiveProperties(rows));
      break;
    default:
      root.append(viewOverview(rows));
  }
}

function render() {
  renderSidebar();
  renderTabs();
  renderFilters();
  renderView();
}

/* drawer ------------------------------------------------------------------- */

function openDrawer() {
  $('#sidebar').classList.add('open');
  $('#nav-toggle').setAttribute('aria-expanded', 'true');
  const scrim = $('#scrim');
  scrim.hidden = false;
  requestAnimationFrame(() => scrim.classList.add('show'));
  document.body.style.overflow = 'hidden';
}

function closeDrawer() {
  $('#sidebar').classList.remove('open');
  $('#nav-toggle')?.setAttribute('aria-expanded', 'false');
  const scrim = $('#scrim');
  scrim.classList.remove('show');
  setTimeout(() => { scrim.hidden = true; }, 200);
  document.body.style.overflow = '';
}

/* auth --------------------------------------------------------------------- */

const USER_KEY = 'vt.user';
const validEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

function showApp(email) {
  state.user = email;
  $('#login-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#who-label').textContent = email;
}

function handleLogin() {
  const input = $('#email-input');
  const value = input.value.trim();
  if (!validEmail(value)) {
    input.classList.add('invalid');
    $('#login-error').classList.add('show');
    input.focus();
    return;
  }
  input.classList.remove('invalid');
  $('#login-error').classList.remove('show');
  try { localStorage.setItem(USER_KEY, value); } catch { /* private mode */ }
  showApp(value);
  boot();
}

function signOut() {
  try { localStorage.removeItem(USER_KEY); } catch { /* ignore */ }
  state.user = null;
  $('#app').classList.add('hidden');
  $('#login-screen').classList.remove('hidden');
  $('#email-input').value = '';
}

/* 10 -------------------------------------------------------------------- boot */

async function boot() {
  state.loading = true;
  state.error = null;
  render();

  try {
    const raw = await fetchAllRows();
    state.cols = resolveColumns(raw[0]);
    state.rows = normalizeRows(raw, state.cols);
    state.error = null;
  } catch (err) {
    state.error = err.message || String(err);
    state.rows = [];
  } finally {
    state.loading = false;
    render();
  }
}

function init() {
  readUrl();

  $('#login-btn')?.addEventListener('click', handleLogin);
  $('#email-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleLogin(); });
  $('#email-input')?.addEventListener('input', () => {
    $('#email-input').classList.remove('invalid');
    $('#login-error')?.classList.remove('show');
  });
  $('#signout-btn')?.addEventListener('click', signOut);

  $('#nav-toggle')?.addEventListener('click', () => {
    $('#sidebar').classList.contains('open') ? closeDrawer() : openDrawer();
  });
  $('#scrim')?.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  window.addEventListener('resize', () => { if (window.innerWidth > 980) closeDrawer(); });
  window.addEventListener('popstate', () => { readUrl(); render(); });

  let saved = null;
  try { saved = localStorage.getItem(USER_KEY); } catch { /* ignore */ }

  if (saved && validEmail(saved)) {
    showApp(saved);
    boot();
  }
}

/* kept on window because index.html historically used inline onclick handlers */
window.handleLogin = handleLogin;
window.signOut = signOut;

init();
