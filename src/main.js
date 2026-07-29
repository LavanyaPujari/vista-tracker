const SUPABASE_URL = "https://benzjvkbevombzjwwtqr.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJlbnpqdmtiZXZvbWJ6and3dHFyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ3ODY3NjIsImV4cCI6MjEwMDM2Mjc2Mn0.E8ZxzUmT5xdOwmAd8Yg_i8lLkBXHM3vh8itV1WBZV8M";
const TABLE_NAME = "agreement track";

// Color palette assigned dynamically to whatever status values actually exist in this data
const STATUS_PALETTE = [
  { bg:'#e3f0e6', fg:'#2f6b3f', dot:'#3f7d5c' }, // green
  { bg:'#f7e3e0', fg:'#a13f30', dot:'#a13f30' }, // red
  { bg:'#f4ecd8', fg:'#8a6a1f', dot:'#b58a1f' }, // amber
  { bg:'#e6e6f2', fg:'#4b4b8a', dot:'#4b4b8a' }, // indigo
  { bg:'#e6f0f2', fg:'#2f6a78', dot:'#2f8a9a' }, // teal
  { bg:'#f2e6f0', fg:'#8a2f6a', dot:'#8a2f6a' }, // magenta
];
const OTHER_STYLE = { bg:'#f1f1f1', fg:'#555', dot:'#999' };
let STATUS_STYLE = {}; // built dynamically once data loads
let KPI_ORDER = [];
let KPI_LABELS = {};

const RENEWAL_WINDOW_DAYS = 60;
// ASSUMPTION: no "sent to owner without response" tracking column was present in the
// columns this app already knew about, so this is detected dynamically from whatever
// columns exist (see detectOwnerResponseColumns). 14 days is a placeholder threshold —
// change it below if your team uses a different SLA.
const NO_RESPONSE_THRESHOLD_DAYS = 14;

let allRows = [];
let squadList = [];
let pocList = []; // stand-in for "KAM" — this sheet's closest equivalent is POC
let sidebarExpanded = { squads: true, pocs: false };
let openTabs = ['ALL'];
let activeTabId = 'ALL';
let activeRow = null;
let lastSyncedAt = null;
let isRefreshing = false;
let followUpDone = new Set();

// dynamically detected column names for the "awaiting owner response" tracking —
// null if this dataset doesn't have anything matching
let SENT_DATE_KEY = null;
let RESPONSE_KEY = null;

let tabState = {};
function getTabState(tabId){
  if(!tabState[tabId]) tabState[tabId] = { search:'', statusFilter:'all', urgentOnly:null, healthFilter:'all', sort:'health' };
  return tabState[tabId];
}

function handleLogin(){
  const email = document.getElementById('email-input').value.trim();
  const err = document.getElementById('login-error');
  if(!email.includes('@')){ err.style.display='block'; return; }
  err.style.display='none';
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('who-label').textContent = email;
  boot();
}
function signOut(){
  document.getElementById('app').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('email-input').value='';
}

async function fetchAllRows(){
  let all = [];
  let from = 0;
  const batchSize = 1000;
  while(true){
    const url = `${SUPABASE_URL}/rest/v1/${encodeURIComponent(TABLE_NAME)}?select=*`;
    const res = await fetch(url, {
      headers: { "apikey": SUPABASE_ANON_KEY, "Authorization": `Bearer ${SUPABASE_ANON_KEY}`, "Range": `${from}-${from+batchSize-1}` }
    });
    if(!res.ok){
      const text = await res.text();
      throw new Error(`Supabase returned status ${res.status}: ${text}`);
    }
    const batch = await res.json();
    all = all.concat(batch);
    if(batch.length < batchSize) break;
    from += batchSize;
  }
  return all;
}

async function boot(){
  const root = document.getElementById('view-root');
  root.innerHTML = `<div class="loading-note">Loading data from Supabase…</div>`;
  try{
    allRows = await fetchAllRows();
    buildColumnIndex();
    buildStatusStyles();
    buildGroupLists();
    detectOwnerResponseColumns();
    lastSyncedAt = new Date();
    renderSidebar();
    renderTabStrip();

    // If this tab was opened via "View Full Details" (?property=ID), jump straight
    // to that property's record instead of showing the dashboard first.
    const urlPropertyId = new URLSearchParams(window.location.search).get('property');
    if(urlPropertyId){
      const match = allRows.find(r => String(getPropertyId(r)) === urlPropertyId);
      if(match) activeRow = match;
    }

    renderActiveTab();
    updateSyncLabel();
    // keep the dashboard fresh without a full page reload
    setInterval(manualRefresh, 60000);
  }catch(e){
    root.innerHTML = `<div class="error-note">Could not reach Supabase: ${e.message}</div>`;
  }
}

