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




const PAGE_SIZE = 1000; // Supabase returns at most 1000 rows per request

/* How many days before agreement_end_date counts as "To Expire". */
const EXPIRY_WINDOW_DAYS = Number(ENV.VITE_EXPIRY_WINDOW_DAYS) || 90;

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
 * The live table uses its own names (squad, poc, contract_signing_status, ...).
 * Each field lists the real column first, then looser fallbacks, so a rename or
 * a differently-cased header still resolves. Matching ignores case, spaces,
 * underscores and punctuation throughout.
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
    // POC comes from the Owner Facing columns first — the sync writes them into
    // `poc`, but reading them directly means the dashboard works either way.
    kam: pick([
      is('ownerfacingaccountmanager'),
      has('ownerfacing', 'accountmanager'),
      has('ownerfacing', 'manager'),
      has('ownerfacing', 'poc'),
      has('ownerfacing'),
      is('poc'),
      has('account', 'manager'),
      is('kam', 'kamname', 'accountmanager'),
    ]),
    // secondary Owner Facing column, used to fill blanks in the primary
    kamAlt: pick([
      has('ownerfacing', 'ops'),
      has('ownerfacing', 'secondary'),
      has('ownerfacing', 'backup'),
      is('poc'),
    ]),
    squad: pick([
      is('squad'),
      is('newsquadmapping'),
      has('squad'),
      is('city', 'cluster', 'region'),
    ]),
    // pre-signature states: Not Signed / Email Confirmation / Founder-Partner Approved
    signing: pick([
      is('contractsigningstatus'),
      has('signing', 'status'),
      has('contract', 'status'),
      is('agreementstatus'),
    ]),
    // post-signature states: Valid / To Expire / Expired
    lifecycle: pick([
      is('contractlifecyclestatus'),
      has('lifecycle', 'status'),
      is('agreementstatus'),
    ]),
    endDate: pick([
      is('agreementenddate'),
      has('agreement', 'end'),
      has('contract', 'end'),
      has('expiry'), has('expiration'),
    ]),
    reason: pick([is('reasonnotsigned'), has('reason', 'signed'), has('reason')]),
    property: pick([
      is('vistaname'),
      is('propertyname'),
      has('vista', 'name'),
      has('property', 'name'),
      has('villa', 'name'),
      is('name', 'title'),
    ]),
    url: pick([
      is('villadetailslink'),
      has('villa', 'link'),
      has('details', 'link'),
      is('googlelink'),
      has('property', 'link'),
      has('link'), has('url'),
    ]),
    agreementUrl: pick([is('agreementlink'), has('agreement', 'link')]),
    // current_status carries Live / Delisted / Paused
    liveStatus: pick([
      is('currentstatus'),
      has('current', 'status'),
      is('livestatus', 'islive', 'live'),
      has('live', 'status'),
    ]),
    liveDate:   pick([is('livedate'), has('live', 'date'), has('golive')]),
    delistDate: pick([is('delistdate'), has('delist')]),
    pauseDate:  pick([is('pausedate'), has('pause')]),
    city:       pick([is('city'), has('city')]),
    code:       pick([is('propertyid'), has('property', 'id'), is('propertycode', 'id')]),
  };
}

/**
 * Map whatever the sheet says into the seven MIS buckets.
 * Order matters: "Not Signed" is tested before "Signed", "To Expire" before
 * "Expired", otherwise substrings swallow each other.
 */
function normalizeStatus(raw) {
  const n = norm(raw);
  if (!n) return '';
  if (n.includes('emailconfirm') || n.includes('confirmationemail') || n.includes('confirmationmail')) return 'Email Confirmation';
  if (n.includes('founder') || n.includes('partnerapproved') || n.includes('partnerapproval')) return 'Founder/Partner Approved';
  if (n.includes('notsigned') || n.includes('unsigned') || n.includes('yettosign') || n.includes('pendingsignature') || n.includes('nosign')) return 'Not Signed';
  if (n.includes('toexpire') || n.includes('abouttoexpire') || n.includes('expiringsoon') || n.includes('nearingexpiry') || n.includes('duefor')) return 'To Expire';
  if (n.includes('expired') || n.includes('lapsed')) return 'Expired';
  if (n.includes('valid') || n.includes('signed') || n.includes('executed') || n.includes('active')) return 'Valid';
  return '';
}

const DAY = 86400000;
function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The MIS "Agreement status" is not one column in this table — it is the
 * signing state until a contract exists, then the lifecycle state, then the
 * end date. Resolved in that order, and the Connection check tab reports which
 * source each row actually used.
 */
function resolveAgreementStatus(row, cols, now, windowDays) {
  const signing = normalizeStatus(cols.signing ? row[cols.signing] : '');
  if (signing === 'Not Signed' || signing === 'Email Confirmation' || signing === 'Founder/Partner Approved') {
    return { status: signing, source: cols.signing };
  }

  const lifecycle = normalizeStatus(cols.lifecycle ? row[cols.lifecycle] : '');
  if (lifecycle === 'Valid' || lifecycle === 'To Expire' || lifecycle === 'Expired') {
    return { status: lifecycle, source: cols.lifecycle };
  }

  const end = parseDate(cols.endDate ? row[cols.endDate] : null);
  if (end) {
    const days = Math.floor((end - now) / DAY);
    if (days < 0) return { status: 'Expired', source: `${cols.endDate} (date)` };
    if (days <= windowDays) return { status: 'To Expire', source: `${cols.endDate} (date)` };
    return { status: 'Valid', source: `${cols.endDate} (date)` };
  }

  if (signing) return { status: signing, source: cols.signing };
  if (lifecycle) return { status: lifecycle, source: cols.lifecycle };
  return { status: UNMAPPED, source: null };
}

