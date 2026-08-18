/* VISTA-TRACKER BUILD MARKER: EXPIRED-READS-COLUMN-v2 — if you see 209 Expired, this file is live */
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

/* Supabase's Data API page shows the URL with /rest/v1/ already on the end, so
   accept it either way rather than failing on a reasonable copy-paste. */
const SUPABASE_URL = (ENV.VITE_SUPABASE_URL || '')
  .trim()
  .replace(/\/+$/, '')
  .replace(/\/rest\/v1$/i, '')
  .replace(/\/+$/, '');
const SUPABASE_KEY   = ENV.VITE_SUPABASE_ANON_KEY || '';
const SUPABASE_TABLE = ENV.VITE_SUPABASE_TABLE || 'agreement track';




const PAGE_SIZE = 1000; // Supabase returns at most 1000 rows per request

/* How many days before agreement_end_date counts as "To Expire". */
const EXPIRY_WINDOW_DAYS = Number(ENV.VITE_EXPIRY_WINDOW_DAYS) || 90;

/* The seven MIS columns, in MIS order. "Grand Total" is derived. */
/* Card display order requested by the team. Internal bucket names in comments. */
const STATUS_ORDER = [
  'Valid',                     // 1. Valid
  'Founder/Partner Approved',  // 2. Founder Approved
  'Not Signed',                // 3. Pending
  'To Expire',                 // 4. Expiring Soon
  'Expired',                   // 5. Expired
  'Email Confirmation',        // 6. Draft / In Progress
];

const UNMAPPED = 'Unmapped';

/* Brand palette (StayVista): Sky #9CCDFB · Bloom #E9A0A7 · Shine #FDD5A9 ·
   Sage #A8C8A8. Reds/greens are darkened brand-adjacent tones for legibility. */
const STATUS_COLOR = {
  'Email Confirmation':       '#9ccdfb', // SV-Sky
  'Expired':                  '#c65f5b', // deepened bloom-red, legible on white
  'Founder/Partner Approved': '#a8c8a8', // SV-Sage
  'Not Signed':               '#e9a0a7', // SV-Bloom
  'To Expire':                '#fdd5a9', // SV-Shine
  'Valid':                    '#3f8f6b', // deepened sage-green
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
    // post-signature / current agreement status: Valid / To Expire / Expired.
    // The AQ column is now "Current Contract Status".
    lifecycle: pick([
      is('currentcontractstatus'),
      has('current', 'contract', 'status'),
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
    // current_status carries Live / Delisted / Paused. Must NOT match
    // "Current Contract Status" (the agreement column), so exclude "contract".
    liveStatus: pick([
      is('currentstatus'),
      (c) => c.n.includes('current') && c.n.includes('status') && !c.n.includes('contract'),
      is('livestatus', 'islive', 'live'),
      has('live', 'status'),
    ]),
    liveDate:   pick([is('livedate'), has('live', 'date'), has('golive')]),
    delistDate: pick([is('delistdate'), has('delist')]),
    pauseDate:  pick([is('pausedate'), has('pause')]),
    city:       pick([is('city'), has('city')]),
    code:       pick([is('propertyid'), has('property', 'id'), is('propertycode', 'id')]),
    // the *unit-level* name, used only to tell apart rows that share a Property ID
    propertyName: pick([is('propertyname'), has('property', 'name')]),
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
  // "Not live yet" is a pre-agreement state in the Contract Status column;
  // group it with Not Signed rather than dropping it to Unmapped.
  if (n.includes('notliveyet') || n.includes('notyetlive')) return 'Not Signed';
  if (n.includes('emailconfirm') || n.includes('confirmationemail') || n.includes('confirmationmail')) return 'Email Confirmation';
  if (n.includes('founder') || n.includes('partnerapproved') || n.includes('partnerapproval')) return 'Founder/Partner Approved';
  if (n.includes('notsigned') || n.includes('unsigned') || n.includes('yettosign') || n.includes('pendingsignature') || n.includes('nosign')) return 'Not Signed';
  if (n.includes('toexpire') || n.includes('abouttoexpire') || n.includes('expiringsoon') || n.includes('nearingexpiry') || n.includes('duefor')) return 'To Expire';
  if (n.includes('expired') || n.includes('lapsed')) return 'Expired';
  if (n.includes('valid') || n.includes('signed') || n.includes('executed') || n.includes('active')) return 'Valid';
  return '';
}

/**
 * The table has two status columns whose names differ only by capitalisation
 * ("Contract status" and "Contract Status"), so the name tells us nothing about
 * which is which. Work it out from the values instead: whichever column carries
 * the pre-signature wording is the signing column, whichever carries the
 * expiry wording is the lifecycle column.
 */
const PRE_SIGNATURE = ['Not Signed', 'Email Confirmation', 'Founder/Partner Approved'];
const POST_SIGNATURE = ['Expired', 'To Expire'];

function detectStatusColumns(raw) {
  const keys = Object.keys(raw[0] || {});
  const candidates = keys.filter((k) => {
    const n = norm(k);
    // The AQ column is now "Current Contract Status" — keep any column that
    // mentions "contract" or "agreement" (these are the status columns), and
    // only exclude the live/delisted column, which is "current status" WITHOUT
    // the word "contract".
    const isLiveStatus = n.includes('current') && n.includes('status') && !n.includes('contract') && !n.includes('agreement');
    if (isLiveStatus) return false;
    return (n.includes('status') || n.includes('contract') || n.includes('agreement'))
      && !n.includes('date')
      && !n.includes('link');
  });

  const sample = raw.length > 3000 ? raw.slice(0, 3000) : raw;
  const scored = candidates.map((key) => {
    let pre = 0, post = 0, valid = 0, mapped = 0, filled = 0, signedExact = 0;
    for (const r of sample) {
      const v = r[key];
      if (!clean(v)) continue;
      filled += 1;
      // "Signed" (but not "Not Signed") only ever appears in the signing column
      const n = norm(v);
      if (n === 'signed') signedExact += 1;
      const bucket = normalizeStatus(v);
      if (!bucket) continue;
      mapped += 1;
      if (PRE_SIGNATURE.indexOf(bucket) !== -1) pre += 1;
      else if (POST_SIGNATURE.indexOf(bucket) !== -1) post += 1;
      else if (bucket === 'Valid') valid += 1;
    }
    return { key, pre, post, valid, mapped, filled, signedExact };
  }).filter((c) => c.mapped > 0 || c.signedExact > 0);

  const best = (metric) => scored.slice()
    .sort((a, b) => b[metric] - a[metric] || b.mapped - a.mapped)[0];

  // The signing column is the one that actually contains the literal "Signed".
  // Only if none does do we fall back to the pre-signature heuristic.
  const signedCol = scored.slice().sort((a, b) => b.signedExact - a.signedExact)[0];
  const signingBest = (signedCol && signedCol.signedExact > 0) ? signedCol : best('pre');

  // Lifecycle = the CURRENT contract status column (AQ). It's the one with
  // post-signature values (Expired / To Expire); if none stands out, it's the
  // status column that ISN'T the signing column. Never leave it null when a
  // status column exists, or every row falls through to Unmapped.
  let lifecycleBest = best('post');
  if (!lifecycleBest || lifecycleBest.post === 0) {
    lifecycleBest = scored.find((c) => !signingBest || c.key !== signingBest.key) || scored[0];
  }

  return {
    signing: signingBest ? signingBest.key : (scored[0] ? scored[0].key : null),
    lifecycle: lifecycleBest ? lifecycleBest.key : null,
    scored,
  };
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
  // Count purely from the CURRENT contract status column (AQ / "Contract Status",
  // capital S), taken at face value. Column N ("Contract status", small s) is the
  // historical entry status and is intentionally ignored.
  const current = normalizeStatus(cols.lifecycle ? row[cols.lifecycle] : '');
  if (current) return { status: current, source: cols.lifecycle };
  return { status: UNMAPPED, source: null };
}

/**
 * Live / not live / unknown.
 *
 * Deliberately strict: a row is only live if something actually says so. An
 * unreadable status used to fall through to "has a live date, therefore live",
 * which quietly inflated the live count above what the sheet reports.
 */
function resolveLive(row, cols, now) {
  // Match the sheet's definition exactly: a property is live if, and only if,
  // its Current Status column says "Live". No delist-date or live-date
  // inference — that used to add rows the sheet's Current Status filter excludes.
  const label = norm(cols.liveStatus ? row[cols.liveStatus] : '');
  if (!label) return null;              // no status value → unknown, not counted live
  return label === 'live';              // only exactly "Live" counts
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
      __liveDateObj: parseDate(cols.liveDate ? r[cols.liveDate] : null),
      __endDateObj:  parseDate(cols.endDate ? r[cols.endDate] : null),
      __delistObj:   parseDate(cols.delistDate ? r[cols.delistDate] : null),
      __live:     resolveLive(r, cols, now),
      // "new property, no agreement yet": live, but validity AND signing blank
      __newNoAgreement: (() => {
        const val = cols.lifecycle ? clean(r[cols.lifecycle]) : '';
        const sig = cols.signing ? clean(r[cols.signing]) : '';
        return !val && !sig;
      })(),
      __raw: r,
    };
  });
  // No deduplication: the dashboard counts every row exactly as the sheet does,
  // so the live total matches the sheet's filtered row count (e.g. 1,219).
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

// fetch that gives up after `ms` so a stalled request shows an error instead
// of spinning on "Loading" forever.
async function fetchWithTimeout(url, options = {}, ms = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error(`The request to Supabase took longer than ${Math.round(ms / 1000)}s and was stopped. The table may be very large or the connection is slow — try Refresh, or check your network.`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function probeTable(name) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${encodeURIComponent(name)}?select=*&limit=1`, {
    headers: authHeaders(),
  });
  return { ok: res.ok, status: res.status, body: res.ok ? '' : await res.text().catch(() => '') };
}

/** Fetch every row, 1000 at a time. Without this the tabs silently cap at 1000. */
async function fetchTable(tableName) {
  // Best-effort read of an optional table; returns [] if it isn't there yet.
  if (!SUPABASE_URL || !SUPABASE_KEY) return [];
  try {
    const out = [];
    let from = 0;
    for (let guard = 0; guard < 40; guard++) {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/${encodeURIComponent(tableName)}?select=*`, {
        headers: { ...authHeaders(), 'Range-Unit': 'items', Range: `${from}-${from + PAGE_SIZE - 1}` },
      });
      if (!res.ok) return out;
      const batch = await res.json();
      out.push(...batch);
      if (batch.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }
    return out;
  } catch {
    return [];
  }
}

