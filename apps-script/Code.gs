/**
 * Acq Master  ->  Supabase  ("agreement track")
 * ---------------------------------------------------------------------------
 * Headers are on row 2, data starts on row 3, Property ID is mandatory, and
 * empty cells are written as null.
 *
 * The schema changed once and will change again, so this script no longer
 * assumes the sheet headers ARE the Supabase column names. On every run it
 * asks Supabase which columns actually exist, then maps each sheet header onto
 * one of them:
 *
 *   1. an explicit entry in HEADER_OVERRIDES, if you have added one
 *   2. an exact match after normalising (lowercase, punctuation stripped)
 *   3. the snake_case form of the header, if that column exists
 *   4. otherwise the column is skipped and named in the log
 *
 * That means a renamed column degrades to one skipped field and a log line,
 * instead of a 400 that kills the whole sync.
 *
 * Run once from the editor:  setup()          - stores your URL and key
 * Run any time:              previewMapping() - shows the mapping, writes nothing
 * Scheduled:                 syncSheetToSupabase()
 */

const SHEET_NAME = 'Acq Master';
const TABLE_NAME = 'agreement track';
const HEADER_ROW = 2;   // real headers live on row 2
const FIRST_DATA_ROW = 3;
const BATCH_SIZE = 200;

/**
 * Only needed where the sheet header and the Supabase column can't be matched
 * automatically. Left side = header text in row 2, right side = Supabase column.
 * Add a line here whenever previewMapping() reports something as SKIPPED.
 */
const HEADER_OVERRIDES = {
  // 'Header exactly as it appears in row 2': 'supabase_column_name',
  // 'LTV : CAC': 'ltv_cac_original',
  // 'No. of Rooms': 'no_of_rooms',
};

/**
 * Columns that must be present for a row to be worth syncing.
 * Property ID is mandatory — rows without one are dropped.
 */
const REQUIRED_HEADER = 'Property ID';

/**
 * WHICH ROWS GET SYNCED
 * ---------------------------------------------------------------------------
 * Property ID is no longer required — around 93 real properties (mostly
 * Delisted, Paused or "Never went Live") have no ID but do have a name, a
 * squad, dates and a contract status, and those were being thrown away.
 *
 * What must NOT come through is the trailing junk: 4,212 rows with a single
 * cell filled and 1,000 with two, left behind by a formula dragged too far
 * down the sheet. So a row is kept when BOTH are true:
 *
 *   - at least one identity field has a value, and
 *   - at least MIN_FILLED_CELLS cells in the row have a value
 *
 * Run previewRowSelection() to see how many rows each threshold keeps before
 * committing to one.
 */
const REQUIRE_PROPERTY_ID = false;
const MIN_FILLED_CELLS = 3;
const IDENTITY_HEADERS = ['Property ID', 'Vista Name', 'Property Name'];

/**
 * Surrogate key. Property ID repeats in the sheet (the same villa can appear
 * several times with different agreements), so it cannot be the table's key.
 * If a column with this name exists in Supabase, the script fills it with the
 * actual spreadsheet row number — so row_id 43 is row 43 of Acq Master.
 * If you also add a column with this name to the SHEET, your value wins.
 */
const ROW_ID_COLUMN = 'row_id';

/**
 * POC is taken from the Owner Facing columns. The first of these that has a
 * value wins, so a blank primary falls through to the next.
 * Matching is fuzzy: any header containing all these words counts.
 */
const POC_SOURCE_PATTERNS = [
  ['owner', 'facing', 'account', 'manager'],
  ['owner', 'facing', 'poc'],
  ['owner', 'facing', 'ops'],
  ['owner', 'facing'],
];
const POC_TARGET_COLUMN = 'poc';

/* ------------------------------------------------------------------ helpers */

function norm_(v) {
  return String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function snake_(v) {
  return String(v == null ? '' : v)
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/__+/g, '_')
    .toLowerCase();
}