/** A property is live unless current_status says otherwise, or it is delisted. */
function resolveLive(row, cols, now) {
  const label = norm(cols.liveStatus ? row[cols.liveStatus] : '');
  if (label) {
    if (label.includes('delist') || label.includes('churn') || label.includes('exit') || label.includes('inactive') || label.includes('notlive')) return false;
    if (label.includes('pause') || label.includes('hold')) return false;
    if (label.includes('live') || label.includes('active')) return true;
  }
  const delist = parseDate(cols.delistDate ? row[cols.delistDate] : null);
  if (delist && delist <= now) return false;
  const live = parseDate(cols.liveDate ? row[cols.liveDate] : null);
  if (live) return live <= now;
  return label ? false : null; // null = cannot tell
}

/**
 * Values drift in case and spacing too — "Goa", "GOA", "goa " and "Ooty-Coorg"
 * vs "Ooty Coorg" are all the same squad. Group them on a normalised key and
 * display whichever spelling appears most often, so a single squad can never
 * split into two rows of the pivot.
 */
function buildCanonicalizer(raw, column) {
  const groups = new Map();
  if (!column) return () => BLANK;

  for (const r of raw) {
    const value = clean(r[column]);
    if (!value) continue;
    const key = norm(value);
    if (!groups.has(key)) groups.set(key, new Map());
    const spellings = groups.get(key);
    spellings.set(value, (spellings.get(value) || 0) + 1);
  }

  const chosen = new Map();
  for (const [key, spellings] of groups) {
    const best = [...spellings.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0][0];
    chosen.set(key, best);
  }

  return (v) => {
    const value = clean(v);
    if (!value) return BLANK;
    return chosen.get(norm(value)) || value;
  };
}

function normalizeRows(raw, cols) {
  const canonKam   = buildCanonicalizer(raw, cols.kam);
  const canonKamAlt = buildCanonicalizer(raw, cols.kamAlt);
  const canonSquad = buildCanonicalizer(raw, cols.squad);
  const now = new Date();

  return raw.map((r, i) => {
    const agreement = resolveAgreementStatus(r, cols, now, EXPIRY_WINDOW_DAYS);
    return {
      __i: i,
      __kam:      (() => {
        const primary = canonKam(cols.kam ? r[cols.kam] : '');
        if (primary !== BLANK) return primary;
        const alt = cols.kamAlt && cols.kamAlt !== cols.kam ? canonKamAlt(r[cols.kamAlt]) : BLANK;
        return alt;
      })(),
      __squad:    canonSquad(cols.squad ? r[cols.squad] : ''),
      __statusRaw: [cols.signing && clean(r[cols.signing]), cols.lifecycle && clean(r[cols.lifecycle])].filter(Boolean).join(' / '),
      __status:   agreement.status,
      __source:   agreement.source,
      __property: clean(cols.property ? r[cols.property] : '') || '—',
      __city:     clean(cols.city     ? r[cols.city]     : ''),
      __code:     clean(cols.code     ? r[cols.code]     : ''),
      __url:      clean(cols.url      ? r[cols.url]      : ''),
      __agreementUrl: clean(cols.agreementUrl ? r[cols.agreementUrl] : ''),
      __reason:   clean(cols.reason   ? r[cols.reason]   : ''),
      __endDate:  cols.endDate ? clean(r[cols.endDate]) : '',
      __live:     resolveLive(r, cols, now),
      __raw: r,
    };
  });
}


const authHeaders = () => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
});

/**
 * Postgres table names ARE case-sensitive over PostgREST: a table actually
 * called "Agreement Track" will 404 if .env says "agreement track". So ask the
 * API which tables exist and match on a normalised key.
 */
async function listTables() {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/`, { headers: authHeaders() });
    if (!res.ok) return [];
    const doc = await res.json();
    const fromDefs  = Object.keys(doc.definitions || {});
    const fromPaths = Object.keys(doc.paths || {}).map((p) => p.replace(/^\//, ''));
    return [...new Set([...fromDefs, ...fromPaths])].filter((t) => t && !t.startsWith('rpc/'));
  } catch {
    return [];
  }
}

async function probeTable(name) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${encodeURIComponent(name)}?select=*&limit=1`, {
    headers: authHeaders(),
  });
  return { ok: res.ok, status: res.status, body: res.ok ? '' : await res.text().catch(() => '') };
}