async function fetchChurnRef() {
  // Best-effort: if the churn_ref table isn't there yet, return [] so the
  // dashboard still works and falls back to simple churn.
  if (!SUPABASE_URL || !SUPABASE_KEY) return [];
  try {
    const out = [];
    let from = 0;
    for (let guard = 0; guard < 30; guard++) {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/churn_ref?select=*`, {
        headers: { ...authHeaders(), 'Range-Unit': 'items', Range: `${from}-${from + PAGE_SIZE - 1}` },
      });
      if (!res.ok) return out;              // table missing or blocked → give up quietly
      const batch = await res.json();
      out.push(...batch);
      if (batch.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }
    return out;
  } catch {
    return [];
  }
}

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
    const res = await fetchWithTimeout(endpoint, {
      headers: {
        ...authHeaders(),
        'Range-Unit': 'items',
        Range: `${from}-${from + PAGE_SIZE - 1}`,
        Prefer: 'count=planned',
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
  { id: 'overview',        label: 'Live Properties',    group: 'Summary' },
  { id: 'squad',           label: 'Squad-wise',         group: 'Summary' },
  { id: 'kam',             label: 'KAM-wise',           group: 'Summary' },
  { id: 'properties',      label: 'Property Details',   group: 'Detail'  },
];

/* Counts and Valid % tabs are gone — every summary is card-based now. */
const SUBTABS = {
  overview:        [],
  squad:           [],
  kam:             [],
  properties:      [],   // status filtering comes from the cards + the STATUS filter
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
  churnRef: [],
  churnAnalysis: [],
  gcfMarginal: [],
  misSquadChurn: [],
  misMonthlyChurn: [],
  caSquad: null,
  caMonth: null,
  caKam: null,
  cd: {},
  cdFilters: {},
  cdReturn: 'squad',
  cdPage: 1,
  mlFilter: {},
  mlReturn: 'overview',
  mlPage: 1,
  cols: {},
  diag: {},
  loading: true,
  refreshing: false,
  loadedAt: null,
  error: null,
  view: 'overview',
  sub: 'snapshot',
  filters: { squads: [], kams: [], statuses: [], newNoAgreement: false },
  period: { month: '', year: '' },   // filter on live_date
  search: '',
  focus: false,        // drilled-in view: back button shown, summary cards hidden
  returnTo: null,      // where the Back button returns to
  sort: {}, // per view: { key, dir }
  page: {}, // per view: current page of the property list
};

const EXTRA_VIEWS = ['churned', 'churn-detail', 'churn-rate', 'master-list', 'diagnostics'];
const validView = (v) => (v === 'live-properties') ? 'overview'
  : (VIEWS.some((x) => x.id === v) || EXTRA_VIEWS.includes(v)) ? v : 'overview';

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
  state.period.month = p.get('m') || '';
  state.period.year  = p.get('y') || '';
  // the top month filter (numeric 1-12) also drives the churn section's month
  if (state.period.month) {
    const n = Number(state.period.month);
    if (n >= 1 && n <= 12) state.caMonth = MONTH_NAMES[n - 1];
  }
  state.search = p.get('q') || '';
  state.focus = p.get('focus') === '1';
  state.filters.newNoAgreement = p.get('newna') === '1';
  state.caSquad = p.get('casquad') || null;
  state.caKam = p.get('cakam') || null;
  state.cd = {
    gcfLow: p.get('cgcf') === '1',
    initiatedBy: p.get('cby') || null,
    fnb: p.get('cfnb') || null,
    reason: p.get('creason') || null,
  };
}

function urlFor(view, sub) {
  const p = new URLSearchParams();
  if (view && view !== 'overview') p.set('view', view);
  const s = sub || (view === state.view ? state.sub : defaultSub(view));
  if (s && s !== defaultSub(view)) p.set('tab', s);
  if (state.filters.squads.length)   p.set('squad',  state.filters.squads.join('~'));
  if (state.filters.kams.length)     p.set('kam',    state.filters.kams.join('~'));
  if (state.filters.statuses.length) p.set('status', state.filters.statuses.join('~'));
  if (state.period.month) p.set('m', state.period.month);
  if (state.period.year)  p.set('y', state.period.year);
  if (state.search) p.set('q', state.search);
  if (state.focus) p.set('focus', '1');
  if (state.filters.newNoAgreement) p.set('newna', '1');
  if (state.caSquad) p.set('casquad', state.caSquad);
  if (state.caKam) p.set('cakam', state.caKam);
  const qs = p.toString();
  return qs ? `?${qs}` : location.pathname;
}

function syncUrl() {
  history.replaceState(null, '', urlFor(state.view, state.sub));
}

// Simple navigation history so "back" always returns to the actual previous
// page, however deep you drill. Each entry captures the view + the scope needed
// to reconstruct it (filters, churn drill state, master-list filter).
const navStack = [];

function pushNav() {
  navStack.push({
    view: state.view,
    filters: JSON.parse(JSON.stringify(state.filters)),
    search: state.search,
    focus: state.focus,
    caSquad: state.caSquad, caKam: state.caKam, caMonth: state.caMonth,
    cd: state.cd ? { ...state.cd } : {},
    cdFilters: state.cdFilters ? { ...state.cdFilters } : {},
    mlFilter: state.mlFilter ? { ...state.mlFilter } : {},
  });
  if (navStack.length > 50) navStack.shift();   // keep it bounded
}

function goBackHistory(fallback = 'overview') {
  const prev = navStack.pop();
  if (!prev) { go(fallback); return; }
  state.filters = prev.filters;
  state.search = prev.search;
  state.focus = prev.focus;
  state.caSquad = prev.caSquad; state.caKam = prev.caKam; state.caMonth = prev.caMonth;
  state.cd = prev.cd; state.cdFilters = prev.cdFilters; state.mlFilter = prev.mlFilter;
  state.page = {};
  state.view = validView(prev.view);
  state.sub = defaultSub(state.view);
  syncUrl();
  render();
  window.scrollTo({ top: 0, behavior: 'auto' });
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

/** Return from a drilled-in card view to wherever the click came from. */
function goBack() {
  // prefer the navigation history stack (reliable for deep drills)
  if (navStack.length) { goBackHistory('overview'); return; }
  const r = state.returnTo;
  state.focus = false;
  state.returnTo = null;
  state.page = {};
  if (r) {
    state.filters = r.filters;
    state.search = r.search;
    state.view = validView(r.view);
  } else {
    // opened directly via a focus URL (e.g. Ctrl-click tab) → go to the summary
    state.filters = { squads: [], kams: [], statuses: [] };
    state.search = '';
    state.view = 'overview';
  }
  state.sub = defaultSub(state.view);
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
function inPeriod(r) {
  const { month, year } = state.period;
  if (!month && !year) return true;
  const d = r.__liveDateObj;
  if (!d) return false;   // no live date can't match a period filter
  if (year && String(d.getFullYear()) !== String(year)) return false;
  if (month && String(d.getMonth() + 1) !== String(month)) return false;
  return true;
}

function filterRows(skip = null) {
  const { squads, kams, statuses } = state.filters;
  return state.rows.filter((r) =>
    (skip === 'squad'  || !squads.length   || squads.includes(r.__squad)) &&
    (skip === 'kam'    || !kams.length     || kams.includes(r.__kam)) &&
    (skip === 'status' || !statuses.length || statuses.includes(r.__status)) &&
    (skip === 'newna'  || !state.filters.newNoAgreement || r.__newNoAgreement) &&
    (skip === 'period' || inPeriod(r)) &&
    (skip === 'search' || matchesSearch(r, state.search))
  );
}

function activeRows() { return filterRows(null); }

function hasAnyFilter() {
  const f = state.filters;
  return !!(f.squads.length || f.kams.length || f.statuses.length || f.newNoAgreement || state.period.month || state.period.year || state.search);
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
function detailHref({ status, squad, kam, live, newNoAgreement } = {}) {
  const p = new URLSearchParams();
  p.set('view', 'properties');   // drilled-in list always lives on Property Details
  if (newNoAgreement) p.set('newna', '1');
  const squads   = squad ? [squad] : state.filters.squads;
  const kams     = kam   ? [kam]   : state.filters.kams;
  const statuses = status ? [status] : state.filters.statuses;
  if (squads.length)   p.set('squad',  squads.join('~'));
  if (kams.length)     p.set('kam',    kams.join('~'));
  if (statuses.length) p.set('status', statuses.join('~'));
  if (state.search) p.set('q', state.search);
  p.set('focus', '1');   // marks a drilled-in view (back button, cards hidden)
  return `${location.pathname}?${p.toString()}`;
}

/**
 * Normal click → filter in place (fast, no new tab). It records where we came
 * from so the Back button can return there, applies the card's filter, and
 * jumps to Property Details. Modifier/middle clicks fall through to the browser
 * so Ctrl/Cmd-click still opens the same URL in a genuine new tab.
 */
function cardClickHandler(filter) {
  return (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return; // let the browser open a new tab
    e.preventDefault();

    state.returnTo = { view: state.view, filters: JSON.parse(JSON.stringify(state.filters)), search: state.search };
    pushNav();
    if (filter.status) state.filters.statuses = [filter.status];
    if (filter.squad)  state.filters.squads = [filter.squad];
    if (filter.kam)    state.filters.kams = [filter.kam];
    state.filters.newNoAgreement = !!filter.newNoAgreement;
    state.focus = true;
    state.page = {};
    go('properties');   // the drilled-in list lives on Property Details
  };
}

/**
 * A clickable summary card. Normal click filters in place; Ctrl/Cmd-click opens
 * the filtered view in another tab of the same browser window.
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
  const a = el('a', {
    class: cls,
    href: detailHref(filter),
    target: DETAIL_TAB,
    title: 'Click to filter · Ctrl/Cmd-click to open in a new tab',
  }, body);
  a.addEventListener('click', cardClickHandler(filter));
  return a;
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
  'Founder/Partner Approved': 'sage',
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

  const card = el('a', {
    class: 'group-card',
    href: detailHref(filter),
    target: DETAIL_TAB,
    title: `Click to filter · Ctrl/Cmd-click for a new tab`,
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
  card.addEventListener('click', cardClickHandler(filter));
  return card;
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

  const head = ['Property', 'Squad', 'KAM', 'Agreement status', 'Ends', 'Link'];
  const body = slice.map((r) => el('tr', {}, [
    el('td', { class: 'freeze', 'data-label': 'Property' }, [
      r.__url
        ? el('a', { class: 'link-out', href: r.__url, target: '_blank', rel: 'noopener noreferrer' }, [r.__property, el('span', { class: 'ext', text: '↗' })])
        : r.__property,
      r.__code ? el('div', { class: 'row-sub', text: r.__code }) : null,
    ]),
    el('td', { 'data-label': 'Squad', style: 'text-align:left', text: r.__squad }),
    el('td', { 'data-label': 'KAM', style: 'text-align:left', text: r.__kam }),
    el('td', { 'data-label': 'Agreement status', style: 'text-align:left', class: 'status-cell' }, [
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

/* ---- business metrics (all derived from real columns only) --------------- */

const MS_DAY = 86400000;

function monthStart(d = new Date()) { return new Date(d.getFullYear(), d.getMonth(), 1); }

/**
 * Financial-year churn, mirroring the sheet formula exactly.
 *
 *   churn % = (properties whose Consol DelistPaused Date falls between Apr 1 of
 *             the financial year and the end of the selected month)
 *           / (properties whose Live Date is before Apr 1 AND whose Consol
 *             Delist date is on/after Apr 1 — the base at FY start)
 *
 * FY runs April–March: months Apr–Dec use the selected year, Jan–Mar use the
 * previous year. Squad filters when one squad is selected, else all squads.
 * Returns null when churn_ref isn't available so the caller can hide the card.
 */
function churnRateFY(squad) {
  const ref = state.churnRef || [];
  if (!ref.length) return null;

  // month/year from the period filter, else today
  const now = new Date();
  const monthNum = state.period.month ? Number(state.period.month) : (now.getMonth() + 1);
  const pickedYear = state.period.year ? Number(state.period.year) : now.getFullYear();

  // FY start: if selected month is Apr(4) or later, FY started this year, else last year
  const fyStartYear = monthNum >= 4 ? pickedYear : pickedYear - 1;
  const fyStart = new Date(fyStartYear, 3, 1);                 // Apr 1
  const monthEnd = new Date(pickedYear, monthNum, 0);          // last day of selected month

  const parse = (v) => {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const sameSquad = (r) => !squad || norm(r.squad) === norm(squad);

  let numerator = 0;
  let denominator = 0;

  for (const r of ref) {
    if (!sameSquad(r)) continue;

    const leave = parse(r.consol_delist_paused_date);   // column I
    const live = parse(r.live_date);                    // column D
    const consolDelist = parse(r.consol_delist);        // column J

    // numerator: churned within the FY window up to the selected month-end
    if (leave && leave >= fyStart && leave <= monthEnd) numerator += 1;

    // denominator: live before FY start AND still around on/after FY start
    if (live && live < fyStart && consolDelist && consolDelist >= fyStart) denominator += 1;
  }

  if (!denominator) return null;
  return numerator * 100 / denominator;
}

/**
 * The actual properties that churned this financial year (up to the selected
 * month) — the numerator rows behind churnRateFY. Joined with the main table by
 * Property ID so each shows a name and KAM, not just an ID.
 */
function churnedRowsFY(squad) {
  const ref = state.churnRef || [];
  if (!ref.length) return [];

  const now = new Date();
  const monthNum = state.period.month ? Number(state.period.month) : (now.getMonth() + 1);
  const pickedYear = state.period.year ? Number(state.period.year) : now.getFullYear();
  const fyStartYear = monthNum >= 4 ? pickedYear : pickedYear - 1;
  const fyStart = new Date(fyStartYear, 3, 1);
  const monthEnd = new Date(pickedYear, monthNum, 0);

  const parse = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; };
  const sameSquad = (r) => !squad || norm(r.squad) === norm(squad);

  // index main rows by Property ID for the join
  const byId = {};
  for (const r of state.rows) if (r.__code) byId[String(r.__code).trim()] = r;

  const out = [];
  for (const r of ref) {
    if (!sameSquad(r)) continue;
    const leave = parse(r.consol_delist_paused_date);
    if (!(leave && leave >= fyStart && leave <= monthEnd)) continue;
    const main = byId[String(r.prop_id).trim()];
    out.push({
      __code: r.prop_id,
      __property: main ? main.__property : `Property ${r.prop_id}`,
      __squad: r.squad || (main ? main.__squad : ''),
      __kam: main ? main.__kam : '—',
      __leaveDate: r.consol_delist_paused_date || '',
    });
  }
  // most recent churn first
  out.sort((a, b) => String(b.__leaveDate).localeCompare(String(a.__leaveDate)));
  return out;
}

/** Live agreements whose end date is within the next `days` days. */
function expiringWithin(rows, days) {
  const now = new Date();
  const limit = new Date(now.getTime() + days * MS_DAY);
  return rows.filter((r) => r.__live === true && r.__endDateObj && r.__endDateObj >= now && r.__endDateObj <= limit).length;
}

/** Properties that went live since the start of this calendar month. */
function newLiveThisMonth(rows) {
  const start = monthStart();
  return rows.filter((r) => r.__live === true && r.__liveDateObj && r.__liveDateObj >= start).length;
}

/** Live properties needing attention: not signed, expired, or already lapsed. */
function atRisk(rows) {
  const now = new Date();
  return rows.filter((r) => r.__live === true && (
    r.__status === 'Not Signed' ||
    r.__status === 'Expired' ||
    (r.__endDateObj && r.__endDateObj < now)
  )).length;
}

/** The row of quick-read insight cards shared across dashboard/squad/KAM. */
function insightCards(scopeRows, { live }) {
  const liveRows = scopeRows.filter((r) => r.__live === true);
  const grid = el('div', { class: 'stat-grid insight-grid' });

  grid.append(statCard({
    label: 'Expiring in 30 days', value: fmtInt(expiringWithin(scopeRows, 30)),
    sub: 'live agreements', accent: 'warn',
    filter: { status: 'To Expire', live: true },
  }));
  grid.append(statCard({
    label: 'New live this month', value: fmtInt(newLiveThisMonth(scopeRows)),
    sub: 'went live since ' + monthStart().toLocaleDateString([], { month: 'short', day: 'numeric' }),
    accent: 'sky',
  }));
  grid.append(statCard({
    label: 'At-risk properties', value: fmtInt(atRisk(scopeRows)),
    sub: 'not signed, expired or lapsed', accent: 'bad',
  }));
  grid.append(statCard({
    label: 'Valid agreements', value: fmtInt(liveRows.filter((r) => r.__status === 'Valid').length),
    sub: fmtPct(liveRows.length ? liveRows.filter((r) => r.__status === 'Valid').length * 100 / liveRows.length : null) + ' of live',
    accent: 'good', filter: { status: 'Valid', live: true },
  }));
  return grid;
}

/**
 * The prominent Live Properties + Churn pair shown at the top of the dashboard
 * and, when a squad or KAM is selected, on those pages too.
 */
function heroStats(scopeRows, { label } = {}) {
  const live = scopeRows.filter((r) => r.__live === true).length;
  const total = scopeRows.length;

  // Delisting rate = churned / (live + churned) * 100, computed from Supabase,
  // FY 2025-26, scoped to the selected squad/KAM. Single source of truth.
  const selectedSquad = state.filters.squads.length === 1 ? state.filters.squads[0] : null;
  const selectedKam = state.filters.kams.length === 1 ? state.filters.kams[0] : null;
  const dr = delistingRate(selectedSquad, selectedKam, null);

  let churn, churnSub, churnClickable;
  if (dr.rate !== null) {
    churn = dr.rate;
    const who = selectedKam ? selectedKam : selectedSquad ? selectedSquad : 'All India';
    churnSub = `${fmtInt(dr.churned)} ÷ (${fmtInt(dr.live)} + ${fmtInt(dr.churned)}) · ${who} · FY25-26`;
    churnClickable = true;
  } else {
    churn = null;
    churnSub = 'no churn data';
    churnClickable = false;
  }

  const churnInner = [
    el('div', { class: 's-label' }, ['Churn rate', churnClickable ? el('span', { class: 'ext', text: ' ↗' }) : null]),
    el('div', { class: 'hero-num', text: fmtPct(churn) }),
    el('div', { class: 's-sub', text: churnSub }),
  ];

  // clickable → opens the Churn view (now inside the Squad-wise tab)
  let churnCard;
  if (churnClickable) {
    churnCard = el('a', { class: 'hero-churn', href: '?view=churn-rate', target: DETAIL_TAB,
      title: 'Click to see how the churn rate is calculated' }, churnInner);
    churnCard.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      pushNav();
      go('churn-rate');
    });
  } else {
    churnCard = el('div', { class: 'hero-churn' }, churnInner);
  }

  return el('div', { class: 'hero-stats' }, [
    el('div', { class: 'hero-live' }, [
      el('div', { class: 's-label', text: label || 'Live properties' }),
      el('div', { class: 'hero-num', text: fmtInt(live) }),
      el('div', { class: 's-sub', text: `${fmtPct(total ? live * 100 / total : null)} of ${fmtInt(total)} in scope` }),
    ]),
    churnCard,
  ]);
}

/* ---- Dashboard: Style 3 — hero number, action cards, status, squads ------ */

/** The coloured "needs action today" row. All values from live data. */
function actionCards(scopeRows) {
  const live = scopeRows.filter((r) => r.__live === true);
  const now = new Date();

  const notSigned = live.filter((r) => r.__status === 'Not Signed').length;
  const expiring = expiringWithin(scopeRows, 30);
  const newNoAgreement = live.filter((r) => r.__newNoAgreement).length;
  const newLive = newLiveThisMonth(scopeRows);

  const card = (label, value, tone, filter) => {
    const body = [
      el('div', { class: 'act-label' }, [label, filter ? el('span', { class: 'ext', text: '↗' }) : null]),
      el('div', { class: 'act-num', text: fmtInt(value) }),
    ];
    if (!filter) return el('div', { class: `act-card tone-${tone}` }, body);
    const a = el('a', { class: `act-card tone-${tone}`, href: detailHref(filter), target: DETAIL_TAB,
      title: 'Click to filter · Ctrl/Cmd-click for a new tab' }, body);
    a.addEventListener('click', cardClickHandler(filter));
    return a;
  };

  return el('div', { class: 'action-grid' }, [
    card('Not signed', notSigned, 'danger', { status: 'Not Signed', live: true }),
    card('Expiring in 30 days', expiring, 'warning', { status: 'To Expire', live: true }),
    card('New — no agreement yet', newNoAgreement, 'sky', { newNoAgreement: true, live: true }),
    card('New live this month', newLive, 'success', null),
  ]);
}

function viewOverview(allRows) {
  const hasLiveCol = !!(state.cols.liveStatus || state.cols.liveDate || state.cols.delistDate);
  const live = hasLiveCol ? allRows.filter((r) => r.__live === true) : allRows;

  const frag = el('div', {}, [
    pageHead('Live properties', 'Everything at a glance. Tap any card to open the matching properties; Ctrl/Cmd-click opens a new tab.'),
  ]);

  // 1. hero band: the live number + churn
  frag.append(heroStats(allRows, { label: 'Live properties' }));

  // 2. needs action today
  frag.append(sectionHead('Needs action today', 'What requires attention right now'));
  frag.append(actionCards(allRows));

  // 3. agreement status (quieter reference cards, in the requested order)
  frag.append(sectionHead('Agreement status', `${fmtInt(live.length)} live properties`));
  frag.append(statusCards(live, { live: true }));

  return frag;
}

// Normalize a property id for joining across tables: strip whitespace, a
// trailing ".0" (numbers stored as floats), and lowercase. So "3257", "3257.0",
// " 3257 " all match.
function pidKey(v) {
  if (v === null || v === undefined) return '';
  let s = String(v).trim().replace(/\s+/g, '');
  s = s.replace(/\.0+$/, '');   // 3257.0 -> 3257
  return s.toLowerCase();
}

// Count of properties under Marriott (any value in marriott_cost) vs not,
// across ALL properties in the master (gcf_marginal). Optional squad/kam scope.
function marriottCounts(squad, kam) {
  let under = 0, notUnder = 0;
  for (const m of (state.gcfMarginal || [])) {
    if (squad && norm(m.squad) !== norm(squad)) continue;
    if (kam && norm(m.kam) !== norm(kam)) continue;
    const v = m.marriott_cost;
    const has = v != null && String(v).trim() !== '' && String(v).trim() !== '-';
    if (has) under += 1; else notUnder += 1;
  }
  return { under, notUnder };
}

// DCRW (Damage cover & Refund waiver) Yes/No count across all master properties,
// optional squad/kam scope.
function dcrwCounts(squad, kam) {
  let yes = 0, no = 0;
  for (const m of (state.gcfMarginal || [])) {
    if (squad && norm(m.squad) !== norm(squad)) continue;
    if (kam && norm(m.kam) !== norm(kam)) continue;
    const v = norm(m.dcrw);
    if (v === 'yes') yes += 1;
    else if (v === 'no') no += 1;
  }
  return { yes, no };
}

// ONE source of truth for "what squad/kam/status/search/month is active right
// now". Every list view uses this, so filters behave identically everywhere and
// a new view/card automatically respects them. Prefers the live top filter bar,
// falling back to any churn-drill scope.
function activeScope() {
  const cdf = state.cdFilters || {};
  return {
    squad: cdf.squad || (state.filters.squads.length === 1 ? state.filters.squads[0] : null) || state.caSquad || null,
    kam: cdf.kam || (state.filters.kams.length === 1 ? state.filters.kams[0] : null) || state.caKam || null,
    status: state.filters.statuses.length === 1 ? state.filters.statuses[0] : null,
    search: norm(state.search || ''),
    month: state.caMonth || null,
  };
}

/* ==== Churn Analysis module ============================================== */

// Financial year window for churn: 1 Apr 2025 → 31 Mar 2026.
const FY_START = new Date(2025, 3, 1);        // Apr 1, 2025
const FY_END   = new Date(2026, 2, 31, 23, 59, 59); // Mar 31, 2026

// Is a delist date inside FY 2025-26?
function inFY(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  return !Number.isNaN(d.getTime()) && d >= FY_START && d <= FY_END;
}

// Count of LIVE properties (Current Status = "Live") in the main table, scoped
// to an optional squad / KAM. This is the denominator's live component.
function liveCount(squad, kam) {
  let n = 0;
  for (const r of (state.rows || [])) {
    if (r.__live !== true) continue;
    if (squad && norm(r.__squad) !== norm(squad)) continue;
    if (kam && norm(r.__kam) !== norm(kam)) continue;
    n += 1;
  }
  return n;
}

// Count of FY-churned properties (Delisted, delist date in FY), scoped, deduped.
function churnedCountFY(squad, kam, month) {
  const seen = new Set();
  let n = 0;
  const monthNum = month ? MONTH_NAMES.findIndex((mn) => norm(mn) === norm(month)) + 1 : 0;
  for (const r of (state.churnAnalysis || [])) {
    if (norm(r.current_status) !== 'delisted') continue;
    if (squad && norm(r.squad) !== norm(squad)) continue;
    if (kam && norm(r.kam) !== norm(kam)) continue;
    if (!inFY(r.delist_date)) continue;
    if (monthNum) {
      const d = r.delist_date ? new Date(r.delist_date) : null;
      if (!(d && (d.getMonth() + 1) === monthNum)) continue;
    }
    const id = r.property_id != null ? String(r.property_id).trim() : '';
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    n += 1;
  }
  return n;
}

// Delisting rate = churned / (live + churned) * 100, all in the same scope.
// Returns { rate, churned, live } so the detail view can reconcile the number.
function delistingRate(squad, kam, month) {
  const churned = churnedCountFY(squad, kam, month);
  const live = liveCount(squad, kam);
  const denom = live + churned;
  return { rate: denom ? (churned * 100 / denom) : null, churned, live, denom };
}


// Read the pre-calculated churn rate (%) for a squad from the MIS squad table.
// Pass null/undefined for the overall "India" total.
function misChurnRate(squad) {
  const rows = state.misSquadChurn || [];
  if (!rows.length) return null;
  const target = squad ? norm(squad) : 'india';
  const row = rows.find((r) => norm(r.squad) === target);
  if (!row || row.churn_rate == null || row.churn_rate === '') return null;
  const n = pctToNumber(row.churn_rate);
  return n;
}

// The full MIS squad row (churned count, HO, SV, etc.) for a squad.
function misSquadRow(squad) {
  const rows = state.misSquadChurn || [];
  const target = squad ? norm(squad) : 'india';
  return rows.find((r) => norm(r.squad) === target) || null;
}

// Monthly churn rates for a squad, as [{month, rate}] in FY order (Apr→Mar).
const FY_MONTHS = ['april','may','june','july','august','september','october','november','december','january','february','march'];
function misMonthly(squad) {
  const rows = state.misMonthlyChurn || [];
  const target = squad ? norm(squad) : 'india';
  const row = rows.find((r) => norm(r.squad) === target);
  if (!row) return [];
  return FY_MONTHS
    .filter((m) => row[m] != null && String(row[m]).trim() !== '')
    .map((m) => ({ month: m.charAt(0).toUpperCase() + m.slice(1), rate: pctToNumber(row[m]) }));
}


const FNB_BUCKETS = ['0%', '1-10%', '11-20%', '21%+'];
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function pctToNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  let n = Number(String(v).trim().replace('%', ''));
  if (Number.isNaN(n)) return null;
  if (n > 0 && n < 1) n = n * 100;   // 0.03 -> 3
  return n;
}

function fnbBucket(v) {
  const n = pctToNumber(v);
  if (n === null) return null;
  if (n <= 0) return '0%';
  if (n <= 10) return '1-10%';
  if (n <= 20) return '11-20%';
  return '21%+';
}

function churnAnalysis(squad, kam, month) {
  const churn = state.churnAnalysis || [];
  const marginal = state.gcfMarginal || [];

  const gcfById = {};
  for (const m of marginal) if (m.property_id != null) gcfById[pidKey(m.property_id)] = m;

  const monthNum = month ? MONTH_NAMES.findIndex((mn) => norm(mn) === norm(month)) + 1 : 0;
  const isDelisted = (r) => norm(r.current_status) === 'delisted';
  const matchSquad = (r) => !squad || norm(r.squad) === norm(squad);
  const matchKam = (r) => !kam || norm(r.kam) === norm(kam);
  const matchMonth = (r) => {
    if (!monthNum) return true;
    const d = r.delist_date ? new Date(r.delist_date) : null;
    return d && !Number.isNaN(d.getTime()) && (d.getMonth() + 1) === monthNum;
  };

  const seen = new Set();
  const rows = [];
  for (const r of churn) {
    if (!isDelisted(r) || !matchSquad(r) || !matchKam(r) || !matchMonth(r)) continue;
    if (!inFY(r.delist_date)) continue;   // FY 2025-26 only
    const id = pidKey(r.property_id);
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    const g = id ? gcfById[id] : null;
    const rawBy = r.delist_initiated_by || '';
    const byNorm = norm(rawBy);
    const initiatedBy = byNorm === 'ho' ? 'Home Owner'
      : byNorm === 'sv' ? 'StayVista'
      : (rawBy || 'Unknown');
    rows.push({
      property_id: r.property_id,
      vista_name: r.vista_name || '',
      squad: r.squad || '',
      kam: r.kam || '—',
      initiatedBy,
      reason: r.reason_bucket || 'Unspecified',
      delistDate: r.delist_date || '',
      gcf: g ? g.gcf_current : null,
      fnbOwner: g ? g.fnb_owner : null,
      fnbVista: g ? g.fnb_vista : null,
      fnb: g ? g.fnb_owner : null,   // F&B bucket uses owner's food share
      gst: g ? g.gst : null,
      marriott: g ? g.marriott_cost : null,
      dcrw: g ? g.dcrw : null,
    });
  }

  const total = rows.length;
  const lowGcf = rows.filter((r) => { const n = pctToNumber(r.gcf); return n !== null && n < 5; }).length;

  const byBucket = (list, keyFn) => {
    const m = {};
    for (const r of list) { const k = keyFn(r) || 'Unknown'; m[k] = (m[k] || 0) + 1; }
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  };

  const fnbCounts = Object.fromEntries(FNB_BUCKETS.map((b) => [b, 0]));
  for (const r of rows) { const b = fnbBucket(r.fnb); if (b) fnbCounts[b] += 1; }

  return { rows, total, lowGcf,
    initiatedBy: byBucket(rows, (r) => r.initiatedBy),
    reasons: byBucket(rows, (r) => r.reason),
    fnbCounts };
}

function churnSquads() {
  const m = {};
  for (const r of (state.churnAnalysis || [])) {
    if (norm(r.current_status) !== 'delisted') continue;
    const s = r.squad || '—';
    (m[s] = m[s] || new Set());
    if (r.property_id != null) m[s].add(String(r.property_id).trim());
  }
  return Object.entries(m).map(([name, set]) => ({ name, count: set.size })).sort((a, b) => b.count - a.count);
}

function churnKams(squad) {
  const m = {};
  for (const r of (state.churnAnalysis || [])) {
    if (norm(r.current_status) !== 'delisted') continue;
    if (squad && norm(r.squad) !== norm(squad)) continue;
    const k = r.kam || '—';
    (m[k] = m[k] || new Set());
    if (r.property_id != null) m[k].add(String(r.property_id).trim());
  }
  return Object.entries(m).map(([name, set]) => ({ name, count: set.size })).sort((a, b) => b.count - a.count);
}

/* ---- Churned properties (drill-in from the churn card) ------------------- */

function viewChurned() {
  const selectedSquad = state.filters.squads.length === 1 ? state.filters.squads[0] : null;
  const churned = churnedRowsFY(selectedSquad);

  const now = new Date();
  const monthNum = state.period.month ? Number(state.period.month) : (now.getMonth() + 1);
  const pickedYear = state.period.year ? Number(state.period.year) : now.getFullYear();
  const monthName = ['January','February','March','April','May','June','July','August','September','October','November','December'][monthNum - 1];
  const scope = selectedSquad ? selectedSquad : 'all squads';

  const frag = el('div', {}, []);

  // back button to return to the dashboard
  const back = el('button', { type: 'button', class: 'back-btn' }, [el('span', { class: 'back-arrow', text: '‹' }), 'Go back']);
  back.addEventListener('click', () => go('overview'));
  frag.append(back);

  frag.append(pageHead('Churned properties',
    `Properties that churned this financial year up to ${monthName} ${pickedYear} · ${scope}.`));

  if (!churned.length) {
    frag.append(el('div', { class: 'state' }, [
      el('h3', { text: 'No churned properties in this period' }),
      el('p', { text: 'Nothing matched the selected month, year and squad.' }),
    ]));
    return frag;
  }

  frag.append(el('div', { class: 'panel' }, [
    el('div', { class: 'panel-head' }, [
      el('h3', { text: `${fmtInt(churned.length)} churned` }),
      el('span', { class: 'hint right', text: `FYTD · ${scope}` }),
    ]),
    el('div', { class: 'panel-body', style: 'padding:0' }, [
      (() => {
        const table = el('table', { class: 'grid' });
        table.append(el('thead', {}, [el('tr', {}, [
          el('th', { style: 'text-align:left', text: 'Property' }),
          el('th', { style: 'text-align:left', text: 'Squad' }),
          el('th', { style: 'text-align:left', text: 'KAM' }),
          el('th', { style: 'text-align:left', text: 'Churn date' }),
        ])]));
        const tbody = el('tbody', {});
        for (const r of churned) {
          tbody.append(el('tr', {}, [
            el('td', { style: 'text-align:left' }, [
              el('div', { text: r.__property }),
              r.__code ? el('div', { class: 'row-sub', text: String(r.__code) }) : null,
            ]),
            el('td', { style: 'text-align:left', text: r.__squad || '—' }),
            el('td', { style: 'text-align:left', text: r.__kam || '—' }),
            el('td', { style: 'text-align:left', text: r.__leaveDate ? String(r.__leaveDate).slice(0, 10) : '—' }),
          ]));
        }
        table.append(tbody);
        return table;
      })(),
    ]),
  ]));

  return frag;
}

/* ---- Churn Analysis: Squad -> KAM drill-down ---------------------------- */

function churnMetricCard(label, value, tone) {
  return el('div', { class: `stat ${tone ? 'tone-' + tone : ''}` }, [
    el('div', { class: 's-label', text: label }),
    el('div', { class: 's-value', text: fmtInt(value) }),
  ]);
}

function viewChurnRate() {
  const squad = state.filters.squads.length === 1 ? state.filters.squads[0] : null;
  const kam = state.filters.kams.length === 1 ? state.filters.kams[0] : null;
  const month = state.caMonth || null;
  const scope = kam ? `${kam} · ${squad || ''}` : squad ? squad : 'All India';

  const frag = el('div', {}, []);
  const back = el('button', { type: 'button', class: 'back-btn' }, [el('span', { class: 'back-arrow', text: '‹' }), 'Go back to previous page']);
  back.addEventListener('click', () => goBackHistory('overview'));
  frag.append(back);

  const dr = delistingRate(squad, kam, month);
  frag.append(pageHead('Churn rate', `How the rate is calculated · ${scope} · FY 2025-26${month ? ' · ' + month : ''}`));

  // the reconciliation (Denominator card removed — it was just live+churned)
  frag.append(sectionHead('The calculation', 'Churn rate = churned ÷ (live + churned) × 100'));

  // Live card → opens the live property list for this scope
  const liveCard = el('a', { class: 'stat stat-link', href: '#', title: 'Click to see the live properties' }, [
    el('div', { class: 's-label' }, ['Live properties', el('span', { class: 'ext', text: ' ↗' })]),
    el('div', { class: 's-value', text: fmtInt(dr.live) }),
  ]);
  liveCard.addEventListener('click', (e) => {
    e.preventDefault();
    state.returnTo = { view: state.view, filters: JSON.parse(JSON.stringify(state.filters)), search: state.search };
    if (squad) state.filters.squads = [squad];
    if (kam) state.filters.kams = [kam];
    state.filters.statuses = [];
    state.focus = true; state.page = {};
    pushNav();
    go('properties');
  });

  // Churned card → opens the churned list for this scope
  const churnedCard = el('a', { class: 'stat stat-link', href: '#', title: 'Click to see the churned properties' }, [
    el('div', { class: 's-label' }, ['Churned (FY25-26)', el('span', { class: 'ext', text: ' ↗' })]),
    el('div', { class: 's-value', text: fmtInt(dr.churned) }),
  ]);
  churnedCard.addEventListener('click', (e) => {
    e.preventDefault();
    state.caSquad = squad || null; state.caKam = kam || null;
    state.cd = {}; state.cdFilters = {}; state.cdPage = 1;
    pushNav();
    go('churn-detail');
  });

  frag.append(el('div', { class: 'stat-grid' }, [
    liveCard,
    churnedCard,
    el('div', { class: 'stat tone-danger' }, [el('div', { class: 's-label', text: 'Churn rate' }), el('div', { class: 's-value', text: dr.rate !== null ? fmtPct(dr.rate) : '—' })]),
  ]));

  // squad breakdown (only at all-India level) — each row clickable
  if (!squad && !kam) {
    const squads = [...new Set((state.churnAnalysis || []).map((r) => r.squad).filter(Boolean))].sort();
    frag.append(sectionHead('By squad', 'Churn rate per squad · FY25-26 · click a row for that squad\'s churned properties'));
    const table = el('table', { class: 'grid' });
    table.append(el('thead', {}, [el('tr', {}, ['Squad', 'Live', 'Churned', 'Churn rate'].map((h) => el('th', { style: 'text-align:left', text: h })))]));
    const tb = el('tbody', {});
    for (const s of squads) {
      const d = delistingRate(s, null, month);
      const tr = el('tr', { class: 'row-click', title: `Click for ${s}'s churned properties` }, [
        el('td', { style: 'text-align:left', text: s }),
        el('td', { style: 'text-align:left', text: fmtInt(d.live) }),
        el('td', { style: 'text-align:left', text: fmtInt(d.churned) }),
        el('td', { style: 'text-align:left' }, [
          el('span', { class: d.rate !== null && d.rate > 1 ? 'flag-dot' : '', text: d.rate !== null ? fmtPct(d.rate) : '—' }),
        ]),
      ]);
      tr.addEventListener('click', () => {
        state.caSquad = s; state.caKam = null;
        state.cd = {}; state.cdFilters = {}; state.cdPage = 1;
        pushNav();
        go('churn-detail');
      });
      tb.append(tr);
    }
    table.append(tb);
    frag.append(el('div', { class: 'panel' }, [el('div', { class: 'table-wrap' }, [table])]));
  }

  // the churned property list behind the number
  frag.append(sectionHead('Churned properties', `${fmtInt(dr.churned)} in this scope`));
  frag.append(churnPropertyTable(churnAnalysis(squad, kam, month).rows));

  return frag;
}