/** Dates must go over as yyyy-MM-dd, not "Mon Jul 29 2026 00:00:00 GMT+0530". */
function cellValue_(val) {
  if (val === '' || val === null || val === undefined) return null;
  if (Object.prototype.toString.call(val) === '[object Date]') {
    if (isNaN(val.getTime())) return null;
    return Utilities.formatDate(val, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  if (typeof val === 'number' || typeof val === 'boolean') return val;
  const s = String(val).trim();
  return s === '' ? null : s;
}

/**
 * Supabase's Data API page shows the URL WITH /rest/v1/ on the end, which is the
 * natural thing to copy. The script adds that part itself, so strip it here
 * rather than making everyone notice the difference.
 */
function cleanUrl_(raw) {
  return String(raw || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/rest\/v1$/i, '')
    .replace(/\/+$/, '');
}

function config_() {
  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty('SUPABASE_URL');
  const key = props.getProperty('SUPABASE_KEY');
  if (!url || !key) {
    throw new Error('SUPABASE_URL / SUPABASE_KEY are not set. Run setup() once from the editor.');
  }
  return { url: cleanUrl_(url), key: key, props: props };
}

function headers_(cfg) {
  return { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key };
}

/* ------------------------------------------------- live Supabase column list */

/**
 * Escape hatch. Only needed if the table is completely empty AND your project
 * has the OpenAPI endpoint disabled. Paste the column names in here and the
 * script will use them instead of asking Supabase.
 */
const MANUAL_COLUMNS = [];

/** Spellings of the table name to try — Postgres names are case-sensitive. */
function tableCandidates_() {
  const t = TABLE_NAME;
  const list = [t, t.toLowerCase(), snake_(t), t.replace(/\s+/g, '_'), t.replace(/\s+/g, '')];
  const seen = {}, out = [];
  list.forEach(function (x) { if (x && !seen[x]) { seen[x] = true; out.push(x); } });
  return out;
}

/**
 * Some projects have the OpenAPI document at /rest/v1/ disabled (PGRST125).
 * Try it, but never depend on it.
 */
function columnsFromSpec_(cfg, table) {
  try {
    const res = UrlFetchApp.fetch(cfg.url + '/rest/v1/', {
      method: 'get', headers: headers_(cfg), muteHttpExceptions: true,
    });
    if (res.getResponseCode() >= 300) return null;
    const defs = JSON.parse(res.getContentText()).definitions || {};
    let key = null;
    Object.keys(defs).forEach(function (name) { if (norm_(name) === norm_(table)) key = name; });
    if (!key) return null;
    const cols = Object.keys(defs[key].properties || {});
    return cols.length ? cols : null;
  } catch (e) {
    return null;
  }
}

/**
 * Read the real column names. Primary method is to pull one row and look at its
 * keys — that works on every project, needs no special permissions, and also
 * confirms the table name.
 */
function supabaseColumns_(cfg) {
  const tried = [];
  const names = tableCandidates_();

  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const res = UrlFetchApp.fetch(
      cfg.url + '/rest/v1/' + encodeURIComponent(name) + '?select=*&limit=1',
      { method: 'get', headers: headers_(cfg), muteHttpExceptions: true }
    );
    const code = res.getResponseCode();

    if (code >= 200 && code < 300) {
      let arr = [];
      try { arr = JSON.parse(res.getContentText()); } catch (e) { arr = []; }

      if (arr && arr.length) {
        return { table: name, columns: Object.keys(arr[0]), via: 'sample row' };
      }

      // Table is reachable but returned nothing.
      const spec = columnsFromSpec_(cfg, name);
      if (spec) return { table: name, columns: spec, via: 'OpenAPI schema' };
      if (MANUAL_COLUMNS.length) return { table: name, columns: MANUAL_COLUMNS, via: 'MANUAL_COLUMNS' };

      throw new Error(
        'Table "' + name + '" answered but returned no rows, so the column list could not be read. ' +
        'Either you are using the anon key and Row Level Security is hiding the rows — switch ' +
        'SUPABASE_KEY to the service_role key — or the table is genuinely empty, in which case ' +
        'paste the column names into MANUAL_COLUMNS at the top of this script.'
      );
    }

    tried.push(name + ' -> HTTP ' + code + ' ' + res.getContentText().substring(0, 160));
  }

  throw new Error(
    'Could not open the table.\n' + tried.join('\n') +
    '\n\nRun checkConnection() — it will tell you which setting is wrong.'
  );
}

/* ---------------------------------------------------------- connection check */

/**
 * Run this when something fails. It writes nothing and never prints your key.
 * It reports the two things that are almost always the cause: a malformed
 * SUPABASE_URL, or the wrong key.
 */
function checkConnection() {
  const props = PropertiesService.getScriptProperties();
  const rawUrl = props.getProperty('SUPABASE_URL');
  const key = props.getProperty('SUPABASE_KEY');

  Logger.log('=== VISTA TRACKER CONNECTION CHECK ===');

  if (!rawUrl) { Logger.log('❌ SUPABASE_URL is not set at all.'); return; }
  if (!key)    { Logger.log('❌ SUPABASE_KEY is not set at all.'); return; }

  /* --- 1. is the URL the right shape? --- */
  Logger.log('SUPABASE_URL as stored: "' + rawUrl + '"');
  const problems = [];
  if (/\s/.test(rawUrl)) problems.push('it contains a space');
  if (rawUrl.indexOf('supabase.com') !== -1) problems.push('it points at supabase.com — you have copied the DASHBOARD address, not the API address');
  if (/\/rest/.test(rawUrl)) Logger.log('ℹ Your URL includes /rest/v1 — harmless, the script strips it.');
  if (!/^https:\/\//.test(rawUrl)) problems.push('it does not start with https://');
  if (!/supabase\.(co|in|net)/.test(rawUrl) && rawUrl.indexOf('supabase.com') === -1) problems.push('it does not look like a Supabase address');

  const url = cleanUrl_(rawUrl);
  const expected = /^https:\/\/[a-z0-9]+\.supabase\.co$/.test(url);
  if (url !== rawUrl.trim().replace(/\/+$/, '')) {
    Logger.log('ℹ Trimmed "/rest/v1" off the end automatically. Using: ' + url);
  }

  if (problems.length) {
    Logger.log('❌ PROBLEM WITH THE URL:');
    problems.forEach(function (p) { Logger.log('   - ' + p); });
    Logger.log('   It should look exactly like: https://yourprojectref.supabase.co');
    Logger.log('   Find it in Supabase -> Settings -> API -> Project URL');
  } else if (!expected) {
    Logger.log('⚠ The URL is an unusual shape. Expected https://yourprojectref.supabase.co');
  } else {
    Logger.log('✅ URL shape looks correct.');
  }

  /* --- 2. which key is it? --- */
  const refInUrl = url.replace('https://', '').split('.')[0];

  if (key.indexOf('sb_secret_') === 0) {
    Logger.log('✅ New-format SECRET key — correct for writing.');
  } else if (key.indexOf('sb_publishable_') === 0) {
    Logger.log('❌ This is the PUBLISHABLE key. This script writes, so it needs the SECRET key.');
    Logger.log('   Supabase -> Settings -> API Keys -> Secret keys -> click the eye, then copy.');
  } else if (key.split('.').length === 3) {
    try {
      const json = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(key.split('.')[1])).getDataAsString());
      Logger.log('Legacy key role: ' + json.role);
      if (json.role === 'anon') {
        Logger.log('❌ This is the legacy ANON key. Use the service_role key, or the new sb_secret_ key.');
      } else if (json.role === 'service_role') {
        Logger.log('✅ Legacy service_role key — fine for writing.');
      }
      if (json.ref && refInUrl && json.ref !== refInUrl) {
        Logger.log('❌ MISMATCH: key belongs to project "' + json.ref + '" but the URL points at "' + refInUrl + '".');
      }
    } catch (e) {
      Logger.log('⚠ Could not read the legacy key — it may be truncated.');
    }
  } else {
    Logger.log('⚠ Unrecognised key format. Expected sb_secret_... (new) or a long eyJ... token (legacy).');
  }

  if (key.indexOf('\u2022') !== -1 || key.indexOf('...') !== -1 || key.length < 30) {
    Logger.log('❌ The key looks truncated — you may have copied the masked version shown on screen.');
    Logger.log('   Click the eye icon to reveal it first, then the copy icon.');
  }

  /* --- 3. what does the server actually say? --- */
  const probe = function (label, path) {
    try {
      const res = UrlFetchApp.fetch(url + path, {
        method: 'get',
        headers: { apikey: key, Authorization: 'Bearer ' + key },
        muteHttpExceptions: true,
      });
      Logger.log(label + ': HTTP ' + res.getResponseCode() + '  ' + res.getContentText().substring(0, 200));
      return res;
    } catch (e) {
      Logger.log(label + ': request failed — ' + e.message);
      return null;
    }
  };

  Logger.log('--- live responses ---');
  probe('API root       ', '/rest/v1/');
  const t = probe('Table as named ', '/rest/v1/' + encodeURIComponent(TABLE_NAME) + '?select=*&limit=1');

  if (t) {
    const body = t.getContentText();
    const code = t.getResponseCode();
    Logger.log('--- verdict ---');
    if (code >= 200 && code < 300) {
      Logger.log('✅ The table opened fine. Run previewMapping() next.');
    } else if (body.indexOf('does not exist') !== -1) {
      Logger.log('❌ The URL and key are fine, but there is no table called "' + TABLE_NAME + '".');
      Logger.log('   Open Supabase -> Table Editor, read the table name at the top of the list,');
      Logger.log('   and put that exact text in the TABLE_NAME line at the top of this script.');
    } else if (body.indexOf('PGRST125') !== -1 || body.indexOf('Invalid path') !== -1) {
      Logger.log('❌ The address is malformed. This is nearly always extra text on the end of');
      Logger.log('   SUPABASE_URL. It must be ONLY https://yourprojectref.supabase.co');
    } else if (code === 401 || code === 403) {
      Logger.log('❌ The key was rejected. Copy the service_role key again from Settings -> API.');
    } else {
      Logger.log('❌ Unexpected reply above — send that line and I can read it.');
    }
  }
}