/** Fetch every row, 1000 at a time. Without this the tabs silently cap at 1000. */
async function fetchAllRows(diag) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Check .env (or Vercel → Settings → Environment Variables) and redeploy.');
  }

  diag.projectUrl = SUPABASE_URL;
  diag.tableRequested = SUPABASE_TABLE;
  diag.tableUsed = SUPABASE_TABLE;
  diag.tableAutoCorrected = false;

  // 1. try the configured name
  let probe = await probeTable(SUPABASE_TABLE);
  diag.httpStatus = probe.status;

  // 2. if it isn't there, find it case-insensitively among the real tables
  if (!probe.ok) {
    diag.availableTables = await listTables();
    const match = diag.availableTables.find((t) => norm(t) === norm(SUPABASE_TABLE));
    if (match) {
      diag.tableUsed = match;
      diag.tableAutoCorrected = match !== SUPABASE_TABLE;
      probe = await probeTable(match);
      diag.httpStatus = probe.status;
    }
  }

  if (!probe.ok) {
    const hint = diag.availableTables && diag.availableTables.length
      ? ` Tables this key can see: ${diag.availableTables.join(', ')}.`
      : ' The key could not list any tables, which usually means the anon key is wrong or Row Level Security blocks everything.';
    throw new Error(`Supabase returned ${probe.status} for “${SUPABASE_TABLE}”.${hint} ${probe.body.slice(0, 200)}`);
  }

  const endpoint = `${SUPABASE_URL}/rest/v1/${encodeURIComponent(diag.tableUsed)}?select=*`;
  diag.endpoint = endpoint;

  const out = [];
  let from = 0;

  for (let guard = 0; guard < 60; guard++) {
    const res = await fetch(endpoint, {
      headers: {
        ...authHeaders(),
        'Range-Unit': 'items',
        Range: `${from}-${from + PAGE_SIZE - 1}`,
        Prefer: 'count=exact',
      },
    });

    diag.httpStatus = res.status;

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Supabase returned ${res.status} while reading rows. ${body.slice(0, 240)}`);
    }

    const batch = await res.json();
    out.push(...batch);
    diag.requests = (diag.requests || 0) + 1;

    const total = Number((res.headers.get('content-range') || '').split('/')[1]);
    if (Number.isFinite(total)) diag.reportedTotal = total;
    if (batch.length < PAGE_SIZE) break;
    if (Number.isFinite(total) && out.length >= total) break;
    from += PAGE_SIZE;
  }

  diag.rowsFetched = out.length;
  return out;
}

/* 5 ------------------------------------------------------- state + routing --- */

const VIEWS = [
  { id: 'overview',        label: 'Dashboard',          group: 'Summary' },
  { id: 'squad',           label: 'Squad-wise',         group: 'Summary' },
  { id: 'kam',             label: 'KAM-wise',           group: 'Summary' },
  { id: 'live-properties', label: 'Live Properties',    group: 'Detail'  },
  { id: 'properties',      label: 'Property Details',   group: 'Detail'  },
  { id: 'diagnostics',     label: 'Connection check',   group: 'Setup'   },
];

/* Counts and Valid % tabs are gone — every summary is card-based now. */
const SUBTABS = {
  overview:        [],
  squad:           [],
  kam:             [],
  'live-properties': [],
  properties:      [
    { id: 'all',        label: 'All' },
    { id: 'notsigned',  label: 'Not signed' },
    { id: 'expired',    label: 'Expired' },
    { id: 'toexpire',   label: 'To expire' },
    { id: 'valid',      label: 'Valid' },
  ],
  diagnostics: [
    { id: 'connection', label: 'Connection' },
    { id: 'columns',    label: 'Columns' },
    { id: 'values',     label: 'Status values' },
    { id: 'raw',        label: 'Sample row' },
  ],
};

const state = {
  user: null,
  rows: [],
  raw: [],
  cols: {},
  diag: {},
  loading: true,
  refreshing: false,
  loadedAt: null,
  error: null,
  view: 'overview',
  sub: 'snapshot',
  filters: { squads: [], kams: [], statuses: [] },
  search: '',
  sort: {}, // per view: { key, dir }
  page: {}, // per view: current page of the property list
};

const validView = (v) => VIEWS.some((x) => x.id === v) ? v : 'overview';

function defaultSub(view) {
  const subs = SUBTABS[view] || [];
  return subs.length ? subs[0].id : '';
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
  if (view !== state.view) state.page = {};
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
/* Rows per page in every property list. */
const PAGE_ROWS = 25;

function statusPill(status) {
  const c = STATUS_COLOR[status] || '#d6cec2';
  const dark = ['Valid', 'Expired'].includes(status);
  return el('span', {
    class: 'pill',
    text: status,
    style: `background:${c}; color:${dark ? '#fff' : '#1e1e1e'}`,
  });
}

/* ---- links that open a filtered Property Details tab in this same browser -- */

const DETAIL_TAB = 'vista-tracker-details';

/** URL for Property Details pre-filtered by the given dimensions. */
function detailHref({ status, squad, kam, live } = {}) {
  const p = new URLSearchParams();
  p.set('view', live ? 'live-properties' : 'properties');
  const squads   = squad ? [squad] : state.filters.squads;
  const kams     = kam   ? [kam]   : state.filters.kams;
  const statuses = status ? [status] : state.filters.statuses;
  if (squads.length)   p.set('squad',  squads.join('~'));
  if (kams.length)     p.set('kam',    kams.join('~'));
  if (statuses.length) p.set('status', statuses.join('~'));
  if (state.search) p.set('q', state.search);
  return `${location.pathname}?${p.toString()}`;
}

/**
 * A clickable summary card. Uses a named window target so it lands in another
 * tab of the SAME browser window, and reuses that tab on every later click.
 */
function statCard({ label, value, sub, accent, filter, highlight }) {
  const cls = ['stat', accent ? `accent-${accent}` : '', highlight ? 'stat-hero' : '', filter ? 'stat-link' : '']
    .filter(Boolean).join(' ');
  const body = [
    el('div', { class: 's-label' }, [label, filter ? el('span', { class: 'ext', text: '↗' }) : null]),
    el('div', { class: 's-value', text: value }),
    sub ? el('div', { class: 's-sub', text: sub }) : null,
  ];
  if (!filter) return el('div', { class: cls }, body);
  return el('a', {
    class: cls,
    href: detailHref(filter),
    target: DETAIL_TAB,
    title: 'Opens the matching properties in another tab of this browser',
  }, body);
}

/** The agreement status cards shown at the top of every summary page. */
function statusCards(rows, { live } = {}) {
  const statuses = statusColumns(rows);
  const counts = Object.fromEntries(statuses.map((st) => [st, 0]));
  for (const r of rows) counts[r.__status] = (counts[r.__status] || 0) + 1;
  const total = rows.length;

  const grid = el('div', { class: 'stat-grid' });
  for (const st of statuses) {
    const n = counts[st] || 0;
    if (!n && st === UNMAPPED) continue;
    grid.append(statCard({
      label: st,
      value: fmtInt(n),
      sub: fmtPct(total ? n * 100 / total : null) + ' of scope',
      accent: STATUS_ACCENT[st],
      filter: { status: st, live },
    }));
  }
  return grid;
}

const STATUS_ACCENT = {
  'Valid': 'good',
  'To Expire': 'warn',
  'Expired': 'bad',
  'Not Signed': 'bad',
  'Email Confirmation': 'sky',
  'Founder/Partner Approved': 'violet',
  [UNMAPPED]: '',
};

/** Per-squad / per-KAM card: total plus a mini status breakdown. */
function groupCard(entry, dimension) {
  const filter = dimension === 'squad' ? { squad: entry.key } : { kam: entry.key };
  const statuses = entry.statuses;

  const bar = el('div', { class: 'mini-bar' });
  for (const st of statuses) {
    const n = entry.counts[st] || 0;
    if (!n) continue;
    bar.append(el('div', {
      class: 'mini-seg',
      style: `width:${n * 100 / entry.total}%; background:${STATUS_COLOR[st]}`,
      title: `${st}: ${fmtInt(n)}`,
    }));
  }

  const chips = statuses.filter((st) => entry.counts[st]).map((st) => el('span', { class: 'mini-chip' }, [
    el('span', { class: 'mini-dot', style: `background:${STATUS_COLOR[st]}` }),
    el('span', { class: 'mini-name', text: st }),
    el('span', { class: 'mini-n', text: fmtInt(entry.counts[st]) }),
  ]));

  return el('a', {
    class: 'group-card',
    href: detailHref(filter),
    target: DETAIL_TAB,
    title: `Open ${entry.key} in another tab of this browser`,
  }, [
    el('div', { class: 'gc-head' }, [
      el('div', { class: 'gc-name', text: entry.key }),
      el('div', { class: 'gc-total' }, [fmtInt(entry.total), el('span', { class: 'ext', text: '↗' })]),
    ]),
    bar,
    el('div', { class: 'gc-chips' }, chips),
    el('div', { class: 'gc-foot' }, [
      el('span', { text: `${fmtInt(entry.counts['Valid'] || 0)} valid` }),
      el('span', { class: 'gc-pct', text: fmtPct(entry.validPct) }),
    ]),
  ]);
}

/* ---- paginated property list ------------------------------------------- */

function pageKey() { return `${state.view}:${state.sub}`; }
function currentPage() { return state.page[pageKey()] || 1; }
function setPage(n) { state.page[pageKey()] = n; renderView(); }

function pager(totalRows) {
  const pages = Math.max(1, Math.ceil(totalRows / PAGE_ROWS));
  const page = Math.min(currentPage(), pages);
  const wrap = el('div', { class: 'pager' });
  if (pages <= 1) {
    wrap.append(el('span', { class: 'pager-info', text: `${fmtInt(totalRows)} properties` }));
    return { wrap, page, pages };
  }

  const from = (page - 1) * PAGE_ROWS + 1;
  const to = Math.min(page * PAGE_ROWS, totalRows);
  wrap.append(el('span', { class: 'pager-info', text: `${fmtInt(from)}–${fmtInt(to)} of ${fmtInt(totalRows)}` }));

  const btn = (label, target, disabled, current) => {
    const b = el('button', {
      type: 'button',
      class: `pager-btn${current ? ' current' : ''}`,
      disabled: disabled || undefined,
      'aria-current': current ? 'page' : null,
      text: label,
    });
    if (!disabled && !current) b.addEventListener('click', () => setPage(target));
    return b;
  };

  const nums = [];
  const push = (n) => nums.push(n);
  push(1);
  for (let n = page - 1; n <= page + 1; n++) if (n > 1 && n < pages) push(n);
  if (pages > 1) push(pages);
  const uniq = [...new Set(nums)].sort((a, b) => a - b);

  const group = el('div', { class: 'pager-btns' }, [btn('‹', page - 1, page === 1)]);
  let last = 0;
  for (const n of uniq) {
    if (n - last > 1) group.append(el('span', { class: 'pager-gap', text: '…' }));
    group.append(btn(String(n), n, false, n === page));
    last = n;
  }
  group.append(btn('›', page + 1, page === pages));
  wrap.append(group);
  return { wrap, page, pages };
}

/** Row-level property table. Restacks into cards under 540px via data-label. */
function propertyList(rows, opts = {}) {
  const { wrap: pagerEl, page } = pager(rows.length);
  const slice = rows.slice((page - 1) * PAGE_ROWS, page * PAGE_ROWS);

  const head = ['Property', 'Squad', 'POC', 'Agreement status', 'Ends', 'Link'];
  const body = slice.map((r) => el('tr', {}, [
    el('td', { class: 'freeze', 'data-label': 'Property' }, [
      r.__url
        ? el('a', { class: 'link-out', href: r.__url, target: '_blank', rel: 'noopener noreferrer' }, [r.__property, el('span', { class: 'ext', text: '↗' })])
        : r.__property,
      r.__code ? el('div', { class: 'row-sub', text: r.__code }) : null,
    ]),
    el('td', { 'data-label': 'Squad', style: 'text-align:left', text: r.__squad }),
    el('td', { 'data-label': 'POC', style: 'text-align:left', text: r.__kam }),
    el('td', { 'data-label': 'Agreement status', style: 'text-align:left' }, [
      statusPill(r.__status),
      r.__reason ? el('div', { class: 'row-sub', text: r.__reason }) : null,
    ]),
    el('td', { 'data-label': 'Ends', style: 'text-align:left', text: r.__endDate || '–' }),
    el('td', { 'data-label': 'Link', style: 'text-align:left' }, [
      r.__agreementUrl
        ? el('a', { class: 'link-out', href: r.__agreementUrl, target: '_blank', rel: 'noopener noreferrer' }, ['Agreement', el('span', { class: 'ext', text: '↗' })])
        : el('span', { class: 'zero', text: '–' }),
    ]),
  ]));

  const table = el('table', { class: 'grid stacked' }, [
    el('thead', {}, [el('tr', {}, head.map((h, i) =>
      el('th', { scope: 'col', class: i === 0 ? 'freeze' : '', style: 'text-align:left', text: h })))]),
    el('tbody', {}, body.length ? body : [el('tr', {}, [el('td', { colspan: head.length, class: 'freeze', text: 'No properties match the current filters.' })])]),
  ]);

  return el('div', { class: 'panel' }, [
    el('div', { class: 'panel-head' }, [
      el('h3', { text: opts.title || 'Property details' }),
      el('span', { class: 'hint right', text: `${fmtInt(rows.length)} properties · ${PAGE_ROWS} per page` }),
    ]),
    el('div', { class: 'table-wrap stacked-wrap' }, [table]),
    pagerEl,
  ]);
}

/* 8 -------------------------------------------------------------------- views */

function pageHead(title, desc) {
  return el('div', { class: 'page-head' }, [
    el('h2', { text: title }),
    desc ? el('p', { text: desc }) : null,
  ]);
}

function sectionHead(title, hint) {
  return el('div', { class: 'section-head' }, [
    el('h3', { text: title }),
    hint ? el('span', { class: 'hint', text: hint }) : null,
  ]);
}

/** Aggregate rows by a dimension, newest MIS buckets included. */
function groupBy(rows, field) {
  const statuses = statusColumns(rows);
  const map = new Map();
  for (const r of rows) {
    const key = r[field] || BLANK;
    if (!map.has(key)) map.set(key, { key, total: 0, statuses, counts: Object.fromEntries(statuses.map((st) => [st, 0])) });
    const e = map.get(key);
    if (e.counts[r.__status] === undefined) e.counts[r.__status] = 0;
    e.counts[r.__status] += 1;
    e.total += 1;
  }
  return [...map.values()]
    .map((e) => ({ ...e, validPct: e.total ? (e.counts['Valid'] || 0) * 100 / e.total : null }))
    .sort((a, b) => b.total - a.total || cmp(a.key, b.key));
}

/* ---- Dashboard: live properties only, with a highlighted total ----------- */

function viewOverview(allRows) {
  const live = allRows.filter((r) => r.__live !== false);
  const total = allRows.length;

  const frag = el('div', {}, [
    pageHead('Dashboard', 'Live properties only. Every card opens the matching property details in another tab of this browser.'),
  ]);

  // hero row: agreement summary on the left, highlighted total on the right
  const valid = live.filter((r) => r.__status === 'Valid').length;
  const needsAction = live.filter((r) => ['Not Signed', 'Expired', 'To Expire'].includes(r.__status)).length;

  frag.append(el('div', { class: 'hero-row' }, [
    el('div', { class: 'hero-main' }, [
      sectionHead('Agreement summary', `${fmtInt(live.length)} live properties in scope`),
      statusCards(live, { live: true }),
    ]),
    el('div', { class: 'hero-side' }, [
      statCard({
        label: 'Total properties',
        value: fmtInt(total),
        sub: `${fmtInt(live.length)} live · ${fmtInt(total - live.length)} not live`,
        highlight: true,
        filter: {},
      }),
      statCard({ label: 'Valid agreements', value: fmtInt(valid), sub: fmtPct(live.length ? valid * 100 / live.length : null) + ' of live', accent: 'good', filter: { status: 'Valid', live: true } }),
      statCard({ label: 'Needs action', value: fmtInt(needsAction), sub: 'not signed, expired or expiring', accent: 'bad' }),
    ]),
  ]));

  // status split bar
  const statuses = statusColumns(live);
  const counts = Object.fromEntries(statuses.map((st) => [st, 0]));
  for (const r of live) counts[r.__status] = (counts[r.__status] || 0) + 1;

  const bar = el('div', { class: 'dist-bar' });
  const legend = el('div', { class: 'dist-legend' });
  for (const st of statuses) {
    const n = counts[st] || 0;
    if (!n) continue;
    const pct = n * 100 / live.length;
    bar.append(el('div', { class: 'dist-seg', style: `width:${pct}%; background:${STATUS_COLOR[st]}`, title: `${st}: ${fmtInt(n)}` }));
    legend.append(el('div', { class: 'item' }, [
      el('span', { class: 'swatch', style: `background:${STATUS_COLOR[st]}` }),
      el('span', { text: st }),
      el('span', { class: 'n', text: fmtInt(n) }),
      el('span', { class: 'pct', text: `(${fmtPct(pct)})` }),
    ]));
  }

  frag.append(el('div', { class: 'panel' }, [
    el('div', { class: 'panel-head' }, [
      el('h3', { text: 'Agreement status split — live properties' }),
      el('span', { class: 'hint right', text: `${fmtInt(live.length)} properties` }),
    ]),
    el('div', { class: 'panel-body' }, [bar, legend]),
  ]));

  // squad and POC snapshots
  frag.append(sectionHead('By squad', 'Tap a card to open that squad'));
  frag.append(el('div', { class: 'group-grid' }, groupBy(live, '__squad').map((e) => groupCard(e, 'squad'))));

  frag.append(sectionHead('By POC', 'Tap a card to open that POC'));
  frag.append(el('div', { class: 'group-grid' }, groupBy(live, '__kam').slice(0, 12).map((e) => groupCard(e, 'kam'))));

  return frag;
}

/* ---- Squad-wise / KAM-wise: cards on top, property list below ------------ */

function viewGroup(rows, field, dimension, title, desc) {
  const groups = groupBy(rows, field);

  return el('div', {}, [
    pageHead(title, desc),
    sectionHead('Agreement status', 'Each card opens the matching properties in another tab'),
    statusCards(rows),
    sectionHead(dimension === 'squad' ? 'Squads' : 'POCs', `${fmtInt(groups.length)} in scope · tap to open`),
    el('div', { class: 'group-grid' }, groups.map((e) => groupCard(e, dimension))),
    propertyList(rows, { title: 'Property details' }),
  ]);
}

/* ---- Live Properties: summary cards, then the paginated list ------------- */

function viewLiveProperties(rows) {
  const hasLiveCol = !!(state.cols.liveStatus || state.cols.liveDate || state.cols.delistDate);
  const live = hasLiveCol ? rows.filter((r) => r.__live === true) : rows;

  return el('div', {}, [
    pageHead('Live properties', hasLiveCol
      ? 'Properties currently live, with their agreement position.'
      : 'No live/not-live column was found, so every property is listed.'),
    sectionHead('Agreement summary', `${fmtInt(live.length)} live properties`),
    statusCards(live, { live: true }),
    propertyList(live, { title: 'Live property list' }),
  ]);
}

/* ---- Property Details: the filtered row-level list ---------------------- */

function viewProperties(rows) {
  const bySub = {
    notsigned: 'Not Signed',
    expired:   'Expired',
    toexpire:  'To Expire',
    valid:     'Valid',
  }[state.sub];

  const shown = bySub ? rows.filter((r) => r.__status === bySub) : rows;

  return el('div', {}, [
    pageHead('Property details', 'Every row behind the summaries. Links open in a new tab.'),
    sectionHead('Agreement summary', `${fmtInt(shown.length)} properties in scope`),
    statusCards(shown),
    propertyList(shown, { title: bySub ? `${bySub} agreements` : 'All properties' }),
  ]);
}

/* diagnostics ------------------------------------------------------------- */

const FIELD_DOCS = [
  ['squad',        'Squad-wise summary',      'squad',                     true],
  ['kam',          'KAM-wise summary',        'poc',                       true],
  ['signing',      'Pre-signature statuses',  'contract_signing_status',   true],
  ['lifecycle',    'Valid / expiry statuses', 'contract_lifecycle_status', false],
  ['endDate',      'Expiry fallback',         'agreement_end_date',        false],
  ['property',     'Property names',          'vista_name',                false],
  ['url',          'Property links',          'villa_details_link',        false],
  ['agreementUrl', 'Agreement links',         'agreement_link',            false],
  ['liveStatus',   'Live / not live',         'current_status',            false],
  ['liveDate',     'Live date fallback',      'live_date',                 false],
  ['delistDate',   'Delisted check',          'delist_date',               false],
  ['city',         'City',                    'city',                      false],
  ['code',         'Property ID',             'property_id',               false],
  ['reason',       'Why not signed',          'reason_not_signed',         false],
];

function kv(label, value, tone) {
  return el('tr', {}, [
    el('td', { class: 'freeze', 'data-label': 'Field', style: 'text-align:left', text: label }),
    el('td', { 'data-label': label, style: 'text-align:left' }, [
      tone ? el('span', { class: 'pill', text: value, style: `background:${tone}; color:#1e1e1e` }) : String(value),
    ]),
  ]);
}