function viewChurnDetail() {
  // ONE shared scope helper — same filters everywhere.
  const sc = activeScope();
  const squad = sc.squad, kam = sc.kam, topSearch = sc.search;
  const cd = state.cd || {};

  const frag = el('div', {}, []);

  // back button → return to where we came from (squad or kam tab)
  const back = el('button', { type: 'button', class: 'back-btn' }, [el('span', { class: 'back-arrow', text: '‹' }), 'Go back to previous page']);
  back.addEventListener('click', () => goBackHistory('squad'));
  frag.append(back);

  // build the churned rows, then apply the card's filter + any user filters
  let rows = churnAnalysis(squad, kam, sc.month).rows;
  // live top filter bar: free-text search also narrows the list
  if (topSearch) rows = rows.filter((r) => norm(`${r.property_id} ${r.vista_name} ${r.squad} ${r.kam}`).includes(topSearch));
  const f = state.cdFilters || {};

  // The card filter applies UNLESS the user picked a value for the same field in
  // the dropdowns (the dropdown then takes over — they never stack/conflict).
  if (cd.gcfLow && !f.gcfRange) rows = rows.filter((r) => { const n = pctToNumber(r.gcf); return n !== null && n < 5; });
  if (cd.initiatedBy && !f.initiatedBy) rows = rows.filter((r) => norm(r.initiatedBy).includes(norm(cd.initiatedBy)));
  if (cd.fnb && !f.fnb) rows = rows.filter((r) => fnbBucket(r.fnb) === cd.fnb);
  if (cd.reason && !f.reason) rows = rows.filter((r) => norm(r.reason) === norm(cd.reason));

  // user dropdown filters
  if (f.squad) rows = rows.filter((r) => norm(r.squad) === norm(f.squad));
  if (f.kam) rows = rows.filter((r) => norm(r.kam) === norm(f.kam));
  if (f.fnb) rows = rows.filter((r) => fnbBucket(r.fnb) === f.fnb);
  if (f.reason) rows = rows.filter((r) => norm(r.reason) === norm(f.reason));
  if (f.initiatedBy) rows = rows.filter((r) => norm(r.initiatedBy).includes(norm(f.initiatedBy)));
  if (f.gcfRange) {
    rows = rows.filter((r) => {
      const n = pctToNumber(r.gcf); if (n === null) return false;
      if (f.gcfRange === '<5%') return n < 5;
      if (f.gcfRange === '5-10%') return n >= 5 && n <= 10;
      if (f.gcfRange === '>10%') return n > 10;
      return true;
    });
  }

  // title describing the active card filter
  const bits = [];
  if (cd.gcfLow) bits.push('GCF below 5%');
  if (cd.initiatedBy) bits.push(`initiated by ${cd.initiatedBy}`);
  if (cd.fnb) bits.push(`F&B ${cd.fnb}`);
  if (cd.reason) bits.push(cd.reason);
  const scope = kam ? `${kam} · ${squad}` : squad ? squad : 'all squads';
  frag.append(pageHead('Churned properties', `${scope}${bits.length ? ' · ' + bits.join(' · ') : ''}`));

  frag.append(sectionHead('Results', `${fmtInt(rows.length)} properties`));
  frag.append(churnPropertyTable(rows));

  return frag;
}