/** How many rows the table holds right now. */
function rowCount_(cfg, table) {
  const res = UrlFetchApp.fetch(
    cfg.url + '/rest/v1/' + encodeURIComponent(table) + '?select=*&limit=1',
    { method: 'get', headers: Object.assign({ Prefer: 'count=exact', Range: '0-0' }, headers_(cfg)), muteHttpExceptions: true }
  );
  const cr = res.getAllHeaders()['content-range'] || res.getAllHeaders()['Content-Range'] || '';
  const total = parseInt(String(cr).split('/')[1], 10);
  return isNaN(total) ? null : total;
}

/* ------------------------------------------------------- header -> column map */

function buildMapping_(sheetHeaders, supaColumns) {
  // Character-for-character index, checked FIRST. This table has two columns
  // that differ only in capitalisation ("Contract status" vs "Contract Status"),
  // so a case-insensitive match alone would collapse them into one and silently
  // drop a column's worth of data on every sync.
  const byExact = {};
  supaColumns.forEach(function (c) { byExact[c] = c; });

  // Case-insensitive index, used only as a fallback. Where two columns collide
  // here, remember that so the ambiguity can be reported rather than guessed at.
  const byNorm = {};
  const collisions = {};
  supaColumns.forEach(function (c) {
    const n = norm_(c);
    if (byNorm[n] !== undefined) collisions[n] = true;
    else byNorm[n] = c;
  });

  const map = {};       // sheet header -> supabase column
  const skipped = [];
  const ambiguous = [];
  const used = {};

  const take = function (h, col) { map[h] = col; used[col] = true; };

  sheetHeaders.forEach(function (h) {
    if (!h) return;

    // 1. explicit override
    if (HEADER_OVERRIDES[h] && byExact[HEADER_OVERRIDES[h]]) { take(h, HEADER_OVERRIDES[h]); return; }
    if (HEADER_OVERRIDES[h] && byNorm[norm_(HEADER_OVERRIDES[h])]) { take(h, byNorm[norm_(HEADER_OVERRIDES[h])]); return; }

    // 2. exact, character-for-character
    if (byExact[h] && !used[h]) { take(h, h); return; }

    // 3. trimmed exact
    const trimmed = String(h).trim();
    if (byExact[trimmed] && !used[trimmed]) { take(h, trimmed); return; }

    // 4. case-insensitive, but only when it is unambiguous and still free
    const n = norm_(h);
    if (byNorm[n] && !used[byNorm[n]]) {
      if (collisions[n]) ambiguous.push(h);
      take(h, byNorm[n]);
      return;
    }

    // 5. snake_case form
    const sn = norm_(snake_(h));
    if (byNorm[sn] && !used[byNorm[sn]]) { take(h, byNorm[sn]); return; }

    skipped.push(h);
  });

  const unusedColumns = supaColumns.filter(function (c) { return !used[c]; });
  return { map: map, skipped: skipped, unusedColumns: unusedColumns, ambiguous: ambiguous };
}