function diagnosticsText() {
  const d = state.diag;
  const lines = [
    'VISTA TRACKER — CONNECTION CHECK',
    `Project URL      : ${d.projectUrl || '(not set)'}`,
    `Table in .env    : ${d.tableRequested || '(not set)'}`,
    `Table actually used: ${d.tableUsed || '(none)'}${d.tableAutoCorrected ? '  <-- auto-corrected for case' : ''}`,
    `HTTP status      : ${d.httpStatus ?? '(no response)'}`,
    `Rows fetched     : ${d.rowsFetched ?? 0}${d.reportedTotal != null ? ` of ${d.reportedTotal} reported` : ''}`,
    `Requests made    : ${d.requests ?? 0}`,
    d.availableTables ? `Tables visible   : ${d.availableTables.join(', ')}` : null,
    state.error ? `ERROR            : ${state.error}` : null,
    '',
    'COLUMN MAPPING',
    ...FIELD_DOCS.map(([f, use]) => `  ${use.padEnd(22)} -> ${state.cols[f] || 'NOT FOUND'}`),
    '',
    `ALL COLUMNS IN TABLE (${(d.allColumns || []).length})`,
    `  ${(d.allColumns || []).join(' | ') || '(none)'}`,
    '',
    'STATUS VALUES FOUND',
    ...(d.statusMap || []).map((s) => `  "${s.raw}" -> ${s.bucket}  [via ${s.source || 'nothing matched'}]  (${s.count})`),
  ];
  return lines.filter((l) => l !== null).join('\n');
}