/** Filter controls for the churn-detail list. Simple dropdowns. */
function churnFilterBar(allRows) {
  const f = state.cdFilters || {};
  const uniq = (key) => [...new Set(allRows.map((r) => r[key]).filter(Boolean))].sort();
  const bar = el('div', { class: 'filter-bar' });

  const addSelect = (label, key, options) => {
    const sel = el('select', { class: 'flt' });
    sel.append(el('option', { value: '', text: label }));
    for (const o of options) {
      const opt = el('option', { value: o, text: o });
      if (f[key] === o) opt.selected = true;
      sel.append(opt);
    }
    sel.addEventListener('change', () => {
      state.cdFilters = { ...(state.cdFilters || {}), [key]: sel.value || null };
      state.cdPage = 1;
      render();
    });
    bar.append(sel);
  };

  addSelect('All squads', 'squad', uniq('squad'));
  addSelect('All KAMs', 'kam', uniq('kam'));
  addSelect('All F&B bands', 'fnb', FNB_BUCKETS);
  addSelect('All reasons', 'reason', uniq('reason'));
  addSelect('All initiated-by', 'initiatedBy', uniq('initiatedBy'));
  addSelect('All GCF ranges', 'gcfRange', ['<5%', '5-10%', '>10%']);

  if (state.cdFilters && Object.values(state.cdFilters).some(Boolean)) {
    const clear = el('button', { type: 'button', class: 'reset-btn', text: 'Clear filters' });
    clear.addEventListener('click', () => { state.cdFilters = {}; state.cdPage = 1; render(); });
    bar.append(clear);
  }
  return bar;
}