/** Headers that feed POC, in priority order. */
function pocSourceHeaders_(sheetHeaders) {
  const found = [];
  POC_SOURCE_PATTERNS.forEach(function (words) {
    sheetHeaders.forEach(function (h) {
      const n = norm_(h);
      const hit = words.every(function (w) { return n.indexOf(w) !== -1; });
      if (hit && found.indexOf(h) === -1) found.push(h);
    });
  });
  return found;
}

/* --------------------------------------------------------- which rows to keep */

function countFilled_(row) {
  let filled = 0;
  for (let i = 0; i < row.length; i++) if (cellValue_(row[i]) !== null) filled++;
  return filled;
}

/** Returns null to keep the row, or a short reason to drop it. */
function dropReason_(row, idIndex, identityIndexes) {
  if (row.join('').trim() === '') return 'blank row';

  if (REQUIRE_PROPERTY_ID && (idIndex === -1 || cellValue_(row[idIndex]) === null)) {
    return 'no ' + REQUIRED_HEADER;
  }

  let hasIdentity = false;
  for (let i = 0; i < identityIndexes.length; i++) {
    if (cellValue_(row[identityIndexes[i]]) !== null) { hasIdentity = true; break; }
  }
  if (!hasIdentity) return 'no name or ID';

  if (countFilled_(row) < MIN_FILLED_CELLS) return 'fewer than ' + MIN_FILLED_CELLS + ' cells filled';

  return null;
}

function identityIndexes_(sheetHeaders) {
  const normed = sheetHeaders.map(norm_);
  const out = [];
  IDENTITY_HEADERS.forEach(function (h) {
    const i = normed.indexOf(norm_(h));
    if (i !== -1) out.push(i);
  });
  return out;
}

/* ------------------------------------------------------------------ read rows */

function readSheet_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('Sheet "' + SHEET_NAME + '" not found.');
  const data = sheet.getDataRange().getValues();
  if (data.length < FIRST_DATA_ROW) return { headers: [], rows: [] };
  const headers = data[HEADER_ROW - 1].map(function (h) { return String(h).trim(); });
  return { headers: headers, rows: data.slice(FIRST_DATA_ROW - 1) };
}