function viewDiagnostics() {
  const d = state.diag;
  const frag = el('div', {}, [
    pageHead('Connection check', 'Exactly what the app asked Supabase for, what came back, and how each column was matched. If a tab is empty, the answer is on this page.'),
  ]);

  if (state.sub === 'connection') {
    const rows = [
      kv('Project URL', d.projectUrl || '(not set)'),
      kv('Table name in .env', d.tableRequested || '(not set)'),
      kv('Table actually read', d.tableUsed || '(none)', d.tableAutoCorrected ? '#fcd4a8' : null),
      kv('Request URL', d.endpoint || '(never reached)'),
      kv('HTTP status', String(d.httpStatus ?? 'no response'), d.httpStatus === 200 || d.httpStatus === 206 ? '#a8d5bd' : '#e9a0a7'),
      kv('Rows fetched', `${fmtInt(d.rowsFetched || 0)}${d.reportedTotal != null ? ` (table reports ${fmtInt(d.reportedTotal)})` : ''}`),
      kv('Paged requests', String(d.requests || 0)),
    ];
    if (d.availableTables) rows.push(kv('Tables this key can see', d.availableTables.join(', ') || '(none)'));

    frag.append(el('div', { class: 'panel' }, [
      el('div', { class: 'panel-head' }, [el('h3', { text: 'Where the data comes from' })]),
      el('div', { class: 'table-wrap stacked-wrap' }, [
        el('table', { class: 'grid stacked' }, [
          el('thead', {}, [el('tr', {}, [
            el('th', { scope: 'col', class: 'freeze', style: 'text-align:left', text: 'Setting' }),
            el('th', { scope: 'col', style: 'text-align:left', text: 'Value' }),
          ])]),
          el('tbody', {}, rows),
        ]),
      ]),
    ]));

    if (d.tableAutoCorrected) {
      frag.append(el('div', { class: 'panel' }, [
        el('div', { class: 'panel-body' }, [
          el('p', { style: 'margin:0', html: `Your <code>.env</code> says <code>${d.tableRequested}</code> but the real table is <code>${d.tableUsed}</code>. The app corrected this automatically — update <code>.env</code> to match and you save one round trip on every load.` }),
        ]),
      ]));
    }

    const copy = el('button', { type: 'button', class: 'reset-btn', text: 'Copy this report' });
    copy.addEventListener('click', async () => {
      const text = diagnosticsText();
      try { await navigator.clipboard.writeText(text); copy.textContent = 'Copied'; }
      catch { window.prompt('Copy the text below:', text); }
      setTimeout(() => { copy.textContent = 'Copy this report'; }, 1800);
    });

    frag.append(el('div', { class: 'panel' }, [
      el('div', { class: 'panel-head' }, [el('h3', { text: 'Send this if something still looks wrong' })]),
      el('div', { class: 'panel-body' }, [
        el('p', { style: 'margin:0 0 12px', text: 'This copies the whole report as plain text — table name, status code, column mapping and every status value found. It contains no keys or property data.' }),
        copy,
      ]),
    ]));
    return frag;
  }

  if (state.sub === 'columns') {
    const body = FIELD_DOCS.map(([field, use, expected, required]) => {
      const found = state.cols[field];
      const sample = found && state.raw.length
        ? clean(state.raw.find((r) => clean(r[found]))?.[found] ?? '')
        : '';
      return el('tr', {}, [
        el('td', { class: 'freeze', 'data-label': 'Used for', style: 'text-align:left', text: use }),
        el('td', { 'data-label': 'Expected', style: 'text-align:left', text: expected }),
        el('td', { 'data-label': 'Column found', style: 'text-align:left' }, [
          found
            ? el('span', { class: 'pill', text: found, style: 'background:#a8d5bd; color:#1e1e1e' })
            : el('span', { class: 'pill', text: required ? 'NOT FOUND — required' : 'not found — optional', style: `background:${required ? '#e9a0a7' : '#ebe6de'}; color:#1e1e1e` }),
        ]),
        el('td', { 'data-label': 'Sample value', style: 'text-align:left', text: sample || '—' }),
      ]);
    });

    const used = new Set(Object.values(state.cols).filter(Boolean));
    const spare = (d.allColumns || []).filter((c) => !used.has(c));

    frag.append(el('div', { class: 'panel' }, [
      el('div', { class: 'panel-head' }, [
        el('h3', { text: 'How each column was matched' }),
        el('span', { class: 'hint right', text: 'Matching ignores case, spaces and punctuation' }),
      ]),
      el('div', { class: 'table-wrap stacked-wrap' }, [
        el('table', { class: 'grid stacked' }, [
          el('thead', {}, [el('tr', {}, ['Used for', 'Expected heading', 'Column found', 'Sample value'].map((h, i) =>
            el('th', { scope: 'col', class: i === 0 ? 'freeze' : '', style: 'text-align:left', text: h })))]),
          el('tbody', {}, body),
        ]),
      ]),
    ]));

    frag.append(el('div', { class: 'panel' }, [
      el('div', { class: 'panel-head' }, [
        el('h3', { text: 'Other columns in the table' }),
        el('span', { class: 'hint right', text: `${fmtInt(spare.length)} unused` }),
      ]),
      el('div', { class: 'panel-body' }, [
        spare.length
          ? el('div', { style: 'display:flex; flex-wrap:wrap; gap:6px' }, spare.map((c) =>
              el('span', { class: 'chip' }, [el('span', { class: 'chip-val', text: c })])))
          : el('p', { style: 'margin:0', text: 'Every column in the table is being used.' }),
      ]),
    ]));
    return frag;
  }

  if (state.sub === 'values') {
    const map = d.statusMap || [];
    const bad = map.filter((s) => s.bucket === UNMAPPED);

    frag.append(el('div', { class: 'panel' }, [
      el('div', { class: 'panel-head' }, [
        el('h3', { text: 'Every status value in the table, and where it lands' }),
        el('span', { class: 'hint right', text: `${fmtInt(map.length)} distinct values` }),
      ]),
      el('div', { class: 'table-wrap stacked-wrap' }, [
        el('table', { class: 'grid stacked' }, [
          el('thead', {}, [el('tr', {}, [
            el('th', { scope: 'col', class: 'freeze', style: 'text-align:left', text: 'Value in the table' }),
            el('th', { scope: 'col', style: 'text-align:left', text: 'Counted as' }),
            el('th', { scope: 'col', style: 'text-align:left', text: 'Decided by' }),
            el('th', { scope: 'col', text: 'Rows' }),
          ])]),
          el('tbody', {}, map.length ? map.map((s) => el('tr', {}, [
            el('td', { class: 'freeze', 'data-label': 'Value', style: 'text-align:left', text: s.raw || '(blank)' }),
            el('td', { 'data-label': 'Counted as', style: 'text-align:left' }, [statusPill(s.bucket)]),
            el('td', { 'data-label': 'Decided by', style: 'text-align:left', text: s.source || 'nothing matched' }),
            el('td', { 'data-label': 'Rows', text: fmtInt(s.count) }),
          ])) : [el('tr', {}, [el('td', { colspan: 4, class: 'freeze', text: 'No rows loaded.' })])]),
        ]),
      ]),
    ]));

    if (bad.length) {
      frag.append(el('div', { class: 'panel' }, [
        el('div', { class: 'panel-body' }, [
          el('p', { style: 'margin:0', html: `${bad.length} value(s) did not match any of the seven MIS buckets and are being counted under <strong>Unmapped</strong>. Send me the exact spellings and I will add them to <code>normalizeStatus()</code>.` }),
        ]),
      ]));
    }
    return frag;
  }

  // raw sample
  const sample = state.raw[0];
  frag.append(el('div', { class: 'panel' }, [
    el('div', { class: 'panel-head' }, [
      el('h3', { text: 'First row exactly as Supabase returned it' }),
      el('span', { class: 'hint right', text: 'Column names on the left are the real ones' }),
    ]),
    el('div', { class: 'panel-body' }, [
      sample
        ? el('pre', {
            style: 'margin:0; overflow-x:auto; font-size:12px; line-height:1.6; background:var(--surface-2); padding:12px; border-radius:8px',
            text: JSON.stringify(sample, null, 2),
          })
        : el('p', { style: 'margin:0', text: 'No rows came back, so there is nothing to show. Check the Connection tab.' }),
    ]),
  ]));
  return frag;
}