function churnPropertyTable(rows) {
  if (!rows.length) return el('div', { class: 'state' }, [el('p', { text: 'No churned properties in this scope.' })]);

  const { wrap: pagerEl, page } = pager(rows.length);
  const pageRows = rows.slice((page - 1) * PAGE_ROWS, page * PAGE_ROWS);

  const head = ['Property ID', 'Name', 'KAM', 'Squad', 'GCF', 'F&B Owner', 'F&B Vista', 'GST', 'Initiated by', 'Reason', 'Delist date'];
  const table = el('table', { class: 'grid' });
  table.append(el('thead', {}, [el('tr', {}, head.map((h, i) =>
    el('th', { class: i === 0 ? 'freeze' : '', style: 'text-align:left', text: h })))]));
  const tbody = el('tbody', {});
  for (const r of pageRows) {
    // show a share/tax value as a percentage: 0.03 -> "3%", "0.15" -> "15%",
    // "18%" stays "18%", blank -> "—".
    const showPct = (v) => {
      if (v == null || String(v).trim() === '' || String(v).trim() === '-') return '—';
      const s = String(v).trim();
      if (s.includes('%')) return s;                 // already a percent
      let n = Number(s);
      if (Number.isNaN(n)) return s;                 // non-numeric, show as-is
      if (n > 0 && n <= 1) n = n * 100;              // 0.03 -> 3 (decimals)
      // trim trailing zeros: 3.0 -> 3, 12.50 -> 12.5
      return `${Math.round(n * 100) / 100}%`;
    };
    const show = (v) => (v != null && v !== '' ? String(v) : '—');
    tbody.append(el('tr', {}, [
      el('td', { class: 'freeze', style: 'text-align:left', text: r.property_id != null ? String(r.property_id) : '—' }),
      el('td', { style: 'text-align:left', text: r.vista_name || '—' }),
      el('td', { style: 'text-align:left', text: r.kam || '—' }),
      el('td', { style: 'text-align:left', text: r.squad || '—' }),
      el('td', { style: 'text-align:left', text: showPct(r.gcf) }),
      el('td', { style: 'text-align:left', text: showPct(r.fnbOwner) }),
      el('td', { style: 'text-align:left', text: showPct(r.fnbVista) }),
      el('td', { style: 'text-align:left', text: showPct(r.gst) }),
      el('td', { style: 'text-align:left', text: r.initiatedBy || '—' }),
      el('td', { style: 'text-align:left', text: r.reason || '—' }),
      el('td', { style: 'text-align:left', text: r.delistDate ? String(r.delistDate).slice(0, 10) : '—' }),
    ]));
  }
  table.append(tbody);

  return el('div', { class: 'panel' }, [
    el('div', { class: 'table-wrap' }, [el('div', { class: 'churn-table-scroll' }, [table])]),
    pagerEl,
  ]);
}