function buildPayload_(sheetHeaders, sheetRows, mapping, pocHeaders, pocColumn, rowIdColumn) {
  const idIndex = sheetHeaders.map(norm_).indexOf(norm_(REQUIRED_HEADER));
  const identity = identityIndexes_(sheetHeaders);
  const sheetHasRowId = sheetHeaders.map(norm_).indexOf(norm_(ROW_ID_COLUMN)) !== -1;
  const out = [];
  const dropped = {};
  let noPropertyId = 0;

  sheetRows.forEach(function (row, offset) {
    const reason = dropReason_(row, idIndex, identity);
    if (reason) { dropped[reason] = (dropped[reason] || 0) + 1; return; }
    if (idIndex === -1 || cellValue_(row[idIndex]) === null) noPropertyId++;

    const obj = {};

    // surrogate key = real spreadsheet row number, unless the sheet supplies one
    if (rowIdColumn && !sheetHasRowId) obj[rowIdColumn] = FIRST_DATA_ROW + offset;
    sheetHeaders.forEach(function (h, i) {
      const col = mapping.map[h];
      if (!col) return;                       // unmapped header, skipped
      if (col === pocColumn) return;          // POC is derived below, not copied
      obj[col] = cellValue_(row[i]);
    });

    // POC comes from the Owner Facing columns, first non-empty wins. If they are
    // all blank, keep whatever the sheet's own POC column says rather than
    // throwing the name away.
    if (pocColumn) {
      let poc = null;
      for (let k = 0; k < pocHeaders.length && poc === null; k++) {
        const idx = sheetHeaders.indexOf(pocHeaders[k]);
        if (idx !== -1) poc = cellValue_(row[idx]);
      }
      if (poc === null) {
        const ownIdx = sheetHeaders.map(norm_).indexOf(norm_(pocColumn));
        if (ownIdx !== -1) poc = cellValue_(row[ownIdx]);
      }
      obj[pocColumn] = poc;
    }

    out.push(obj);
  });

  return { rows: out, dropped: dropped, noPropertyId: noPropertyId };
}

/* ---------------------------------------------------------------- public API */

/** Run once from the editor, then delete your key from the code. */
function setup() {
  PropertiesService.getScriptProperties().setProperties({
    SUPABASE_URL: 'https://YOUR_PROJECT.supabase.co',
    SUPABASE_KEY: 'sb_secret_XXXXXXXXXXXX',
  });
  Logger.log('Stored. Now run previewMapping().');
}

/** Shows the header -> column mapping without writing anything. */
function previewMapping() {
  const cfg = config_();
  const schema = supabaseColumns_(cfg);
  const sheet = readSheet_();
  const mapping = buildMapping_(sheet.headers, schema.columns);
  const pocHeaders = pocSourceHeaders_(sheet.headers);
  const pocColumn = schema.columns.filter(function (c) { return norm_(c) === norm_(POC_TARGET_COLUMN); })[0] || null;

  Logger.log('Table: ' + schema.table + '   (column list read from: ' + schema.via + ')');
  Logger.log('Supabase columns: ' + schema.columns.length);
  Logger.log('  ' + schema.columns.join(' | '));
  Logger.log('Sheet headers: ' + sheet.headers.filter(String).length);
  Logger.log('--- MAPPED ---');
  Object.keys(mapping.map).forEach(function (h) { Logger.log('  "' + h + '"  ->  ' + mapping.map[h]); });
  const trulySkipped = mapping.skipped.filter(function (h) { return pocHeaders.indexOf(h) === -1; });
  Logger.log('--- SKIPPED (add to HEADER_OVERRIDES if these matter) ---');
  Logger.log(trulySkipped.length ? '  ' + trulySkipped.join(' | ') : '  none');
  if (mapping.ambiguous.length) {
    Logger.log('⚠ AMBIGUOUS (columns differing only by capitalisation): ' + mapping.ambiguous.join(' | '));
  }
  Logger.log('--- SUPABASE COLUMNS NOTHING WRITES TO ---');
  Logger.log(mapping.unusedColumns.length ? '  ' + mapping.unusedColumns.join(' | ') : '  none');
  const rowIdCol = schema.columns.filter(function (c) { return norm_(c) === norm_(ROW_ID_COLUMN); })[0] || null;
  Logger.log('--- ROW KEY ---');
  if (rowIdCol) {
    Logger.log('  ✅ "' + rowIdCol + '" found — repeated ' + REQUIRED_HEADER + ' values are safe.');
  } else {
    Logger.log('  ⚠ No "' + ROW_ID_COLUMN + '" column in Supabase. Add one if your sheet repeats ' + REQUIRED_HEADER + '.');
  }
  Logger.log('--- POC ---');
  Logger.log('  target column: ' + (pocColumn || 'NOT FOUND'));
  Logger.log('  sources in priority order: ' + (pocHeaders.join(' -> ') || 'NONE FOUND'));
}