async function manualRefresh(){
  if(isRefreshing) return;
  isRefreshing = true;
  const btn = document.getElementById('refresh-btn');
  if(btn){ btn.classList.add('spinning'); btn.disabled = true; }
  try{
    const fresh = await fetchAllRows();
    if(fresh && fresh.length){
      allRows = fresh;
      buildColumnIndex();
      buildStatusStyles();
      buildGroupLists();
      detectOwnerResponseColumns();
      lastSyncedAt = new Date();
      if(!activeRow){
        renderSidebar();
        renderTabStrip();
        renderActiveTab();
      }
    }
  }catch(e){
    console.error('Refresh from Supabase failed:', e);
  }finally{
    isRefreshing = false;
    const btn2 = document.getElementById('refresh-btn');
    if(btn2){ btn2.classList.remove('spinning'); btn2.disabled = false; }
    updateSyncLabel();
  }
}
function updateSyncLabel(){
  const label = document.getElementById('sync-label');
  if(label) label.textContent = lastSyncedAt ? `Synced ${lastSyncedAt.toLocaleTimeString()}` : '';
}

// ---------- RESILIENT COLUMN LOOKUP ----------
// Supabase/CSV imports sometimes rename columns (e.g. "Vista Name" -> "vista_name")
// depending on how a table was created. Instead of hardcoding one exact spelling,
// build a normalized index once per data load, and look fields up by trying several
// likely names. This means renaming/re-importing a table won't silently break the
// dashboard the way it did with "Squad"/"Current Status" showing as blank.
let COLUMN_INDEX = {}; // normalized name -> actual key as it appears in the data

function normalizeKey(k){
  return k.toString().toLowerCase().replace(/[^a-z0-9]/g, '');
}
function buildColumnIndex(){
  COLUMN_INDEX = {};
  if(!allRows.length) return;
  Object.keys(allRows[0]).forEach(k=>{
    COLUMN_INDEX[normalizeKey(k)] = k;
  });
}
// tries each candidate name (any casing/spacing/underscore style) and returns the
// first one that actually exists in this row's data
function getVal(row, candidates){
  for(const c of candidates){
    const actualKey = COLUMN_INDEX[normalizeKey(c)];
    if(actualKey !== undefined && row[actualKey] !== undefined && row[actualKey] !== null && row[actualKey] !== ''){
      return row[actualKey];
    }
  }
  return null;
}

function fieldsFor(row){
  return {
    name: getVal(row, ["Vista Name","Property Name","vista_name","property_name"]) || "Unnamed property",
    // this sheet has no "Owner Facing Account Manager" column in some imports — POC is the closest stand-in for KAM
    owner: (getVal(row, ["POC","Owner Facing Account Manager","poc"]) || "").toString().trim() || "Unassigned",
    status: (getVal(row, ["Current Status","current_status","Property Current Status"]) || "").toString().trim() || "Unknown",
    kickoff: getVal(row, ["Live date","Live Date","live_date"]) || "—",
    endDateRaw: getVal(row, ["Agreement end date","Agreement End Date","agreement_end_date"]) || null,
    contractStatus: getVal(row, ["Contract status","Contract Status","contract_status"]) || "—",
    squad: (getVal(row, ["Squad","squad","New Squad Mapping"]) || "").toString().trim() || "Unassigned",
    city: (getVal(row, ["City","city"]) || "").toString().trim() || "—",
    sentToOwnerRaw: SENT_DATE_KEY ? row[SENT_DATE_KEY] : null,
    ownerResponse: RESPONSE_KEY ? (row[RESPONSE_KEY] || "").toString().trim() : "",
  };
}

// A stable identifier for a property, used to build the "?property=ID" link that
// lets "View Full Details" open in a genuine new browser tab (not just a new panel
// in the same tab) — the new tab re-loads the app and jumps straight to this record.
function getPropertyId(row){
  return getVal(row, ["Property ID","property_id","row_id"]) || "";
}
function openPropertyInNewTab(row){
  const id = getPropertyId(row);
  if(!id){ activeRow = row; renderActiveTab(); return; } // no stable id available — fall back to in-page view
  const url = `${window.location.pathname}?property=${encodeURIComponent(id)}`;
  window.open(url, '_blank');
}
// Proper "go back to the dashboard" reset — used by the Back button. (Directly
// assigning to activeRow / calling renderActiveTab from an inline onclick doesn't
// work reliably here since this app is built as an ES module, so those names aren't
// available as bare globals in the page; routing through openTab(), which IS exposed
// on window, fixes it.)
function goBackHome(){
  openTab('ALL');
}

// Looks for a column that tracks "agreement sent to owner" and one that tracks the
// owner's response, since column names vary and this app was never told the exact ones.
function detectOwnerResponseColumns(){
  SENT_DATE_KEY = null; RESPONSE_KEY = null;
  if(!allRows.length) return;
  const keys = Object.keys(allRows[0]);
  SENT_DATE_KEY = keys.find(k => /sent/i.test(k) && /owner/i.test(k))
    || keys.find(k => /sent/i.test(k) && /date/i.test(k))
    || null;
  RESPONSE_KEY = keys.find(k => /response/i.test(k)) || null;
}