/* ---- Squad-wise / KAM-wise: cards on top, property list below ------------ */

function viewGroup(rows, field, dimension, title, desc) {
  // Squad/KAM summaries are LIVE properties only (for the agreement section).
  const live = rows.filter((r) => r.__live === true);
  const groups = groupBy(live, field);

  const selected = dimension === 'squad' ? state.filters.squads : state.filters.kams;
  const focused = selected.length === 1 ? selected[0] : null;

  const frag = el('div', {}, [pageHead(title, desc)]);

  // ---- SECTION 1: Agreement status (live properties) ----
  frag.append(
    sectionHead('Agreement status', `${fmtInt(live.length)} live properties`),
    statusCards(live, { live: true }),
  );

  // ---- SECTION 2: Churn (delisted properties, from MIS + churn_analysis) ----
  frag.append(churnSection(dimension, focused));

  // ---- SECTION 3: the drill cards (squads or KAMs) ----
  frag.append(
    sectionHead(dimension === 'squad' ? 'Squads' : 'KAMs', `${fmtInt(groups.length)} in scope · tap a card to open its properties`),
    el('div', { class: 'group-grid' }, groups.map((e) => groupCard(e, dimension))),
  );

  // The live property table appears once a specific squad/KAM is selected.
  if (focused) {
    frag.append(propertyList(live, { title: `${focused} · properties` }));
  }
  return frag;
}

/**
 * The Churn section shown inside the Squad-wise / KAM-wise tabs.
 * Uses the MIS pre-calculated churn rate + churn_analysis breakdowns, scoped to
 * the selected squad/KAM. Every metric card is clickable → opens the matching
 * churned-property list (new tab in the same browser, with a back button).
 */
function churnSection(dimension, focused) {
  const squad = dimension === 'squad' ? focused : (state.filters.squads.length === 1 ? state.filters.squads[0] : null);
  const kam = dimension === 'kam' ? focused : null;
  const month = state.caMonth || null;

  const wrap = el('div', {});
  const scope = kam ? kam : squad ? squad : 'all India';

  // Delisting rate, computed = churned / (live + churned) * 100, same scope,
  // FY 2025-26. When a month is picked, churned is that month's FY churn.
  const dr = delistingRate(squad, kam, month);
  const rate = dr.rate;

  // month banner + clear
  if (month) {
    const banner = el('div', { class: 'month-banner' }, [
      el('span', { text: `Showing: ${month} only` }),
    ]);
    const clear = el('button', { type: 'button', class: 'reset-btn', text: 'Clear month' });
    clear.addEventListener('click', () => { state.caMonth = null; render(); });
    banner.append(clear);
    wrap.append(banner);
  }

  // all metric computations respect the selected month
  const m2 = churnAnalysis(squad, kam, month);

  // headline churn rate, flagged red if > 1%
  const flagged = rate !== null && rate > 1;
  const rateSub = rate !== null
    ? `${fmtInt(dr.churned)} ÷ (${fmtInt(dr.live)} live + ${fmtInt(dr.churned)}) · FY25-26${month ? ' · ' + month : ''}`
    : 'no data';
  const rateCard = el('div', { class: `stat ${flagged ? 'tone-danger' : ''}` }, [
    el('div', { class: 's-label' }, ['Churn rate', flagged ? el('span', { class: 'flag-dot', title: 'Above 1%', text: ' ●' }) : null]),
    el('div', { class: 's-value', text: rate !== null ? fmtPct(rate) : '—' }),
    el('div', { class: 's-sub', text: rateSub }),
  ]);

  const misRow = misSquadRow(squad);
  // Counts come from the ACTUAL churn rows (m2) so every card matches the list
  // that opens when you click it. (The churn RATE above still comes from MIS,
  // since that's a trusted percentage, not a row count.)
  const churnedCount = m2.total;

  wrap.append(sectionHead('Churn', `Delisted properties · ${scope}${month ? ' · ' + month : ''}`));
  wrap.append(el('div', { class: 'stat-grid' }, [
    rateCard,
    clickableChurnCard('Total churned', churnedCount, {}, squad, kam),
    clickableChurnCard('GCF below 5%', m2.lowGcf, { gcfLow: true }, squad, kam),
  ]));

  // Initiated by — always counted from the actual rows, so the card number
  // equals the number of rows you see when you click it.
  const findBy = (k) => (m2.initiatedBy.find(([label]) => norm(label).includes(k)) || [null, 0])[1];
  const ho = findBy('home');
  const sv = findBy('stay');
  wrap.append(sectionHead('Churn initiated by', 'Home Owner vs StayVista'));
  wrap.append(el('div', { class: 'stat-grid' }, [
    clickableChurnCard('Home Owner', ho || 0, { initiatedBy: 'Home Owner' }, squad, kam),
    clickableChurnCard('StayVista', sv || 0, { initiatedBy: 'StayVista' }, squad, kam),
  ]));

  // F&B ranges — clickable
  wrap.append(sectionHead('F&B share ranges', 'Owner F&B share of churned properties'));
  wrap.append(el('div', { class: 'stat-grid' },
    FNB_BUCKETS.map((b) => clickableChurnCard(b, m2.fnbCounts[b], { fnb: b }, squad, kam))));

  // Under Marriott vs not (across ALL properties in the master, this scope)
  const mc = marriottCounts(squad, kam);
  wrap.append(sectionHead('Marriott', 'Properties under Marriott vs not · all properties'));
  wrap.append(el('div', { class: 'stat-grid' }, [
    masterListCard('Under Marriott', mc.under, { marriott: 'yes' }, squad, kam),
    masterListCard('Not under Marriott', mc.notUnder, { marriott: 'no' }, squad, kam),
  ]));

  // DCRW — Damage cover & Refund waiver, Yes/No count across all properties
  const dc = dcrwCounts(squad, kam);
  wrap.append(sectionHead('DCRW', 'Damage cover & Refund waiver · charged per booking · all properties'));
  wrap.append(el('div', { class: 'stat-grid' }, [
    masterListCard('DCRW — Yes', dc.yes, { dcrw: 'yes' }, squad, kam),
    masterListCard('DCRW — No', dc.no, { dcrw: 'no' }, squad, kam),
  ]));

  // Monthly churn rate (from MIS Table 3) — flag months > 1%, click to filter by month
  const monthly = misMonthly(squad);
  if (monthly.length) {
    wrap.append(sectionHead('Monthly churn rate', `FY Apr–Mar · ${scope} · red = above 1% · click a month to filter`));
    wrap.append(el('div', { class: 'stat-grid' },
      monthly.map((mm) => {
        const selected = norm(state.caMonth || '') === norm(mm.month);
        const card = el('a', { class: `stat stat-link ${mm.rate > 1 ? 'tone-danger' : ''} ${selected ? 'month-active' : ''}`, href: '#',
          title: 'Click to filter this section to ' + mm.month }, [
          el('div', { class: 's-label', text: mm.month }),
          el('div', { class: 's-value', text: fmtPct(mm.rate) }),
        ]);
        card.addEventListener('click', (e) => {
          e.preventDefault();
          state.caMonth = selected ? null : mm.month;   // toggle on/off
          render();
        });
        return card;
      })));
  }

  return wrap;
}