function syncSheetToSupabase() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) { Logger.log('Sync already running — skipped.'); return; }

  try {
    const cfg = config_();
    const schema = supabaseColumns_(cfg);
    const sheet = readSheet_();
    if (!sheet.headers.length) { Logger.log('Nothing to sync — sheet is empty.'); return; }

    const mapping = buildMapping_(sheet.headers, schema.columns);
    const pocHeaders = pocSourceHeaders_(sheet.headers);
    const pocColumn = schema.columns.filter(function (c) { return norm_(c) === norm_(POC_TARGET_COLUMN); })[0] || null;

    // Owner Facing headers are handled by the POC step, so they are not "skipped"
    const trulySkipped = mapping.skipped.filter(function (h) { return pocHeaders.indexOf(h) === -1; });
    if (trulySkipped.length) {
      Logger.log('⚠ Unmapped headers (not synced): ' + trulySkipped.join(' | '));
    }
    if (mapping.unusedColumns.length) {
      Logger.log('⚠ Supabase columns nothing writes to: ' + mapping.unusedColumns.join(' | '));
    }
    if (pocColumn && !pocHeaders.length) {
      Logger.log('⚠ No "Owner Facing" header found — poc will be null for every row.');
    }

    const rowIdColumn = schema.columns.filter(function (c) { return norm_(c) === norm_(ROW_ID_COLUMN); })[0] || null;
    const built = buildPayload_(sheet.headers, sheet.rows, mapping, pocHeaders, pocColumn, rowIdColumn);
    const rows = built.rows;
    Logger.log('--- row selection ---');
    Object.keys(built.dropped).forEach(function (r) {
      Logger.log('  dropped, ' + r + ': ' + built.dropped[r]);
    });
    Logger.log('  kept: ' + rows.length + ' (of which ' + built.noPropertyId + ' have no ' + REQUIRED_HEADER + ')');
    if (!rows.length) { Logger.log('Nothing to sync.'); return; }

    // guard against a half-loaded sheet wiping the table
    const lastCount = parseInt(cfg.props.getProperty('LAST_SYNC_ROW_COUNT') || '0', 10);
    if (lastCount > 0 && rows.length < lastCount * 0.85) {
      Logger.log('⚠ SYNC SKIPPED — row count dropped from ' + lastCount + ' to ' + rows.length + '.');
      return;
    }

    // find the primary key column so the delete filter is always valid
    const propertyIdColumn = mapping.map[sheet.headers.filter(function (h) {
      return norm_(h) === norm_(REQUIRED_HEADER);
    })[0]];
    if (!propertyIdColumn) throw new Error('"' + REQUIRED_HEADER + '" is not mapped to any Supabase column.');

    // clear on the surrogate key when there is one, otherwise on Property ID
    if (!rowIdColumn) {
      throw new Error(
        'No "' + ROW_ID_COLUMN + '" column in Supabase. It is required now that rows without a ' +
        REQUIRED_HEADER + ' are synced — without it the old rows cannot be cleared and would pile up ' +
        'on every run. Run the one-line SQL in supabase-add-row-id.sql, then try again.'
      );
    }
    Logger.log('Row key: "' + rowIdColumn + '" (the spreadsheet row number).');

    const base = cfg.url + '/rest/v1/' + encodeURIComponent(schema.table);

    // Two passes: rows written by a previous sync (row_id set) and rows left
    // over from before row_id existed (row_id null). Together that is every row.
    const clearPasses = [
      encodeURIComponent(rowIdColumn) + '=not.is.null',
      encodeURIComponent(rowIdColumn) + '=is.null',
    ];
    for (let p = 0; p < clearPasses.length; p++) {
      const del = UrlFetchApp.fetch(base + '?' + clearPasses[p], {
        method: 'delete',
        headers: headers_(cfg),
        muteHttpExceptions: true,
      });
      if (del.getResponseCode() >= 300) {
        Logger.log('❌ DELETE FAILED (' + del.getResponseCode() + '): ' + del.getContentText().substring(0, 300));
        return;
      }
    }
    const leftOver = rowCount_(cfg, schema.table);
    Logger.log('Table cleared. Rows remaining: ' + (leftOver === null ? 'unknown' : leftOver));

    const post = function (payload) {
      return UrlFetchApp.fetch(base, {
        method: 'post',
        contentType: 'application/json',
        headers: Object.assign({ Prefer: 'return=minimal' }, headers_(cfg)),
        payload: JSON.stringify(payload),
        muteHttpExceptions: true,
      });
    };

    let inserted = 0;
    let rowsFailed = 0;
    const errorSamples = [];

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const res = post(batch);
      const code = res.getResponseCode();

      if (code >= 200 && code < 300) { inserted += batch.length; continue; }

      // A batch is all-or-nothing in Postgres, so ONE bad row used to lose 200.
      // Retry the batch a row at a time and record exactly which rows fail.
      Logger.log('Batch at row ' + i + ' failed (' + code + ') — retrying row by row.');
      for (let k = 0; k < batch.length; k++) {
        const one = post([batch[k]]);
        if (one.getResponseCode() < 300) { inserted++; continue; }
        rowsFailed++;
        if (errorSamples.length < 5) {
          errorSamples.push(
            'sheet row ' + (batch[k][rowIdColumn] || (FIRST_DATA_ROW + i + k)) +
            ' (' + REQUIRED_HEADER + ' ' + batch[k][propertyIdColumn] + '): ' +
            one.getContentText().substring(0, 220)
          );
        }
      }
    }

    const finalCount = rowCount_(cfg, schema.table);

    cfg.props.setProperty('LAST_SYNC_ROW_COUNT', String(inserted));
    cfg.props.setProperty('LAST_SYNC_AT', new Date().toISOString());

    Logger.log('=== RECONCILIATION ===');
    Logger.log('Rows read from the sheet      : ' + sheet.rows.length);
    Logger.log('Rows with a ' + REQUIRED_HEADER + '        : ' + rows.length);
    Logger.log('Rows accepted by Supabase     : ' + inserted);
    Logger.log('Rows rejected                 : ' + rowsFailed);
    Logger.log('Rows now in the table          : ' + (finalCount === null ? 'unknown' : finalCount));

    if (errorSamples.length) {
      Logger.log('--- WHY ROWS WERE REJECTED (first ' + errorSamples.length + ') ---');
      errorSamples.forEach(function (e) { Logger.log('  ' + e); });
      Logger.log('If this mentions "duplicate key" or "unique constraint", your sheet has repeated');
      Logger.log(REQUIRED_HEADER + ' values and the table will not accept them. Run diagnoseRowLoss().');
    }

    Logger.log(rowsFailed
      ? '⚠ ' + inserted + '/' + rows.length + ' saved. ' + rowsFailed + ' rejected — see above.'
      : '✅ Done. Synced ' + inserted + ' rows.');
  } finally {
    lock.releaseLock();
  }
}

