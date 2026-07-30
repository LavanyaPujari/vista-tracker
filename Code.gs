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

function config_() {
  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty('SUPABASE_URL');
  const key = props.getProperty('SUPABASE_KEY');
  if (!url || !key) {
    throw new Error('SUPABASE_URL / SUPABASE_KEY are not set. Run setup() once from the editor.');
  }
  return { url: url.replace(/\/+$/, ''), key: key, props: props };
}

function headers_(cfg) {
  return { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key };
}

/* ------------------------------------------------- live Supabase column list */

/**
 * PostgREST publishes an OpenAPI document at the API root that lists every
 * table and its columns. That is the source of truth for the mapping.
 */
function supabaseColumns_(cfg) {
  const res = UrlFetchApp.fetch(cfg.url + '/rest/v1/', {
    method: 'get',
    headers: headers_(cfg),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('Could not read the Supabase schema (' + res.getResponseCode() + '): ' +
      res.getContentText().substring(0, 200));
  }
  const doc = JSON.parse(res.getContentText());
  const defs = doc.definitions || {};

  // find the table case-insensitively — Postgres names are case-sensitive
  let key = null;
  Object.keys(defs).forEach(function (name) {
    if (norm_(name) === norm_(TABLE_NAME)) key = name;
  });
  if (!key) {
    throw new Error('Table "' + TABLE_NAME + '" not found. Tables visible to this key: ' +
      Object.keys(defs).join(', '));
  }
  return { table: key, columns: Object.keys(defs[key].properties || {}) };
}

/* ------------------------------------------------------- header -> column map */

function buildMapping_(sheetHeaders, supaColumns) {
  const byNorm = {};
  supaColumns.forEach(function (c) { byNorm[norm_(c)] = c; });

  const map = {};       // sheet header -> supabase column
  const skipped = [];
  const used = {};

  sheetHeaders.forEach(function (h) {
    if (!h) return;

    // 1. explicit override
    if (HEADER_OVERRIDES[h] && byNorm[norm_(HEADER_OVERRIDES[h])]) {
      map[h] = byNorm[norm_(HEADER_OVERRIDES[h])];
      used[map[h]] = true;
      return;
    }
    // 2. normalised exact match ("Property ID" -> property_id)
    if (byNorm[norm_(h)]) {
      map[h] = byNorm[norm_(h)];
      used[map[h]] = true;
      return;
    }
    // 3. snake_case form
    if (byNorm[norm_(snake_(h))]) {
      map[h] = byNorm[norm_(snake_(h))];
      used[map[h]] = true;
      return;
    }
    skipped.push(h);
  });

  const unusedColumns = supaColumns.filter(function (c) { return !used[c]; });
  return { map: map, skipped: skipped, unusedColumns: unusedColumns };
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

/* ------------------------------------------------------------------ read rows */

function readSheet_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('Sheet "' + SHEET_NAME + '" not found.');
  const data = sheet.getDataRange().getValues();
  if (data.length < FIRST_DATA_ROW) return { headers: [], rows: [] };
  const headers = data[HEADER_ROW - 1].map(function (h) { return String(h).trim(); });
  return { headers: headers, rows: data.slice(FIRST_DATA_ROW - 1) };
}

function buildPayload_(sheetHeaders, sheetRows, mapping, pocHeaders, pocColumn) {
  const idIndex = sheetHeaders.map(norm_).indexOf(norm_(REQUIRED_HEADER));
  const out = [];
  let droppedNoId = 0;

  sheetRows.forEach(function (row) {
    if (row.join('').trim() === '') return;
    if (idIndex === -1 || cellValue_(row[idIndex]) === null) { droppedNoId++; return; }

    const obj = {};
    sheetHeaders.forEach(function (h, i) {
      const col = mapping.map[h];
      if (!col) return;                       // unmapped header, skipped
      if (col === pocColumn) return;          // POC is derived below, not copied
      obj[col] = cellValue_(row[i]);
    });

    // POC comes from the Owner Facing columns, first non-empty wins
    if (pocColumn) {
      let poc = null;
      for (let k = 0; k < pocHeaders.length && poc === null; k++) {
        const idx = sheetHeaders.indexOf(pocHeaders[k]);
        if (idx !== -1) poc = cellValue_(row[idx]);
      }
      obj[pocColumn] = poc;
    }

    out.push(obj);
  });

  return { rows: out, droppedNoId: droppedNoId };
}

/* ---------------------------------------------------------------- public API */

/** Run once from the editor, then delete your key from the code. */
function setup() {
  PropertiesService.getScriptProperties().setProperties({
    SUPABASE_URL: 'https://YOUR_PROJECT.supabase.co',
    SUPABASE_KEY: 'YOUR_SERVICE_ROLE_OR_ANON_KEY',
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

  Logger.log('Table: ' + schema.table);
  Logger.log('Supabase columns: ' + schema.columns.length);
  Logger.log('Sheet headers: ' + sheet.headers.filter(String).length);
  Logger.log('--- MAPPED ---');
  Object.keys(mapping.map).forEach(function (h) { Logger.log('  "' + h + '"  ->  ' + mapping.map[h]); });
  const trulySkipped = mapping.skipped.filter(function (h) { return pocHeaders.indexOf(h) === -1; });
  Logger.log('--- SKIPPED (add to HEADER_OVERRIDES if these matter) ---');
  Logger.log(trulySkipped.length ? '  ' + trulySkipped.join(' | ') : '  none');
  Logger.log('--- SUPABASE COLUMNS NOTHING WRITES TO ---');
  Logger.log(mapping.unusedColumns.length ? '  ' + mapping.unusedColumns.join(' | ') : '  none');
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
    if (pocColumn && !pocHeaders.length) {
      Logger.log('⚠ No "Owner Facing" header found — poc will be null for every row.');
    }

    const built = buildPayload_(sheet.headers, sheet.rows, mapping, pocHeaders, pocColumn);
    const rows = built.rows;
    if (built.droppedNoId) Logger.log('Dropped ' + built.droppedNoId + ' row(s) with no ' + REQUIRED_HEADER + '.');
    if (!rows.length) { Logger.log('Nothing to sync — no rows with a ' + REQUIRED_HEADER + '.'); return; }

    // guard against a half-loaded sheet wiping the table
    const lastCount = parseInt(cfg.props.getProperty('LAST_SYNC_ROW_COUNT') || '0', 10);
    if (lastCount > 0 && rows.length < lastCount * 0.85) {
      Logger.log('⚠ SYNC SKIPPED — row count dropped from ' + lastCount + ' to ' + rows.length + '.');
      return;
    }

    // find the primary key column so the delete filter is always valid
    const idColumn = mapping.map[sheet.headers.filter(function (h) {
      return norm_(h) === norm_(REQUIRED_HEADER);
    })[0]];
    if (!idColumn) throw new Error('"' + REQUIRED_HEADER + '" is not mapped to any Supabase column.');

    const base = cfg.url + '/rest/v1/' + encodeURIComponent(schema.table);
    const del = UrlFetchApp.fetch(base + '?' + encodeURIComponent(idColumn) + '=not.is.null', {
      method: 'delete',
      headers: headers_(cfg),
      muteHttpExceptions: true,
    });
    Logger.log('Delete: ' + del.getResponseCode());
    if (del.getResponseCode() >= 300) {
      Logger.log('❌ DELETE FAILED: ' + del.getContentText().substring(0, 300));
      return;
    }

    let inserted = 0, failed = 0;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const res = UrlFetchApp.fetch(base, {
        method: 'post',
        contentType: 'application/json',
        headers: headers_(cfg),
        payload: JSON.stringify(batch),
        muteHttpExceptions: true,
      });
      const code = res.getResponseCode();
      if (code >= 200 && code < 300) inserted += batch.length;
      else { failed++; Logger.log('❌ Batch ' + i + ' FAILED (' + code + '): ' + res.getContentText().substring(0, 300)); }
    }

    cfg.props.setProperty('LAST_SYNC_ROW_COUNT', String(inserted));
    cfg.props.setProperty('LAST_SYNC_AT', new Date().toISOString());
    Logger.log(failed
      ? '⚠ ' + inserted + '/' + rows.length + ' saved, ' + failed + ' batch(es) failed.'
      : '✅ Done. Synced ' + inserted + ' rows.');
  } finally {
    lock.releaseLock();
  }
}

/** Optional: run once to sync every hour. */
function createHourlyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncSheetToSupabase') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncSheetToSupabase').timeBased().everyHours(1).create();
  Logger.log('Hourly trigger created.');
}