/** A churn metric card that opens the filtered churned-property list on click. */
// A card that opens a filtered list of MASTER properties (from gcf_marginal),
// e.g. under Marriott / DCRW Yes. These cover all properties, not just churned.
function masterListCard(label, value, filter, squad, kam) {
  const card = el('a', { class: 'stat stat-link', href: '#',
    title: 'Click to see these properties · 25 per page' }, [
    el('div', { class: 's-label' }, [label, el('span', { class: 'ext', text: ' ↗' })]),
    el('div', { class: 's-value', text: fmtInt(value) }),
  ]);
  card.addEventListener('click', (e) => {
    e.preventDefault();
    state.mlFilter = { ...filter, squad: squad || null, kam: kam || null, label };
    state.mlPage = 1;
    pushNav();
    go('master-list');
  });
  return card;
}

function viewMasterList() {
  const f = state.mlFilter || {};
  const frag = el('div', {}, []);
  const back = el('button', { type: 'button', class: 'back-btn' }, [el('span', { class: 'back-arrow', text: '‹' }), 'Go back to previous page']);
  back.addEventListener('click', () => goBackHistory('overview'));
  frag.append(back);

  // Scope comes from the shared activeScope helper — same filters everywhere.
  const sc = activeScope();
  const squad = sc.squad, kam = sc.kam, search = sc.search;

  let rows = (state.gcfMarginal || []).slice();
  if (squad) rows = rows.filter((r) => norm(r.squad) === norm(squad));
  if (kam) rows = rows.filter((r) => norm(r.kam) === norm(kam));
  // the card that opened this view (marriott / dcrw)
  if (f.marriott === 'yes') rows = rows.filter((r) => { const v = r.marriott_cost; return v != null && String(v).trim() !== '' && String(v).trim() !== '-'; });
  if (f.marriott === 'no') rows = rows.filter((r) => { const v = r.marriott_cost; return !(v != null && String(v).trim() !== '' && String(v).trim() !== '-'); });
  if (f.dcrw === 'yes') rows = rows.filter((r) => norm(r.dcrw) === 'yes');
  if (f.dcrw === 'no') rows = rows.filter((r) => norm(r.dcrw) === 'no');
  // free-text search on id / squad / kam
  if (search) rows = rows.filter((r) => norm(`${r.property_id} ${r.squad} ${r.kam}`).includes(search));

  const scope = kam ? `${kam} · ${squad || ''}` : squad ? squad : 'all properties';
  frag.append(pageHead(f.label || 'Properties', `${scope}`));
  frag.append(sectionHead('Results', `${fmtInt(rows.length)} properties`));

  if (!rows.length) {
    frag.append(el('div', { class: 'state' }, [el('p', { text: 'No properties in this scope.' })]));
    return frag;
  }

  // numbered pager (same style as the property list)
  const { wrap: pagerEl, page } = pager(rows.length);
  const pageRows = rows.slice((page - 1) * PAGE_ROWS, page * PAGE_ROWS);

  const showPct = (v) => {
    if (v == null || String(v).trim() === '' || String(v).trim() === '-') return '—';
    const s = String(v).trim();
    if (s.includes('%')) return s;
    let n = Number(s); if (Number.isNaN(n)) return s;
    if (n > 0 && n <= 1) n = n * 100;
    return `${Math.round(n * 100) / 100}%`;
  };

  const table = el('table', { class: 'grid' });
  const head = ['Property ID', 'Squad', 'KAM', 'GCF', 'F&B Owner', 'F&B Vista', 'GST', 'Marriott', 'DCRW'];
  table.append(el('thead', {}, [el('tr', {}, head.map((h, i) => el('th', { class: i === 0 ? 'freeze' : '', style: 'text-align:left', text: h })))]));
  const tb = el('tbody', {});
  for (const r of pageRows) {
    tb.append(el('tr', {}, [
      el('td', { class: 'freeze', style: 'text-align:left', text: r.property_id != null ? String(r.property_id) : '—' }),
      el('td', { style: 'text-align:left', text: r.squad || '—' }),
      el('td', { style: 'text-align:left', text: r.kam || '—' }),
      el('td', { style: 'text-align:left', text: showPct(r.gcf_current) }),
      el('td', { style: 'text-align:left', text: showPct(r.fnb_owner) }),
      el('td', { style: 'text-align:left', text: showPct(r.fnb_vista) }),
      el('td', { style: 'text-align:left', text: showPct(r.gst) }),
      el('td', { style: 'text-align:left', text: (r.marriott_cost != null && String(r.marriott_cost).trim() !== '' && String(r.marriott_cost).trim() !== '-') ? String(r.marriott_cost) : '—' }),
      el('td', { style: 'text-align:left', text: r.dcrw || '—' }),
    ]));
  }
  table.append(tb);

  frag.append(el('div', { class: 'panel' }, [
    el('div', { class: 'table-wrap' }, [el('div', { class: 'churn-table-scroll' }, [table])]),
    pagerEl,
  ]));
  return frag;
}

function clickableChurnCard(label, value, filter, squad, kam) {
  const p = new URLSearchParams();
  p.set('view', 'churn-detail');
  if (squad) p.set('casquad', squad);
  if (kam) p.set('cakam', kam);
  if (filter.gcfLow) p.set('cgcf', '1');
  if (filter.initiatedBy) p.set('cby', filter.initiatedBy);
  if (filter.fnb) p.set('cfnb', filter.fnb);
  if (filter.reason) p.set('creason', filter.reason);
  const href = '?' + p.toString();

  const card = el('a', { class: 'stat stat-link', href, target: DETAIL_TAB,
    title: 'Click to see these properties · Ctrl/Cmd-click for a new tab' }, [
    el('div', { class: 's-label' }, [label, el('span', { class: 'ext', text: ' ↗' })]),
    el('div', { class: 's-value', text: fmtInt(value) }),
  ]);
  card.addEventListener('click', (e) => {
    if (e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    state.caSquad = squad || null;
    state.caKam = kam || null;
    state.cd = { gcfLow: !!filter.gcfLow, initiatedBy: filter.initiatedBy || null, fnb: filter.fnb || null, reason: filter.reason || null };
    state.cdFilters = {};   // clear any leftover dropdown filters from a previous card
    state.cdPage = 1;
    pushNav();
    go('churn-detail');
  });
  return card;
}


/* ---- Property Details: the filtered row-level list ---------------------- */

function viewProperties(rows) {
  // A drilled-in view (from a card click) or a single-status filter should show
  // just the list — the summary cards would be all-zero-but-one, so drop them.
  const singleStatus = state.filters.statuses.length === 1 ? state.filters.statuses[0] : null;
  const drilled = state.focus || !!singleStatus || state.filters.newNoAgreement;

  const heading = state.filters.newNoAgreement ? 'New properties — no agreement yet'
    : singleStatus ? `${singleStatus} properties`
    : state.filters.squads.length === 1 ? `${state.filters.squads[0]} properties`
    : state.filters.kams.length === 1 ? `${state.filters.kams[0]} properties`
    : 'Property details';

  const frag = el('div', {}, [
    pageHead(
      heading,
      drilled
        ? 'Filtered view. Use Back to return, or clear the filters to see the full summary.'
        : 'Every row behind the summaries. Links open in a new tab.'
    ),
  ]);

  const oneSquad = state.filters.squads.length === 1 ? state.filters.squads[0] : null;
  const oneKam = state.filters.kams.length === 1 ? state.filters.kams[0] : null;

  // Agreement cards: show on the full summary AND when drilled into a single
  // squad/KAM (they update to that scope). Only hide for a pure status drill.
  if (!drilled || oneSquad || oneKam) {
    frag.append(
      sectionHead('Agreement status', `${fmtInt(rows.filter((r) => r.__live === true).length)} live properties in scope`),
      statusCards(rows.filter((r) => r.__live === true), { live: true }),
    );
  }

  // When the drill-in is for a single squad or KAM, show the churn cards here
  // too (so the filtered view has the same churn metrics as the Squad/KAM tab).
  if (!singleStatus && !state.filters.newNoAgreement && (oneSquad || oneKam)) {
    frag.append(churnSection(oneKam ? 'kam' : 'squad', oneKam || oneSquad));
  }

  frag.append(propertyList(rows, { title: drilled ? heading : 'All properties' }));
  return frag;
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

    const det = d.statusDetection || [];
    if (det.length) {
      frag.append(el('div', { class: 'panel' }, [
        el('div', { class: 'panel-head' }, [
          el('h3', { text: 'How the status columns were told apart' }),
          el('span', { class: 'hint right', text: 'Decided by the values, not the column name' }),
        ]),
        el('div', { class: 'table-wrap stacked-wrap' }, [
          el('table', { class: 'grid stacked' }, [
            el('thead', {}, [el('tr', {}, ['Column', 'Filled', 'Recognised', 'Pre-signature', 'Expiry', 'Valid', 'Used as'].map((h, i) =>
              el('th', { scope: 'col', class: i === 0 ? 'freeze' : '', style: i < 1 ? 'text-align:left' : '', text: h })))]),
            el('tbody', {}, det.map((c) => el('tr', {}, [
              el('td', { class: 'freeze', 'data-label': 'Column', style: 'text-align:left', text: c.key }),
              el('td', { 'data-label': 'Filled', text: fmtInt(c.filled) }),
              el('td', { 'data-label': 'Recognised', text: fmtInt(c.mapped) }),
              el('td', { 'data-label': 'Pre-signature', text: fmtInt(c.pre) }),
              el('td', { 'data-label': 'Expiry', text: fmtInt(c.post) }),
              el('td', { 'data-label': 'Valid', text: fmtInt(c.valid) }),
              el('td', { 'data-label': 'Used as', style: 'text-align:left' }, [
                c.key === state.cols.signing ? statusPill('Not Signed') : null,
                c.key === state.cols.lifecycle ? statusPill('Valid') : null,
                (c.key !== state.cols.signing && c.key !== state.cols.lifecycle)
                  ? el('span', { class: 'zero', text: 'not used' }) : null,
              ]),
            ]))),
          ]),
        ]),
      ]));
    }

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
    overview: rows.filter((r) => r.__live === true).length,
    squad: new Set(rows.map((r) => r.__squad)).size,
    kam: new Set(rows.map((r) => r.__kam)).size,
    properties: rows.length,
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

// Churn pages get their OWN top filter bar (no agreement Status/Search that
// don't apply to churned data). Same visual style as the agreement bar.
// Filters: Months, Years, Squad, KAM, F&B, Reason, Initiated-by, GCF, Search.
const CHURN_VIEWS_WITH_BAR = ['churned', 'churn-detail', 'churn-rate', 'master-list'];

function renderChurnTopBar() {
  const bar = $('#filter-bar');
  if (!bar) return;
  bar.replaceChildren();
  const row = el('div', { class: 'filter-row' });

  // universe of churn rows to populate dropdown options
  const all = (state.churnAnalysis || []).map((r) => ({
    squad: r.squad, kam: r.kam,
    reason: r.reason_bucket || 'Unspecified',
    initiatedBy: norm(r.delist_initiated_by) === 'ho' ? 'Home Owner' : norm(r.delist_initiated_by) === 'sv' ? 'StayVista' : (r.delist_initiated_by || 'Unknown'),
  }));
  const uniq = (key) => [...new Set(all.map((r) => r[key]).filter(Boolean))].sort();
  const f = state.cdFilters || {};

  // Months + Years — same style/behaviour as the agreement bar
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const monthSel = el('select', { class: 'period-select', 'aria-label': 'Month' }, [
    el('option', { value: '', text: 'All months' }),
    ...MONTHS.map((m, i) => el('option', { value: String(i + 1), text: m })),
  ]);
  monthSel.value = state.period.month;
  monthSel.classList.toggle('active', !!state.period.month);
  monthSel.addEventListener('change', () => {
    state.period.month = monthSel.value;
    state.caMonth = monthSel.value ? MONTH_NAMES[Number(monthSel.value) - 1] : null;
    state.cdPage = 1; syncUrl(); render();
  });

  const years = [...new Set((state.rows || []).map((r) => r.__liveDateObj && r.__liveDateObj.getFullYear()).filter(Boolean))].sort((a, b) => b - a);
  const yearSel = el('select', { class: 'period-select', 'aria-label': 'Year' }, [
    el('option', { value: '', text: 'All years' }),
    ...years.map((y) => el('option', { value: String(y), text: String(y) })),
  ]);
  yearSel.value = state.period.year;
  yearSel.classList.toggle('active', !!state.period.year);
  yearSel.addEventListener('change', () => { state.period.year = yearSel.value; state.cdPage = 1; syncUrl(); render(); });

  row.append(monthSel, yearSel);

  // the churn dropdowns
  const addSelect = (label, key, options) => {
    const sel = el('select', { class: 'flt' });
    sel.classList.toggle('active', !!f[key]);
    sel.append(el('option', { value: '', text: label }));
    for (const o of options) {
      const opt = el('option', { value: o, text: o });
      if (f[key] === o) opt.selected = true;
      sel.append(opt);
    }
    sel.addEventListener('change', () => {
      state.cdFilters = { ...(state.cdFilters || {}), [key]: sel.value || null };
      state.cdPage = 1; render();
    });
    row.append(sel);
  };
  addSelect('All squads', 'squad', uniq('squad'));
  addSelect('All KAMs', 'kam', uniq('kam'));
  addSelect('All F&B bands', 'fnb', FNB_BUCKETS);
  addSelect('All reasons', 'reason', uniq('reason'));
  addSelect('All initiated-by', 'initiatedBy', uniq('initiatedBy'));
  addSelect('All GCF ranges', 'gcfRange', ['<5%', '5-10%', '>10%']);

  // search box (same style as agreement)
  const search = el('input', {
    class: 'filter-search', type: 'search',
    placeholder: 'Search property, KAM or squad…', 'aria-label': 'Search',
    value: state.search,
  });
  let t;
  search.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => { state.search = search.value.trim(); state.cdPage = 1; render(); }, 180);
  });
  row.append(search);

  const anyChurnFilter = (state.cdFilters && Object.values(state.cdFilters).some(Boolean)) || state.period.month || state.period.year || state.search;
  const reset = el('button', { type: 'button', class: 'reset-btn', text: 'Reset filters', disabled: !anyChurnFilter });
  reset.addEventListener('click', () => {
    state.cdFilters = {}; state.period = { month: '', year: '' }; state.caMonth = null; state.search = '';
    state.cdPage = 1; syncUrl(); render();
  });
  row.append(reset);

  bar.append(row);
  filterUI.built = false;   // force agreement bar to rebuild when we leave churn views
}