/**
 * Answers "why does Supabase have fewer rows than the sheet?" without writing
 * anything. Run this whenever the counts disagree.
 */
function diagnoseRowLoss() {
  const cfg = config_();
  const schema = supabaseColumns_(cfg);
  const sheet = readSheet_();

  const idIndex = sheet.headers.map(norm_).indexOf(norm_(REQUIRED_HEADER));
  const identity = identityIndexes_(sheet.headers);
  let blank = 0, kept = 0, noId = 0;
  const droppedBy = {};
  const seen = {}, dupes = {};

  sheet.rows.forEach(function (row) {
    const reason = dropReason_(row, idIndex, identity);
    if (reason) {
      if (reason === 'blank row') blank++;
      else droppedBy[reason] = (droppedBy[reason] || 0) + 1;
      return;
    }
    kept++;
    const id = idIndex === -1 ? null : cellValue_(row[idIndex]);
    if (id === null) { noId++; return; }
    const k = String(id);
    if (seen[k]) dupes[k] = (dupes[k] || 1) + 1;
    seen[k] = true;
  });

  const withId = kept;
  const distinct = Object.keys(seen).length + noId;
  const dupeIds = Object.keys(dupes);
  const dupeRows = kept - distinct;
  const inTable = rowCount_(cfg, schema.table);

  Logger.log('=== WHY THE COUNTS DIFFER ===');
  Logger.log('Sheet: ' + SHEET_NAME + ', headers row ' + HEADER_ROW + ', data from row ' + FIRST_DATA_ROW);
  Logger.log('Rows scanned below the header : ' + sheet.rows.length);
  Logger.log('  completely blank            : ' + blank);
  Object.keys(droppedBy).forEach(function (r) {
    Logger.log('  dropped, ' + r + ' : ' + droppedBy[r]);
  });
  Logger.log('  KEPT for syncing            : ' + kept);
  Logger.log('    of which have no ' + REQUIRED_HEADER + ' : ' + noId);
  Logger.log('    repeated ' + REQUIRED_HEADER + ' rows    : ' + dupeRows);
  Logger.log('Rows currently in Supabase    : ' + (inTable === null ? 'unknown' : inTable));

  const lastSync = cfg.props.getProperty('LAST_SYNC_AT');
  Logger.log('Last successful sync          : ' + (lastSync || 'never recorded'));

  Logger.log('--- VERDICT ---');
  if (inTable === null) {
    Logger.log('Could not read the table count.');
  } else if (inTable === withId) {
    Logger.log('✅ Supabase matches the sheet. Nothing is being lost.');
  } else if (inTable === distinct && dupeRows > 0) {
    Logger.log('❌ Supabase holds one row per ' + REQUIRED_HEADER + ', but your sheet has ' + dupeRows + ' repeated rows.');
    Logger.log('   The table has a primary key or unique index on ' + REQUIRED_HEADER + ', so duplicates are rejected.');
    Logger.log('   Either drop that constraint in Supabase, or accept one row per property.');
    Logger.log('   Repeated IDs, first few: ' + dupeIds.slice(0, 10).join(', '));
  } else if (inTable < withId) {
    Logger.log('❌ Supabase is short by ' + (withId - inTable) + ' rows.');
    Logger.log('   Most likely the last sync did not finish, or rows were rejected.');
    Logger.log('   Run syncSheetToSupabase() and read the RECONCILIATION section it prints.');
    if (dupeRows > 0) Logger.log('   Note: ' + dupeRows + ' repeated ' + REQUIRED_HEADER + ' rows could also be the cause.');
  } else {
    Logger.log('⚠ Supabase has MORE rows (' + inTable + ') than the sheet has (' + withId + ').');
    Logger.log('   That means the table holds stale rows from an older sync that the delete step missed.');
    Logger.log('   Run syncSheetToSupabase() — it clears the table before reloading.');
  }
}