function buildStatusStyles(){
  const counts = {};
  allRows.forEach(row=>{
    const s = fieldsFor(row).status;
    counts[s] = (counts[s]||0)+1;
  });
  const sorted = Object.entries(counts).sort((a,b)=>b[1]-a[1]);
  const top = sorted.slice(0,6).map(e=>e[0]);
  STATUS_STYLE = {};
  top.forEach((s,i)=>{ STATUS_STYLE[s.toLowerCase()] = STATUS_PALETTE[i % STATUS_PALETTE.length]; });
  KPI_ORDER = top.map(s=>s.toLowerCase());
  KPI_LABELS = {};
  top.forEach(s=>{ KPI_LABELS[s.toLowerCase()] = s; });
}
function statusKey(status){
  const s = (status||'').toString().trim().toLowerCase();
  return STATUS_STYLE[s] ? s : 'other';
}
function styleFor(key){ return STATUS_STYLE[key] || OTHER_STYLE; }

// Live/Delisted get a fixed semantic color regardless of palette rank; everything else
// keeps its dynamically-assigned palette color.
function semanticStyleFor(key){
  const label = (KPI_LABELS[key]||'').toLowerCase();
  if(label.includes('live')) return { dot:'#3f7d5c', fg:'#1f5c37' };
  if(label.includes('delist')) return { dot:'#a13f30', fg:'#7a2318' };
  const st = styleFor(key);
  return { dot: st.dot, fg: st.fg };
}
function hexMix(hex, pct){
  const h = hex.replace('#','');
  const r = parseInt(h.substring(0,2),16), g = parseInt(h.substring(2,4),16), b = parseInt(h.substring(4,6),16);
  const mr = Math.round(r + (255-r)*pct), mg = Math.round(g + (255-g)*pct), mb = Math.round(b + (255-b)*pct);
  return `rgb(${mr},${mg},${mb})`;
}

function daysRemaining(endDateRaw){
  if(!endDateRaw) return null;
  const end = new Date(endDateRaw);
  if(isNaN(end.getTime())) return null;
  const today = new Date(); today.setHours(0,0,0,0);
  end.setHours(0,0,0,0);
  return Math.round((end - today) / 86400000);
}
function urgencyLevel(endDateRaw){
  const d = daysRemaining(endDateRaw);
  if(d === null) return null;
  if(d < 0) return 'expired';   // agreement end date has already passed — distinct from "expiring soon"
  if(d <= 7) return 'red';
  if(d <= 30) return 'orange';
  return null;
}
function daysSince(dateRaw){
  if(!dateRaw) return null;
  const d = new Date(dateRaw);
  if(isNaN(d.getTime())) return null;
  const today = new Date(); today.setHours(0,0,0,0); d.setHours(0,0,0,0);
  return Math.round((today - d) / 86400000);
}
function isAwaitingResponse(f){
  if(!SENT_DATE_KEY) return false;
  const days = daysSince(f.sentToOwnerRaw);
  if(days === null || days < NO_RESPONSE_THRESHOLD_DAYS) return false;
  const resp = (f.ownerResponse||'').toLowerCase();
  if(!resp) return true;
  return /pending|no response|awaiting|not received|none/i.test(resp);
}

function buildGroupLists(){
  const sq = {}, poc = {};
  allRows.forEach(row=>{
    const f = fieldsFor(row);
    sq[f.squad] = (sq[f.squad]||0)+1;
    poc[f.owner] = (poc[f.owner]||0)+1;
  });
  squadList = Object.entries(sq).sort((a,b)=>b[1]-a[1]).map(([name,count])=>({name,count}));
  pocList = Object.entries(poc).sort((a,b)=>b[1]-a[1]).map(([name,count])=>({name,count}));
}

function tabIdFor(type,name){ return `${type}::${name}`; }
function parseTab(tabId){
  if(tabId==='ALL') return {type:'ALL', name:'All Properties'};
  const [type,...rest] = tabId.split('::');
  return {type, name: rest.join('::')};
}

function renderSidebar(){
  const sb = document.getElementById('sidebar');
  sb.innerHTML = `
    <div class="sidebar-title">Overview</div>
    <div class="sidebar-item ${activeTabId==='ALL'?'active':''}" onclick="openTab('ALL')">
      <span>All Properties</span><span class="sidebar-count">${allRows.length}</span>
    </div>
    <div class="sidebar-divider"></div>

    <div class="sidebar-section-header" onclick="toggleSection('squads')">
      <span>Squad</span><span class="sidebar-caret">${sidebarExpanded.squads?'▾':'▸'}</span>
    </div>
    ${sidebarExpanded.squads ? `<div class="sidebar-sublist">${squadList.map(s=>`
      <div class="sidebar-item ${activeTabId===tabIdFor('SQUAD',s.name)?'active':''}" onclick="openTab('${tabIdFor('SQUAD',s.name).replace(/'/g,"\\'")}')">
        <span>${escapeHtml(s.name)}</span><span class="sidebar-count">${s.count}</span>
      </div>`).join('')}</div>` : ''}

    <div class="sidebar-divider"></div>

    <div class="sidebar-section-header" onclick="toggleSection('pocs')">
      <span>POC (KAM)</span><span class="sidebar-caret">${sidebarExpanded.pocs?'▾':'▸'}</span>
    </div>
    ${sidebarExpanded.pocs ? `<div class="sidebar-sublist">${pocList.map(k=>`
      <div class="sidebar-item ${activeTabId===tabIdFor('POC',k.name)?'active':''}" onclick="openTab('${tabIdFor('POC',k.name).replace(/'/g,"\\'")}')">
        <span>${escapeHtml(k.name)}</span><span class="sidebar-count">${k.count}</span>
      </div>`).join('')}</div>` : ''}
  `;
}
function toggleSection(key){
  sidebarExpanded[key] = !sidebarExpanded[key];
  renderSidebar();
}