/* 9 ------------------------------------------------------------------- chrome */

function renderSidebar() {
  const nav = $('#sidebar');
  nav.replaceChildren();

  const rows = activeRows();
  const countFor = {
    overview: rows.filter((r) => r.__live !== false).length,
    squad: new Set(rows.map((r) => r.__squad)).size,
    kam: new Set(rows.map((r) => r.__kam)).size,
    properties: rows.length,
    'live-properties': rows.filter((r) => r.__live !== false).length,
  };

  for (const group of ['Summary', 'Detail', 'Setup']) {
    const g = el('div', { class: 'nav-group' }, [el('div', { class: 'nav-label', text: group })]);

    for (const v of VIEWS.filter((x) => x.group === group)) {

      const a = el('a', {
        class: 'nav-item',
        href: urlFor(v.id, defaultSub(v.id)),
        'aria-current': state.view === v.id ? 'page' : null,
      }, [
        el('span', { class: 'dot' }),
        el('span', { class: 'label', text: v.label }),
        countFor[v.id] === undefined ? null : el('span', { class: 'nav-count', text: fmtInt(countFor[v.id]) }),
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

  if (state.loading || state.error || !state.rows.length || state.view === 'diagnostics') {
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
  state.page = {};
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
    const details = el('button', { type: 'button', text: 'Connection check' });
    details.addEventListener('click', () => go('diagnostics'));
    root.append(el('div', { class: 'state error' }, [
      el('h3', { text: 'Could not load the data' }),
      el('p', { text: state.error }),
      el('p', { html: 'If the table is found but comes back empty, it is almost always Row Level Security — add a <code>SELECT</code> policy on the table in Supabase.' }),
      el('div', { style: 'display:flex; gap:8px; flex-wrap:wrap; justify-content:center' }, [retry, details]),
    ]));
    if (state.view === 'diagnostics') root.append(viewDiagnostics());
    return;
  }

  if (!state.rows.length) {
    const details = el('button', { type: 'button', text: 'Connection check' });
    details.addEventListener('click', () => go('diagnostics'));
    root.append(el('div', { class: 'state' }, [
      el('h3', { text: 'No rows came back' }),
      el('p', { html: `<code>${state.diag.tableUsed || SUPABASE_TABLE}</code> answered, but returned zero rows. That is almost always a missing <code>SELECT</code> policy under Supabase → Authentication → Policies.` }),
      details,
    ]));
    if (state.view === 'diagnostics') root.append(viewDiagnostics());
    return;
  }

  const rows = activeRows();

  // A missing required column means the pivots would quietly read "(blank)"
  const missing = [['squad', 'squad'], ['kam', 'poc'], ['signing', 'contract_signing_status']]
    .filter(([f]) => !state.cols[f]);
  if (missing.length && state.view !== 'diagnostics') {
    const link = el('button', { type: 'button', class: 'reset-btn', text: 'Open Connection check' });
    link.addEventListener('click', () => go('diagnostics'));
    root.append(el('div', { class: 'panel', style: 'border-color:#e8c9c7; background:var(--bad-bg)' }, [
      el('div', { class: 'panel-body' }, [
        el('p', { style: 'margin:0 0 10px' }, [
          `The table loaded, but no column matched ${missing.map(([, l]) => `“${l}”`).join(' or ')}. Those figures will read “(blank)” until the column is found.`,
        ]),
        link,
      ]),
    ]));
  }

  switch (state.view) {
    case 'diagnostics':
      root.append(viewDiagnostics());
      return;
    case 'squad':
      root.append(viewGroup(rows, '__squad', 'squad', 'Squad-wise summary',
        'Agreement position by squad. Cards open filtered property details in another tab of this browser.'));
      break;
    case 'kam':
      root.append(viewGroup(rows, '__kam', 'kam', 'KAM-wise summary',
        'Agreement position by Owner Facing POC. Cards open filtered property details in another tab of this browser.'));
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
  $('#sidebar')?.classList.add('open');
  $('#nav-toggle')?.setAttribute('aria-expanded', 'true');
  const scrim = $('#scrim');
  if (scrim) {
    scrim.hidden = false;
    requestAnimationFrame(() => scrim.classList.add('show'));
  }
  document.body.style.overflow = 'hidden';
}

function closeDrawer() {
  $('#sidebar')?.classList.remove('open');
  $('#nav-toggle')?.setAttribute('aria-expanded', 'false');
  const scrim = $('#scrim');
  if (scrim) {
    scrim.classList.remove('show');
    setTimeout(() => { scrim.hidden = true; }, 200);
  }
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

async function boot(isRefresh = false) {
  if (state.refreshing) return;
  state.refreshing = true;
  paintRefresh();

  // A refresh keeps the current tab and filters on screen while it reloads
  state.loading = !isRefresh || !state.rows.length;
  state.error = null;
  state.diag = {};
  if (state.loading) render();

  try {
    const raw = await fetchAllRows(state.diag);
    state.raw = raw;
    state.cols = resolveColumns(raw[0]);
    state.rows = normalizeRows(raw, state.cols);

    // every column the table actually has — union, in case rows differ
    const all = new Set();
    for (const r of raw.slice(0, 50)) Object.keys(r).forEach((k) => all.add(k));
    state.diag.allColumns = [...all];

    // every distinct source-value combination and the bucket it produced
    const seen = new Map();
    for (const r of state.rows) {
      const key = `${r.__statusRaw}||${r.__status}||${r.__source || 'derived'}`;
      if (!seen.has(key)) seen.set(key, { raw: r.__statusRaw, bucket: r.__status, source: r.__source, count: 0 });
      seen.get(key).count += 1;
    }
    state.diag.statusMap = [...seen.values()].sort((a, b) => b.count - a.count);

    state.error = null;
  } catch (err) {
    state.error = err.message || String(err);
    state.rows = [];
    state.raw = [];
  } finally {
    state.loading = false;
    state.refreshing = false;
    state.loadedAt = new Date();
    render();
    paintRefresh();
  }
}

/** Topbar refresh button: spinner while loading, last-updated time when idle. */
function paintRefresh() {
  const btn = $('#refresh-btn');
  const stamp = $('#last-updated');
  if (!btn) return;
  btn.classList.toggle('spinning', !!state.refreshing);
  btn.disabled = !!state.refreshing;
  btn.setAttribute('aria-busy', state.refreshing ? 'true' : 'false');
  btn.title = state.refreshing ? 'Reloading from Supabase…' : 'Reload from Supabase';
  if (stamp) {
    stamp.textContent = state.refreshing
      ? 'Refreshing…'
      : state.loadedAt
        ? `Updated ${state.loadedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
        : '';
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
  $('#refresh-btn')?.addEventListener('click', () => boot(true));

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