/**
 * Shows what the rows without a Property ID actually contain, so you can decide
 * whether they are real properties or leftover rows. Writes nothing.
 */
function inspectRowsWithoutId() {
  const sheet = readSheet_();
  const idIndex = sheet.headers.map(norm_).indexOf(norm_(REQUIRED_HEADER));
  if (idIndex === -1) { Logger.log('No "' + REQUIRED_HEADER + '" header found.'); return; }

  // the handful of columns most useful for recognising a row
  const interesting = ['Vista Name', 'Property Name', 'Squad', 'City', 'Current Status', 'Contract status'];
  const cols = interesting
    .map(function (want) {
      const i = sheet.headers.map(norm_).indexOf(norm_(want));
      return i === -1 ? null : { name: sheet.headers[i], i: i };
    })
    .filter(Boolean);

  let shown = 0, empty = 0, total = 0;
  const filledCounts = {};
  const samples = [];

  sheet.rows.forEach(function (row, offset) {
    if (row.join('').trim() === '') return;
    if (cellValue_(row[idIndex]) !== null) return;
    total++;

    // how many cells in this row actually hold something?
    let filled = 0;
    row.forEach(function (v) { if (cellValue_(v) !== null) filled++; });
    filledCounts[filled] = (filledCounts[filled] || 0) + 1;
    if (filled === 0) empty++;

    if (shown < 15) {
      shown++;
      const parts = cols.map(function (c) { return c.name + '=' + (cellValue_(row[c.i]) || '—'); });
      samples.push('  sheet row ' + (FIRST_DATA_ROW + offset) + ' [' + filled + ' cells filled]  ' + parts.join('  |  '));
    }
  });

  Logger.log('=== ROWS WITH NO ' + REQUIRED_HEADER + ' ===');
  Logger.log('Total: ' + total);
  Logger.log('Of those, rows where EVERY cell is empty: ' + empty);
  Logger.log('');
  Logger.log('How many cells these rows have filled:');
  Object.keys(filledCounts)
    .sort(function (a, b) { return Number(a) - Number(b); })
    .slice(0, 12)
    .forEach(function (k) { Logger.log('  ' + k + ' cell(s) filled  ->  ' + filledCounts[k] + ' rows'); });
  Logger.log('');
  Logger.log('First ' + shown + ' of them:');
  samples.forEach(function (line) { Logger.log(line); });
  Logger.log('');
  Logger.log('If these look like real properties, they need Property IDs in the sheet.');
  Logger.log('If they are leftover rows or stray formulas, delete them and the counts will line up.');
}

/**
 * Shows how many rows each MIN_FILLED_CELLS threshold would keep, so you can
 * choose one before syncing. Writes nothing.
 */
function previewRowSelection() {
  const sheet = readSheet_();
  const idIndex = sheet.headers.map(norm_).indexOf(norm_(REQUIRED_HEADER));
  const identity = identityIndexes_(sheet.headers);

  const rows = sheet.rows.filter(function (r) { return r.join('').trim() !== ''; });
  Logger.log('=== ROW SELECTION ===');
  Logger.log('Identity columns used: ' + IDENTITY_HEADERS.join(', '));
  Logger.log('Non-blank rows below the header: ' + rows.length);
  Logger.log('');
  Logger.log('threshold   kept    of which have no ' + REQUIRED_HEADER);

  for (let t = 1; t <= 6; t++) {
    let kept = 0, noId = 0;
    rows.forEach(function (row) {
      let hasIdentity = false;
      for (let i = 0; i < identity.length; i++) {
        if (cellValue_(row[identity[i]]) !== null) { hasIdentity = true; break; }
      }
      if (!hasIdentity) return;
      if (countFilled_(row) < t) return;
      kept++;
      if (idIndex === -1 || cellValue_(row[idIndex]) === null) noId++;
    });
    Logger.log('  >= ' + t + ' cells   ' + kept + '     ' + noId + (t === MIN_FILLED_CELLS ? '   <-- current setting' : ''));
  }

  Logger.log('');
  Logger.log('Change MIN_FILLED_CELLS at the top of this script to move the line.');
}

/** Optional: run once to sync every hour. */
function createHourlyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncSheetToSupabase') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncSheetToSupabase').timeBased().everyHours(1).create();
  Logger.log('Hourly trigger created.');
}