function openTab(tabId){
  if(!openTabs.includes(tabId)) openTabs.push(tabId);
  activeTabId = tabId;
  activeRow = null;
  renderSidebar();
  renderTabStrip();
  renderActiveTab();
}
function closeTab(tabId, evt){
  evt.stopPropagation();
  if(tabId === 'ALL') return;
  openTabs = openTabs.filter(t=>t!==tabId);
  delete tabState[tabId];
  if(activeTabId === tabId) activeTabId = 'ALL';
  renderSidebar();
  renderTabStrip();
  renderActiveTab();
}
function renderTabStrip(){
  const strip = document.getElementById('tab-strip');
  strip.innerHTML = openTabs.map(t=>{
    const p = parseTab(t);
    const icon = t==='ALL' ? '🏠' : p.type==='SQUAD' ? '📍' : p.type==='POC' ? '🧑' : p.type==='STATUS' ? '📊' : p.type==='URGENT' ? '⚠' : '📄';
    const label = `${icon} ${escapeHtml(tabDisplayName(p))}`;
    return `
    <div class="browser-tab ${activeTabId===t?'active':''}" onclick="openTab('${t.replace(/'/g,"\\'")}')">
      <span>${label}</span>
      ${t!=='ALL' ? `<span class="close-x" onclick="closeTab('${t.replace(/'/g,"\\'")}', event)">✕</span>` : ''}
    </div>`;
  }).join('');
}

function rowsForTab(tabId){
  if(tabId==='ALL') return allRows;
  const p = parseTab(tabId);
  if(p.type==='SQUAD') return allRows.filter(r=>fieldsFor(r).squad === p.name);
  if(p.type==='POC') return allRows.filter(r=>fieldsFor(r).owner === p.name);
  if(p.type==='STATUS') return p.name==='all' ? allRows : allRows.filter(r=>statusKey(fieldsFor(r).status) === p.name);
  if(p.type==='URGENT'){
    if(p.name==='soon') return allRows.filter(r=>{ const lvl=urgencyLevel(fieldsFor(r).endDateRaw); return lvl==='red'||lvl==='orange'; });
    return allRows.filter(r=>urgencyLevel(fieldsFor(r).endDateRaw) === p.name);
  }
  if(p.type==='CONTRACT') return allRows.filter(r=>contractCategoryFor(fieldsFor(r)) === p.name);
  return allRows;
}

// Friendly display name for any tab type, used in headers/tab-strip labels
function tabDisplayName(p){
  if(p.type==='ALL') return 'All Properties';
  if(p.type==='STATUS') return p.name==='all' ? 'All Properties' : (KPI_LABELS[p.name] || p.name);
  if(p.type==='URGENT'){
    if(p.name==='red') return 'Expiring within 7 days';
    if(p.name==='orange') return 'Expiring within 30 days';
    if(p.name==='soon') return 'Expiring soon (≤30 days)';
    if(p.name==='expired') return 'Expired agreements';
  }
  if(p.type==='CONTRACT') return p.name==='completed' ? 'Agreement Completed' : 'Pending / Not Signed';
  return p.name;
}

// Shared category logic — used by both the Agreement Summary cards and the CONTRACT
// tab type they link to, so clicking a card always shows exactly what it counted.
function contractCategoryFor(f){
  const cs = (f.contractStatus||'').toString().toLowerCase();
  if(cs.includes('not signed') || cs.includes('pending')) return 'pending';
  if(cs.includes('signed')) return 'completed';
  return 'other';
}

/* ---------- LEADERBOARD DATA (used by Top 5 Squads strip) ---------- */
function computeLeaderboard(groupField){
  const groups = {};
  allRows.forEach(row=>{
    const f = fieldsFor(row);
    const key = f[groupField];
    if(!groups[key]) groups[key] = [];
    groups[key].push(row);
  });
  const topStatus = KPI_ORDER[0]; // treat the single most common status as "healthy" reference
  return Object.entries(groups).map(([name, rows])=>{
    const total = rows.length;
    let healthy=0, churnLike=0, renewal=0;
    rows.forEach(row=>{
      const f = fieldsFor(row);
      const sk = statusKey(f.status);
      if(sk===topStatus) healthy++;
      else churnLike++;
      const d = daysRemaining(f.endDateRaw);
      if(d !== null && d <= RENEWAL_WINDOW_DAYS) renewal++;
    });
    const churnRate = total ? Math.round((churnLike/total)*1000)/10 : 0;
    return { name, total, healthy, churnLike, churnRate, renewal };
  });
}
function topSquadStripsHtml(){
  const rows = computeLeaderboard('squad').sort((a,b)=>b.total-a.total).slice(0,5);
  const maxTotal = Math.max(...rows.map(r=>r.total), 1);
  const healthyLabel = KPI_LABELS[KPI_ORDER[0]] || 'Healthy';
  return `
    <div class="section-card">
      <div class="section-title">Top 5 Squads</div>
      <div class="section-desc">Ranked by total properties · ${escapeHtml(healthyLabel)} count and churn rate shown for context.</div>
      <div class="squad-strips">
        ${rows.map(r=>`
          <div class="squad-strip" onclick="openTab('${tabIdFor('SQUAD', r.name).replace(/'/g,"\\'")}')">
            <div class="squad-strip-top">
              <span class="squad-strip-name">${escapeHtml(r.name)}</span>
              <span class="squad-strip-total">${r.total}</span>
            </div>
            <div class="squad-strip-bar"><div class="squad-strip-fill" style="width:${(r.total/maxTotal)*100}%"></div></div>
            <div class="squad-strip-meta">
              <span>${escapeHtml(healthyLabel)}: ${r.healthy}</span>
              <span class="lb-badge ${r.churnRate<=15?'good':r.churnRate<=35?'warn':'bad'}">${r.churnRate}% churn</span>
            </div>
          </div>`).join('')}
      </div>
    </div>`;
}

/* ---------- COMPACT LEADERBOARDS ---------- */
function csvEscape(v){
  const s = (v===null||v===undefined) ? '' : String(v);
  return /[",\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s;
}
function downloadReportCsv(){
  const headers = ['Property','Squad','POC','Status','Live Date','Contract Status','Agreement End Date','Days Remaining','City'];
  const lines = [headers.join(',')];
  allRows.forEach(row=>{
    const f = fieldsFor(row);
    const d = daysRemaining(f.endDateRaw);
    lines.push([f.name,f.squad,f.owner,f.status,f.kickoff,f.contractStatus,f.endDateRaw||'',d===null?'':d,f.city].map(csvEscape).join(','));
  });
  const blob = new Blob([lines.join('\n')], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `vista-mis-report-${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ---------- LINK HANDLING ---------- */
// Treats any string starting with http(s):// as a link, wherever it appears —
// used both in the expanded detail table and the per-property full-detail view.
function isUrlValue(val){
  return typeof val === 'string' && /^https?:\/\//i.test(val.trim());
}
function linkifyCell(val){
  if(val === null || val === undefined || val === '') return '<span style="color:#bbb">—</span>';
  if(isUrlValue(val)) return `<a href="${escapeHtml(val.trim())}" target="_blank" rel="noopener noreferrer" class="cell-link">Open ↗</a>`;
  return escapeHtml(String(val));
}
// Looks across a raw Supabase row for the first useful document/reference link,
// used as a quick "Docs" shortcut in the expanded table (full list of every link
// still shows correctly on the per-property "View Full Details" page).
const DOC_LINK_CANDIDATES = ["Agreement Link","Villa details Link","Google Link","Projection Link","Handover checklist link","New agreement link","Link for the agreement"];
function primaryDocLink(row){
  for(const c of DOC_LINK_CANDIDATES){
    const v = getVal(row, [c]);
    if(isUrlValue(v)) return v;
  }
  // fall back to scanning every field for anything URL-shaped
  for(const k of Object.keys(row)){
    if(isUrlValue(row[k])) return row[k];
  }
  return null;
}

/* ---------- AGREEMENT SUMMARY (Completed / Pending / Expiring / Expired) ---------- */
function agreementSummaryHtml(rows, clickable){
  let completed=0, pending=0, expiringSoon=0, expired=0;
  rows.forEach(row=>{
    const f = fieldsFor(row);
    const cat = contractCategoryFor(f);
    const lvl = urgencyLevel(f.endDateRaw);
    if(cat==='pending') pending++;
    if(cat==='completed') completed++;
    if(lvl==='red' || lvl==='orange') expiringSoon++;
    if(lvl==='expired') expired++;
  });
  const cards = [
    {label:'Agreement Completed', value:completed, tone:'good', nav: tabIdFor('CONTRACT','completed')},
    {label:'Pending / Not Signed', value:pending, tone:'watch', nav: tabIdFor('CONTRACT','pending')},
    {label:'Expiring Soon (≤30d)', value:expiringSoon, tone:'warn', nav: tabIdFor('URGENT','soon')},
    {label:'Expired', value:expired, tone:'bad', nav: tabIdFor('URGENT','expired')},
  ];
  const toneColor = {good:'#3f7d5c', watch:'#8a6a1f', warn:'#c07a1f', bad:'#a13f30'};
  return `
    <div class="section-card">
      <div class="section-title">Agreement Summary</div>
      <div class="section-desc">${clickable ? 'Click a card to see the full list.' : 'For this view specifically.'}</div>
      <div class="kpi-row">
        ${cards.map(c=>`
          <div class="kpi-card" style="${clickable?'':'cursor:default;'}border-color:${toneColor[c.tone]}22;" ${clickable ? `onclick="openTab('${c.nav}')"` : ''}>
            <div class="kpi-number" style="color:${toneColor[c.tone]}">${c.value}</div>
            <div class="kpi-label">${escapeHtml(c.label)}</div>
          </div>`).join('')}
      </div>
    </div>`;
}

/* ---------- EXPANDED DETAIL PAGE (used for Status / Squad / POC / Urgency clicks) ---------- */
const DETAIL_PAGE_SIZE = 50;
function detailPageShellHtml(){
  return `
    <div class="section-card">
      <div class="section-title" id="detail-count-title">Properties</div>
      <div class="section-desc">Click any row to view its full record. Links open in a new tab.</div>
      <div class="search-row">
        <input id="search-box" placeholder="Search by property, squad, POC, or city…" />
      </div>
      <div id="detail-result-area"></div>
    </div>`;
}
function renderDetailResultArea(rows){
  const state = getTabState(activeTabId);
  const filtered = rows.filter(row=>{
    if(!state.search) return true;
    const f = fieldsFor(row);
    return f.name.toLowerCase().includes(state.search) || f.owner.toLowerCase().includes(state.search) || f.squad.toLowerCase().includes(state.search) || f.city.toLowerCase().includes(state.search);
  });
  window.__detailFilteredRows = filtered;

  const titleEl = document.getElementById('detail-count-title');
  if(titleEl) titleEl.textContent = `Properties (${filtered.length})`;

  const page = state.detailPage || 1;
  const totalPages = Math.max(1, Math.ceil(filtered.length / DETAIL_PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages);
  const pageRows = filtered.slice((clampedPage-1)*DETAIL_PAGE_SIZE, clampedPage*DETAIL_PAGE_SIZE);

  const tableRows = pageRows.map((row, i)=>{
    const f = fieldsFor(row);
    const st = styleFor(statusKey(f.status));
    const lvl = urgencyLevel(f.endDateRaw);
    const d = daysRemaining(f.endDateRaw);
    const doc = primaryDocLink(row);
    const globalIdx = (clampedPage-1)*DETAIL_PAGE_SIZE + i;
    return `
      <tr onclick="openDetailRowByIndex(${globalIdx})">
        <td>${escapeHtml(f.name)}</td>
        <td>${escapeHtml(f.squad)}</td>
        <td>${escapeHtml(f.owner)}</td>
        <td><span class="pill" style="background:${st.bg};color:${st.fg}">${escapeHtml(f.status)}</span></td>
        <td>${escapeHtml(f.kickoff)}</td>
        <td>${escapeHtml(f.contractStatus)}</td>
        <td>${f.endDateRaw ? escapeHtml(f.endDateRaw) + (lvl==='expired' ? ' (expired)' : lvl ? ` (${d}d)` : '') : '—'}</td>
        <td>${escapeHtml(f.city)}</td>
        <td onclick="event.stopPropagation()">${doc ? `<a href="${escapeHtml(doc)}" target="_blank" rel="noopener noreferrer" class="cell-link">Docs ↗</a>` : '—'}</td>
        <td onclick="event.stopPropagation()"><button class="view-details-btn" onclick="openDetailRowByIndexNewTab(${globalIdx})">View Full Details ↗</button></td>
      </tr>`;
  }).join('');

  const area = document.getElementById('detail-result-area');
  if(!area) return;
  area.innerHTML = `
    <div class="detail-table-wrap">
      <table class="detail-table">
        <thead>
          <tr>
            <th>Property</th><th>Squad</th><th>POC</th><th>Status</th><th>Live Date</th>
            <th>Contract Status</th><th>Agreement End</th><th>City</th><th>Docs</th><th></th>
          </tr>
        </thead>
        <tbody>${tableRows || `<tr><td colspan="10" style="text-align:center;color:#999;padding:30px;">No properties match this search.</td></tr>`}</tbody>
      </table>
    </div>
    ${filtered.length > DETAIL_PAGE_SIZE ? `
      <div class="pagination">
        <button ${clampedPage<=1?'disabled':''} onclick="goDetailPage(${clampedPage-1})">← Prev</button>
        <span>Page ${clampedPage} of ${totalPages}</span>
        <button ${clampedPage>=totalPages?'disabled':''} onclick="goDetailPage(${clampedPage+1})">Next →</button>
      </div>` : ''}
  `;
}
function goDetailPage(n){ getTabState(activeTabId).detailPage = n; renderDetailResultArea(rowsForTab(activeTabId)); }
// Clicking a row shows a quick preview in the same tab...
function openDetailRowByIndex(idx){
  const filtered = window.__detailFilteredRows || [];
  activeRow = filtered[idx];
  renderActiveTab();
}
// ...while the explicit "View Full Details" button opens it in a genuine new browser tab.
function openDetailRowByIndexNewTab(idx){
  const filtered = window.__detailFilteredRows || [];
  const row = filtered[idx];
  if(row) openPropertyInNewTab(row);
}

/* ---------- MAIN RENDER ---------- */
function renderActiveTab(){
  if(activeRow){ renderRowDetail(); return; }

  const p = parseTab(activeTabId);
  const rows = rowsForTab(activeTabId);
  const state = getTabState(activeTabId);
  const root = document.getElementById('view-root');

  const counts = {};
  rows.forEach(r=>{ const k = statusKey(fieldsFor(r).status); counts[k]=(counts[k]||0)+1; });

  let urgentRed=0, urgentOrange=0;
  rows.forEach(r=>{
    const lvl = urgencyLevel(fieldsFor(r).endDateRaw);
    if(lvl==='red') urgentRed++;
    else if(lvl==='orange') urgentOrange++;
  });

  const cityCounts = {};
  rows.forEach(r=>{
    const city = fieldsFor(r).city;
    if(city && city !== '—') cityCounts[city] = (cityCounts[city] || 0) + 1;
  });
  const leadingCity = Object.entries(cityCounts).sort((a,b)=>b[1]-a[1])[0];
  const timeOfDay = new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 18 ? 'Good afternoon' : 'Good evening';
  const heroHtml = p.type === 'ALL' ? `
    <section class="portfolio-hero">
      <div class="hero-copy">
        <span class="eyebrow">Portfolio command centre</span>
        <h1>${timeOfDay}.<br><em>Every stay</em> in view.</h1>
        <p>${rows.length} homes across ${squadList.length || 0} squads, with the signals that need your attention first.</p>
        <div class="hero-meta">
          <span><b>${leadingCity ? leadingCity[1] : 0}</b> homes in ${escapeHtml(leadingCity ? leadingCity[0] : 'your top city')}</span>
          <span><b>${urgentRed + urgentOrange}</b> renewals to watch</span>
        </div>
      </div>
      <div class="hero-art" aria-hidden="true">
        <div class="sun-orb"></div><div class="hill hill-one"></div><div class="hill hill-two"></div>
        <div class="hero-home"><i></i><i></i><i></i></div>
        <div class="hero-stamp">SV<br><small>EST. 2015</small></div>
      </div>
    </section>` : '';

  // KPI cards navigate to a full expanded detail page instead of filtering in place.
  const kpiHtml = `
    <div class="kpi-card kpi-total" onclick="openTab('${tabIdFor('STATUS','all')}')">
      <div class="kpi-number">${rows.length}</div><div class="kpi-label">Total</div>
    </div>
    ${KPI_ORDER.map(k=>{
      const sem = semanticStyleFor(k);
      return `
      <div class="kpi-card" style="background:linear-gradient(135deg, ${hexMix(sem.dot,0.82)}, ${hexMix(sem.dot,0.55)});border-color:${sem.dot};" onclick="openTab('${tabIdFor('STATUS',k)}')">
        <div class="kpi-number" style="color:${sem.fg}">${counts[k]||0}</div>
        <div class="kpi-label" style="color:${sem.fg}">${escapeHtml(KPI_LABELS[k])}</div>
      </div>`;
    }).join('')}
  `;

  const healthHtml = `<div class="health-strip"><span class="health-dot"></span> Auto-synced from Supabase${lastSyncedAt ? ` · last synced ${lastSyncedAt.toLocaleTimeString()}` : ''}.</div>`;

  // Alert banners also navigate to an expanded detail page, filtered to just the urgent set.
  let alertHtml = '';
  if(urgentRed > 0) alertHtml += `<div class="alert-banner red" onclick="openTab('${tabIdFor('URGENT','red')}')">⚠ ${urgentRed} agreement${urgentRed===1?'':'s'} expiring within 7 days</div>`;
  if(urgentOrange > 0) alertHtml += `<div class="alert-banner orange" onclick="openTab('${tabIdFor('URGENT','orange')}')">⚠ ${urgentOrange} agreement${urgentOrange===1?'':'s'} expiring within 30 days</div>`;

  // Quick-search only appears on the main "All Properties" page, right under the header —
  // typing shows a live dropdown of matches; clicking one opens its full record in a new tab.
  const quickSearchHtml = p.type === 'ALL' ? `
    <div class="quick-search">
      <input id="quick-search-box" placeholder="🔍 Quickly search any property, squad, or POC…" autocomplete="off" />
      <div id="quick-search-results" class="quick-search-results hidden"></div>
    </div>` : '';

  let bodyExtra = '';
  let detailSection = '';
  if(p.type === 'ALL'){
    // Main dashboard: agreement info front-and-center, plus which squads carry the most homes.
    // Everything else (per-status, per-squad, per-POC full lists) is one click away via the
    // KPI cards, alert banners, agreement summary cards, or the sidebar.
    bodyExtra = `
      ${agreementSummaryHtml(rows, true)}
      ${topSquadStripsHtml()}
    `;
  } else {
    detailSection = `
      ${agreementSummaryHtml(rows, false)}
      ${detailPageShellHtml()}
    `;
  }

  root.innerHTML = `
    ${heroHtml}
    <div class="view-header">
      <div><h2>${escapeHtml(tabDisplayName(p))}</h2><p class="desc">${p.type==='ALL' ? 'Portfolio-wide summary' : p.type==='SQUAD' ? 'Squad-level view' : p.type==='POC' ? 'POC-level view' : 'Filtered view'} · live from Supabase</p></div>
      ${p.type!=='ALL' ? `<button class="btn" onclick="downloadReportCsv()">↓ Export</button>` : ''}
    </div>
    ${quickSearchHtml}
    ${healthHtml}
    <div class="kpi-row">${kpiHtml}</div>
    ${alertHtml}
    ${bodyExtra}
    ${detailSection}
  `;

  if(p.type === 'ALL'){
    const qsBox = document.getElementById('quick-search-box');
    if(qsBox){
      qsBox.addEventListener('input', (e)=> renderQuickSearchResults(e.target.value));
      document.addEventListener('click', (e)=>{
        if(!e.target.closest('.quick-search')) document.getElementById('quick-search-results')?.classList.add('hidden');
      });
    }
  } else {
    const searchBox = document.getElementById('search-box');
    if(searchBox){
      searchBox.value = state.search;
      searchBox.addEventListener('input', (e)=>{
        state.search = e.target.value.toLowerCase();
        state.detailPage = 1;
        renderDetailResultArea(rows);
      });
    }
    renderDetailResultArea(rows);
  }
}

// Quick-search dropdown shown under the "All Properties" header — up to 8 live matches,
// clicking one opens that property's full record in a new browser tab.
function renderQuickSearchResults(term){
  const box = document.getElementById('quick-search-results');
  if(!box) return;
  const q = term.trim().toLowerCase();
  if(!q){ box.classList.add('hidden'); box.innerHTML=''; return; }
  const matches = allRows.filter(row=>{
    const f = fieldsFor(row);
    return f.name.toLowerCase().includes(q) || f.squad.toLowerCase().includes(q) || f.owner.toLowerCase().includes(q) || f.city.toLowerCase().includes(q);
  }).slice(0, 8);
  window.__quickSearchMatches = matches;
  if(matches.length === 0){
    box.innerHTML = `<div class="quick-search-empty">No matching properties.</div>`;
  } else {
    box.innerHTML = matches.map((row,i)=>{
      const f = fieldsFor(row);
      const st = styleFor(statusKey(f.status));
      return `<div class="quick-search-item" onclick="openQuickSearchMatch(${i})">
        <span class="qs-name">${escapeHtml(f.name)}</span>
        <span class="qs-meta">${escapeHtml(f.squad)} · ${escapeHtml(f.owner)}</span>
        <span class="pill" style="background:${st.bg};color:${st.fg}">${escapeHtml(f.status)}</span>
      </div>`;
    }).join('');
  }
  box.classList.remove('hidden');
}
function openQuickSearchMatch(i){
  const row = (window.__quickSearchMatches||[])[i];
  if(row) openPropertyInNewTab(row);
}

function renderRowDetail(){
  const root = document.getElementById('view-root');
  const f = fieldsFor(activeRow);
  const rowsHtml = Object.entries(activeRow).map(([key,val])=>`
    <div class="detail-row"><div class="label">${escapeHtml(key)}</div><div class="val">${linkifyCell(val)}</div></div>
  `).join('');
  root.innerHTML = `
    <div class="detail-toolbar">
      <button class="back-link" onclick="goBackHome()">← Back to All Properties</button>
      <button class="btn" onclick="openPropertyInNewTabCurrent()">Open in new tab ↗</button>
    </div>
    <div class="view-header"><div><h2>${escapeHtml(f.name)}</h2><p class="desc">Full record from Supabase</p></div></div>
    <div class="detail-list">${rowsHtml}</div>
  `;
}
function openPropertyInNewTabCurrent(){ if(activeRow) openPropertyInNewTab(activeRow); }

function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

// Expose functions used via inline onclick/onchange attributes to the global scope,
// since Vite builds this as an ES module (scoped by default, not global like a plain <script> tag).
window.handleLogin = handleLogin;
window.signOut = signOut;
window.toggleSection = toggleSection;
window.openTab = openTab;
window.closeTab = closeTab;
window.manualRefresh = manualRefresh;
window.downloadReportCsv = downloadReportCsv;
window.goDetailPage = goDetailPage;
window.openDetailRowByIndex = openDetailRowByIndex;
window.openDetailRowByIndexNewTab = openDetailRowByIndexNewTab;
window.goBackHome = goBackHome;
window.openPropertyInNewTabCurrent = openPropertyInNewTabCurrent;
window.openQuickSearchMatch = openQuickSearchMatch;