function renderFilters() {
  const bar = $('#filter-bar');
  if (!bar) return;

  if (state.loading || state.error || !state.rows.length || state.view === 'diagnostics') {
    bar.replaceChildren();
    filterUI.built = false;
    filterUI.controls = {};
    return;
  }

  // Churn pages get their own top filter bar (Months/Years/Squad/KAM/F&B/
  // Reason/Initiated-by/GCF/Search) — the agreement Status/Search bar is hidden.
  if (CHURN_VIEWS_WITH_BAR.includes(state.view)) {
    renderChurnTopBar();
    return;
  }

  if (filterUI.built && bar.firstChild) { updateFilters(); return; }

  bar.replaceChildren();
  const row = el('div', { class: 'filter-row' });

  // Month + Year period selects (filter on live_date)
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const monthSel = el('select', { class: 'period-select', 'aria-label': 'Month' }, [
    el('option', { value: '', text: 'All months' }),
    ...MONTHS.map((m, i) => el('option', { value: String(i + 1), text: m })),
  ]);
  monthSel.value = state.period.month;
  monthSel.classList.toggle('active', !!state.period.month);
  monthSel.addEventListener('change', () => { state.period.month = monthSel.value; onFiltersChanged(); });

  const years = [...new Set(state.rows.map((r) => r.__liveDateObj && r.__liveDateObj.getFullYear()).filter(Boolean))].sort((a, b) => b - a);
  const yearSel = el('select', { class: 'period-select', 'aria-label': 'Year' }, [
    el('option', { value: '', text: 'All years' }),
    ...years.map((y) => el('option', { value: String(y), text: String(y) })),
  ]);
  yearSel.value = state.period.year;
  yearSel.classList.toggle('active', !!state.period.year);
  yearSel.addEventListener('change', () => { state.period.year = yearSel.value; onFiltersChanged(); });

  row.append(monthSel, yearSel);
  filterUI.monthSel = monthSel;
  filterUI.yearSel = yearSel;

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
    state.filters = { squads: [], kams: [], statuses: [], newNoAgreement: false };
    state.period = { month: '', year: '' };
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
  if (filterUI.monthSel) { filterUI.monthSel.value = state.period.month; filterUI.monthSel.classList.toggle('active', !!state.period.month); }
  if (filterUI.yearSel) { filterUI.yearSel.value = state.period.year; filterUI.yearSel.classList.toggle('active', !!state.period.year); }
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
    state.filters = { squads: [], kams: [], statuses: [], newNoAgreement: false };
    state.period = { month: '', year: '' };
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
  state.focus = false;      // touching a filter leaves the drilled-in view
  state.returnTo = null;
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

  // Back button for a drilled-in (focused) view — top-left, returns to origin.
  // Churn views (churned/churn-detail/churn-rate) render their own back button,
  // so skip the global one there to avoid duplicates.
  const churnViews = ['churned', 'churn-detail', 'churn-rate'];
  if (state.focus && !churnViews.includes(state.view)) {
    const back = el('button', { type: 'button', class: 'back-btn' }, [
      el('span', { class: 'back-arrow', text: '‹' }),
      'Go back',
    ]);
    back.addEventListener('click', goBack);
    root.append(back);
  }

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
        'Agreement position by Owner Facing KAM. Cards open filtered property details in another tab of this browser.'));
      break;
    case 'properties':
      root.append(viewProperties(rows));
      break;
    case 'churned':
      root.append(viewChurned());
      break;
    case 'churn-detail':
      root.append(viewChurnDetail());
      break;
    case 'churn-rate':
      root.append(viewChurnRate());
      break;
    case 'master-list':
      root.append(viewMasterList());
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

// ---- data cache (localStorage, shared across tabs, short expiry) ----------
const DATA_CACHE_KEY = 'vt.datacache.v1';
const DATA_CACHE_TTL = 10 * 60 * 1000;   // 10 minutes

function readDataCache() {
  try {
    const raw = localStorage.getItem(DATA_CACHE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !obj.t || (Date.now() - obj.t) > DATA_CACHE_TTL) {
      localStorage.removeItem(DATA_CACHE_KEY);
      return null;
    }
    return obj.d;
  } catch {
    return null;
  }
}

function writeDataCache(data) {
  try {
    localStorage.setItem(DATA_CACHE_KEY, JSON.stringify({ t: Date.now(), d: data }));
  } catch {
    // too big for storage, or private mode — skip caching, no harm done
    try { localStorage.removeItem(DATA_CACHE_KEY); } catch { /* ignore */ }
  }
}

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
    const cached = !isRefresh ? readDataCache() : null;
    let raw, churnRef, churnAnalysis, gcfMarginal, misSquad, misMonthly;

    if (cached) {
      // reuse recently-fetched data — makes a new tab / revisit load instantly
      ({ raw, churnRef, churnAnalysis, gcfMarginal, misSquad, misMonthly } = cached);
    } else {
      raw = await fetchAllRows(state.diag);
      // The five churn/GCF/MIS tables are independent of each other — load them
      // all at once (parallel) instead of one-after-another, which is far faster.
      [churnRef, churnAnalysis, gcfMarginal, misSquad, misMonthly] = await Promise.all([
        fetchChurnRef(),
        fetchTable('churn_analysis'),
        fetchTable('gcf_marginal'),
        fetchTable('mis_squad_churn'),
        fetchTable('mis_monthly_churn'),
      ]);
      writeDataCache({ raw, churnRef, churnAnalysis, gcfMarginal, misSquad, misMonthly });
    }

    state.raw = raw;
    state.churnRef = churnRef;
    state.churnAnalysis = churnAnalysis;
    state.gcfMarginal = gcfMarginal;
    state.misSquadChurn = misSquad;
    state.misMonthlyChurn = misMonthly;
    state.cols = resolveColumns(raw[0]);

    // names can't separate the two status columns — the data can
    const detected = detectStatusColumns(raw);
    if (detected.signing)   state.cols.signing = detected.signing;
    if (detected.lifecycle) state.cols.lifecycle = detected.lifecycle;
    if (detected.signing && detected.lifecycle && detected.signing === detected.lifecycle) {
      state.cols.lifecycle = null;   // one column carries everything
    }
    state.diag.statusDetection = detected.scored;

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
    if (state.refreshing) {
      stamp.textContent = 'Refreshing…';
    } else if (state.loadedAt) {
      const live = state.rows.filter((r) => r.__live === true).length;
      const total = state.rows.length;
      const time = state.loadedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      // dynamic header: live/total straight from the last Supabase pull
      stamp.textContent = `${fmtInt(live)} live · ${fmtInt(total)} total · ${time}`;
    } else {
      stamp.textContent = '';
    }
  }
}

function init() {
  console.log('%cVista Tracker build: EXPIRED-READS-COLUMN-v2', 'font-weight:bold;color:#2f7d5b');
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