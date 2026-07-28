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
let pieSelected = null;
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
    <div class="sidebar-item ${activeTabId==='SOP'?'active':''}" onclick="openTab('SOP')">
      <span>Playbook &amp; SOPs</span><span class="sidebar-count">4</span>
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
    const label = t==='ALL' ? '🏠 All Properties' : `${p.type==='SQUAD'?'📍':'🧑'} ${escapeHtml(p.name)}`;
    return `
    <div class="browser-tab ${activeTabId===t?'active':''}" onclick="openTab('${t.replace(/'/g,"\\'")}')">
      <span>${label}</span>
      ${t!=='ALL' ? `<span class="close-x" onclick="closeTab('${t.replace(/'/g,"\\'")}', event)">✕</span>` : ''}
    </div>`;
  }).join('');
}

function rowsForTab(tabId){
  if(tabId==='SOP') return [];
  if(tabId==='ALL') return allRows;
  const p = parseTab(tabId);
  if(p.type==='SQUAD') return allRows.filter(r=>fieldsFor(r).squad === p.name);
  if(p.type==='POC') return allRows.filter(r=>fieldsFor(r).owner === p.name);
  return allRows;
}

/* ---------- SQUAD DISTRIBUTION — BIG PIE CHART (chart only, no side list) ---------- */
function squadDistributionChartHtml(){
  const total = allRows.length || 1;
  const top = squadList.slice(0, 8);
  const restCount = squadList.slice(8).reduce((s,x)=>s+x.count,0);
  const segments = restCount > 0 ? [...top, {name:'Other', count:restCount}] : top;
  const colors = segments.map((seg,i)=> (restCount>0 && i===segments.length-1) ? '#c9c9c9' : STATUS_PALETTE[i % STATUS_PALETTE.length].dot);

  const size = 300, cx = size/2, cy = size/2, r = 130;
  let angle = 0;
  const wedges = segments.map((s,i)=>{
    const pct = Math.round((s.count/total)*1000)/10;
    const sweep = (s.count/total)*360;
    const startAngle = angle, endAngle = angle + sweep;
    angle = endAngle;
    const p1 = polarPoint(cx,cy,r,startAngle), p2 = polarPoint(cx,cy,r,endAngle);
    const largeArc = sweep > 180 ? 1 : 0;
    const path = `M ${cx} ${cy} L ${p1.x.toFixed(2)} ${p1.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${p2.x.toFixed(2)} ${p2.y.toFixed(2)} Z`;
    const mid = polarPoint(cx, cy, r*0.66, startAngle + sweep/2);
    const nameArg = s.name.replace(/'/g,"\\'");
    const selected = pieSelected && pieSelected.name === s.name;
    const shortName = s.name.length > 13 ? s.name.slice(0,12)+'…' : s.name;
    let label = '';
    if(sweep >= 22){
      label = `<text x="${mid.x.toFixed(2)}" y="${(mid.y-6).toFixed(2)}" class="pie-name-label" text-anchor="middle">${escapeHtml(shortName)}</text><text x="${mid.x.toFixed(2)}" y="${(mid.y+10).toFixed(2)}" class="pie-pct-label" text-anchor="middle">${pct}%</text>`;
    } else if(sweep >= 10){
      label = `<text x="${mid.x.toFixed(2)}" y="${mid.y.toFixed(2)}" class="pie-pct-label" text-anchor="middle">${pct}%</text>`;
    }
    return `<path d="${path}" fill="${colors[i]}" class="pie-wedge${selected?' selected':''}" onclick="selectPieSlice('${nameArg}', ${s.count}, ${pct})"><title>${escapeHtml(s.name)}: ${s.count} (${pct}%)</title></path>${label}`;
  }).join('');

  const infoPop = pieSelected ? `
    <div class="pie-info-pop">
      <div>
        <div class="pie-info-name">${escapeHtml(pieSelected.name)}</div>
        <div class="pie-info-stats"><span>${pieSelected.count} properties</span><span>·</span><span>${pieSelected.pct}% of portfolio</span></div>
      </div>
      <button class="pie-info-close" onclick="closePieInfo()">✕</button>
    </div>` : '';

  return `
    <div class="section-card">
      <div class="section-title">Squad Distribution</div>
      <div class="section-desc">Share of all ${total} properties by squad — click a slice for details.</div>
      <div class="dist-chart-row-solo">
        <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${wedges}</svg>
      </div>
      ${infoPop}
    </div>`;
}
function polarPoint(cx, cy, r, angleDeg){
  const rad = (angleDeg - 90) * Math.PI / 180;
  return { x: cx + r*Math.cos(rad), y: cy + r*Math.sin(rad) };
}
function selectPieSlice(name, count, pct){
  pieSelected = (pieSelected && pieSelected.name === name) ? null : { name, count, pct };
  renderActiveTab();
}
function closePieInfo(){ pieSelected = null; renderActiveTab(); }

/* ---------- TOP 5 SQUAD STRIPS ---------- */
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
function leaderboardData(field){
  const grouped = {};
  allRows.forEach(row=>{ const key = fieldsFor(row)[field]; (grouped[key] = grouped[key] || []).push(row); });
  return Object.entries(grouped).map(([name, rows])=>{
    const health = Math.round(rows.reduce((sum,row)=>sum + healthFor(row).score,0) / rows.length);
    const risk = rows.filter(row=>healthFor(row).score < 40).length;
    return {name, health, risk, total:rows.length};
  }).sort((a,b)=>b.health-a.health || b.total-a.total).slice(0,3);
}
function compactLeaderboardHtml(){
  const block = (title, subtitle, field) => `<div class="leaderboard-panel"><div><div class="section-title">${title}</div><div class="section-desc">${subtitle}</div></div><div class="leaderboard-tiles">${leaderboardData(field).map((item,index)=>`<div class="leaderboard-tile"><span class="rank-no">0${index+1}</span><div class="mini-score ${item.health>=80?'good':item.health>=60?'steady':'watch'}"><b>${item.health}</b><small>health</small></div><strong title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong><span>${item.total} homes · ${item.risk} at risk</span></div>`).join('')}</div></div>`;
  return `<section class="leaderboard-duo">${block('Squad pulse','Top health performers at a glance.','squad')}${block('KAM pulse','The clearest compact view of ownership.','owner')}</section>`;
}

/* ---------- NEEDS ATTENTION — 2 categories, squad rollup with dropdown ---------- */
let attnActiveTab = 'exp';
function setAttnTab(t){ attnActiveTab = t; renderActiveTab(); }

function urgencyRing(daysVal, isAwaiting){
  const r = 12, stroke = 4, circ = 2*Math.PI*r;
  let pct, color, label;
  if(isAwaiting){
    pct = Math.min((daysVal||0)/30, 1);
    color = daysVal>=30 ? '#a13f30' : daysVal>=21 ? '#b58a1f' : '#c9a227';
    label = daysVal;
  } else if(daysVal < 0){
    pct = 1; color = '#6b1f14'; label = '!';
  } else {
    pct = 1 - Math.min(daysVal/30, 1);
    color = daysVal<=7 ? '#a13f30' : '#b58a1f';
    label = daysVal;
  }
  const dash = pct*circ;
  return `<svg width="30" height="30" viewBox="0 0 30 30" class="urgency-ring" title="${isAwaiting?daysVal+'d waiting':(daysVal<0?'Expired':daysVal+'d left')}">
    <circle cx="15" cy="15" r="${r}" fill="none" stroke="#eee" stroke-width="${stroke}"/>
    <circle cx="15" cy="15" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-dasharray="${dash.toFixed(2)} ${(circ-dash).toFixed(2)}" stroke-dashoffset="${(circ/4).toFixed(2)}" transform="rotate(-90 15 15)"/>
    <text x="15" y="19" text-anchor="middle" font-size="9" font-weight="700" fill="${color}">${label}</text>
  </svg>`;
}

function needsAttentionCompactHtml(){
  const enriched = allRows.map(row=>{
    const f = fieldsFor(row);
    const lvl = urgencyLevel(f.endDateRaw);
    const d = daysRemaining(f.endDateRaw);
    const awaiting = isAwaitingResponse(f);
    const waitingDays = awaiting ? daysSince(f.sentToOwnerRaw) : null;
    return { row, f, lvl, d, awaiting, waitingDays };
  });
  const expiryGroup = enriched.filter(x=>x.lvl);
  const responseGroup = enriched.filter(x=>x.awaiting);

  function bySquad(list){
    const map = {};
    list.forEach(x=>{ (map[x.f.squad] = map[x.f.squad] || []).push(x); });
    return Object.entries(map).sort((a,b)=>b[1].length-a[1].length);
  }
  const expiryBySquad = bySquad(expiryGroup);
  const responseBySquad = bySquad(responseGroup);

  const isAwaitingTab = attnActiveTab === 'resp';
  const entries = isAwaitingTab ? responseBySquad : expiryBySquad;
  const emptyMsg = isAwaitingTab
    ? (SENT_DATE_KEY ? 'No properties waiting on a response right now.' : 'This category needs a "sent to owner date" column in Supabase to work.')
    : 'Nothing urgent right now.';

  const maxCount = Math.max(...entries.map(([,l])=>l.length), 1);
  const miniChart = entries.length ? `
    <div class="attn-mini-chart">
      ${entries.slice(0,8).map(([sq,list])=>`
        <div class="attn-mini-bar-row">
          <span class="attn-mini-label">${escapeHtml(sq)}</span>
          <div class="attn-mini-track"><div class="attn-mini-fill" style="width:${(list.length/maxCount)*100}%;background:${isAwaitingTab?'#b58a1f':'#a13f30'}"></div></div>
          <span class="attn-mini-value">${list.length}</span>
        </div>`).join('')}
    </div>` : '';

  const squadListHtml = entries.length===0 ? `<div class="empty-note">${emptyMsg}</div>` : `
    <div class="attn-squad-list">
      ${entries.map(([sq, list], i)=>`
        <div class="attn-squad-row">
          <div class="attn-squad-head" onclick="toggleAttnSquad('${attnActiveTab}-${i}')">
            <span class="attn-caret" id="attn-caret-${attnActiveTab}-${i}">▸</span>
            <span class="attn-squad-name">${escapeHtml(sq)}</span>
            <span class="attn-squad-count">${list.length}</span>
          </div>
          <div class="attn-squad-body hidden" id="attn-body-${attnActiveTab}-${i}">
            ${list.map(x=>`
              <div class="attn-prop-row" onclick='openDetailFromRow(${JSON.stringify(JSON.stringify(x.row))})'>
                ${urgencyRing(isAwaitingTab ? x.waitingDays : x.d, isAwaitingTab)}
                <span class="attn-prop-name">${escapeHtml(x.f.name)}</span>
              </div>`).join('')}
          </div>
        </div>`).join('')}
    </div>`;

  return `
    <div class="section-card">
      <div class="section-title">Needs Attention</div>
      <div class="section-desc">Click a squad to see property names.</div>
      <div class="attn-tabs">
        <div class="attn-tab ${attnActiveTab==='exp'?'active':''}" onclick="setAttnTab('exp')">Expired / Needs Renewal <span class="attn-tab-count">${expiryGroup.length}</span></div>
        <div class="attn-tab ${attnActiveTab==='resp'?'active':''}" onclick="setAttnTab('resp')">Awaiting Owner Response <span class="attn-tab-count">${responseGroup.length}</span></div>
      </div>
      ${miniChart}
      ${squadListHtml}
    </div>`;
}
function toggleAttnSquad(key){
  const body = document.getElementById('attn-body-'+key);
  const caret = document.getElementById('attn-caret-'+key);
  if(!body) return;
  body.classList.toggle('hidden');
  caret.textContent = body.classList.contains('hidden') ? '▸' : '▾';
}
function openDetailFromRow(rowJsonStr){ activeRow = JSON.parse(rowJsonStr); renderActiveTab(); }

/* ---------- PORTFOLIO OPERATIONS ---------- */
function healthFor(row){
  const f = fieldsFor(row); let score = 100; const status = f.status.toLowerCase();
  if(status.includes('delist')) score -= 38; else if(status.includes('never')) score -= 32; else if(status.includes('pause')) score -= 24; else if(status.includes('hand')) score -= 12;
  const urgency = urgencyLevel(f.endDateRaw);
  if(urgency==='expired') score -= 34; else if(urgency==='red') score -= 24; else if(urgency==='orange') score -= 12;
  else { const days = daysRemaining(f.endDateRaw); if(days !== null && days <= RENEWAL_WINDOW_DAYS) score -= 5; }
  if(isAwaitingResponse(f)) score -= 10;
  score = Math.max(0, Math.min(100, score));
  const label = score >= 80 ? 'Thriving' : score >= 60 ? 'Stable' : score >= 40 ? 'Watchlist' : 'At risk';
  const tone = score >= 80 ? 'good' : score >= 60 ? 'steady' : score >= 40 ? 'watch' : 'risk';
  return {score,label,tone};
}
function healthSummaryHtml(rows, scopeName){
  const values = rows.map(healthFor), average = values.length ? Math.round(values.reduce((sum, item)=>sum + item.score, 0) / values.length) : 0;
  const atRisk = values.filter(item=>item.score < 40).length, thriving = values.filter(item=>item.score >= 80).length;
  const tone = average >= 80 ? 'good' : average >= 60 ? 'steady' : average >= 40 ? 'watch' : 'risk';
  return `<section class="scope-summary"><div class="scope-score ${tone}"><span class="scope-score-label">${escapeHtml(scopeName)} health</span><strong>${average}</strong><span>/ 100</span></div><div class="scope-insight"><b>${thriving}</b><span>homes are thriving</span></div><div class="scope-insight"><b>${atRisk}</b><span>homes need intervention</span></div><div class="scope-insight scope-tip"><span>Focus first on expired agreements and owner responses older than ${NO_RESPONSE_THRESHOLD_DAYS} days.</span></div></section>`;
}
function renewalTimelineHtml(rows){
  const dated = rows.map(row=>({row, f:fieldsFor(row), days:daysRemaining(fieldsFor(row).endDateRaw)})).filter(item=>item.days !== null && item.days <= 120);
  const upcoming = [...dated.filter(item=>item.days >= 0).sort((a,b)=>a.days-b.days).slice(0,5), ...dated.filter(item=>item.days < 0).sort((a,b)=>b.days-a.days).slice(0,3)];
  if(!upcoming.length) return `<div class="section-card"><div class="section-title">Renewal runway</div><div class="empty-note">No agreement end dates are available for the next 120 days.</div></div>`;
  return `<section class="section-card renewal-card"><div class="section-title">Renewal runway</div><div class="section-desc">A visual view of the next 120 days. Start with the homes closest to their renewal date.</div><div class="renewal-axis"><span>Overdue</span><span>30 days</span><span>60 days</span><span>90 days</span><span>120 days</span></div><div class="renewal-list">${upcoming.map(item=>{ const health = healthFor(item.row), position = Math.max(0, Math.min(100, (Math.max(item.days,0)/120)*100)), marker = item.days < 0 ? 'overdue' : item.days <= 30 ? 'soon' : item.days <= 60 ? 'watch' : 'planned', title = item.days < 0 ? `${Math.abs(item.days)}d overdue` : `${item.days}d to renewal`; return `<button class="renewal-row" onclick='openDetailFromRow(${JSON.stringify(JSON.stringify(item.row))})'><span class="renewal-name">${escapeHtml(item.f.name)}</span><span class="renewal-track"><i class="renewal-marker ${marker}" style="left:${position}%"></i></span><span class="renewal-days ${marker}">${title}</span><span class="health-mini ${health.tone}">${health.score}</span></button>`; }).join('')}</div></section>`;
}
function followUpWorkflowHtml(rows){
  const dated = rows.map(row=>({row, f:fieldsFor(row), days:daysRemaining(fieldsFor(row).endDateRaw)})).filter(item=>item.days !== null && item.days <= 30);
  const candidates = [...dated.filter(item=>item.days >= 0).sort((a,b)=>a.days-b.days).slice(0,3), ...dated.filter(item=>item.days < 0).sort((a,b)=>b.days-a.days).slice(0,2)];
  if(!candidates.length) return '';
  return `<section class="section-card followup-card"><div class="section-title">Owner follow-up queue</div><div class="section-desc">A focused working list for this session. Mark items done once the owner has been contacted.</div><div class="followup-list">${candidates.map(item=>{ const key = `${activeTabId}-${item.f.name}-${item.f.endDateRaw}`, done = followUpDone.has(key), due = item.days < 0 ? `Overdue by ${Math.abs(item.days)}d` : `Due in ${item.days}d`; return `<div class="followup-item ${done?'done':''}"><button class="followup-check" onclick="toggleFollowUp(${JSON.stringify(key)})" aria-label="Mark follow-up complete">${done?'✓':''}</button><div class="followup-copy"><b>${escapeHtml(item.f.name)}</b><span>${escapeHtml(item.f.owner)} · ${due}</span></div><button class="nudge-btn" onclick='prepareNudge(${JSON.stringify(JSON.stringify(item.row))})'>Prepare nudge</button></div>`; }).join('')}</div><div id="nudge-note" class="nudge-note" aria-live="polite"></div></section>`;
}
function portfolioAskHtml(){ return `<section class="ask-card"><div><span class="eyebrow">Portfolio intelligence</span><h3>Ask the portfolio</h3><p>Try “expiring in 30 days”, “at risk in Goa”, or “live homes with KAM Rahul”.</p></div><div class="ask-form"><input id="ask-portfolio-input" placeholder="Ask a portfolio question..." onkeydown="if(event.key==='Enter') askPortfolio()"><button onclick="askPortfolio()">Ask</button></div><div id="ask-portfolio-answer" class="ask-answer"></div></section>`; }
function askPortfolio(){
  const input = document.getElementById('ask-portfolio-input'), answer = document.getElementById('ask-portfolio-answer'); if(!input || !answer) return;
  const query = input.value.trim().toLowerCase(); if(!query){ answer.textContent = 'Ask about renewals, health, status, a city, squad, or KAM.'; return; }
  let matches = allRows.slice();
  if(/expir|renew|overdue/.test(query)) matches = matches.filter(row=>{ const d=daysRemaining(fieldsFor(row).endDateRaw); return d !== null && (query.includes('overdue') ? d < 0 : d <= (query.includes('30') ? 30 : query.includes('60') ? 60 : 120)); });
  if(/risk|health/.test(query)) matches = matches.filter(row=>healthFor(row).score < 60);
  if(/live/.test(query)) matches = matches.filter(row=>fieldsFor(row).status.toLowerCase().includes('live'));
  const token = [...squadList.map(x=>x.name),...pocList.map(x=>x.name),...allRows.map(r=>fieldsFor(r).city)].find(name=>name && query.includes(name.toLowerCase()));
  if(token) matches = matches.filter(row=>{const f=fieldsFor(row); return f.squad===token || f.owner===token || f.city===token;});
  const preview = matches.slice(0,3).map(row=>escapeHtml(fieldsFor(row).name)).join(', '); answer.innerHTML = `<b>${matches.length} home${matches.length===1?'':'s'} found.</b>${preview ? ` Start with ${preview}.` : ' Try a city, squad, KAM, status, or renewal window.'}`;
}
function toggleFollowUp(key){ followUpDone.has(key) ? followUpDone.delete(key) : followUpDone.add(key); renderActiveTab(); }
function prepareNudge(rowJson){ const f = fieldsFor(JSON.parse(rowJson)), note = document.getElementById('nudge-note'); if(note) note.textContent = `Draft ready: Hi ${f.owner}, could you share an update on ${f.name} and its agreement renewal?`; }
function sopHtml(){ return `<div class="view-header"><div><h2>Playbook & SOPs</h2><p class="desc">A shared rhythm for renewals, owner follow-ups, and portfolio health.</p></div></div><section class="sop-hero"><span class="eyebrow">Operations playbook</span><h1>Consistent actions.<br><em>Better stays.</em></h1><p>Use these lightweight SOPs to turn every dashboard signal into a clear next step.</p></section><div class="sop-grid"><article class="sop-card"><span>01</span><h3>Renewal runway</h3><p>Review the 120-day timeline weekly. Start outreach at 90 days; escalate at 30 days; flag overdue agreements immediately.</p></article><article class="sop-card"><span>02</span><h3>Owner follow-up</h3><p>Log an owner contact attempt, prepare a nudge, and mark it complete only when the next action and due date are clear.</p></article><article class="sop-card"><span>03</span><h3>Health review</h3><p>Investigate homes below 60. Prioritise expired agreements, paused homes, and unanswered owner communications.</p></article><article class="sop-card"><span>04</span><h3>Squad & KAM review</h3><p>Open each team tab in the weekly review. Agree one owner, one next step, and one due date for every at-risk home.</p></article></div>`; }

/* ---------- MIS DOWNLOAD (button lives next to Refresh, no separate tab) ---------- */
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

/* ---------- MAIN RENDER ---------- */
function renderActiveTab(){
  if(activeRow){ renderRowDetail(); return; }

  const p = parseTab(activeTabId);
  if(p.type === 'SOP'){
    document.getElementById('view-root').innerHTML = sopHtml();
    return;
  }
  const rows = rowsForTab(activeTabId);
  const state = getTabState(activeTabId);
  const root = document.getElementById('view-root');

  // Top-level cards reflect plain property counts (not adjusted for agreement expiry).
  const counts = {};
  rows.forEach(r=>{ const k = statusKey(fieldsFor(r).status); counts[k]=(counts[k]||0)+1; });

  // Alerts are only about agreements genuinely expiring soon — red (7d) / orange (30d).
  // Already-expired agreements are not alerted here; they live in Needs Attention below.
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

  const kpiHtml = `
    <div class="kpi-card kpi-total ${state.statusFilter==='all'?'active':''}" onclick="setStatusFilter('all')">
      <div class="kpi-number">${rows.length}</div><div class="kpi-label">Total</div>
    </div>
    ${KPI_ORDER.map(k=>{
      const sem = semanticStyleFor(k);
      return `
      <div class="kpi-card ${state.statusFilter===k?'active':''}" style="background:linear-gradient(135deg, ${hexMix(sem.dot,0.82)}, ${hexMix(sem.dot,0.55)});border-color:${sem.dot};" onclick="setStatusFilter('${k}')">
        <div class="kpi-number" style="color:${sem.fg}">${counts[k]||0}</div>
        <div class="kpi-label" style="color:${sem.fg}">${escapeHtml(KPI_LABELS[k])}</div>
      </div>`;
    }).join('')}
  `;

  const healthHtml = `<div class="health-strip"><span class="health-dot"></span> Auto-synced from Supabase${lastSyncedAt ? ` · last synced ${lastSyncedAt.toLocaleTimeString()}` : ''}.</div>`;

  let alertHtml = '';
  if(urgentRed > 0) alertHtml += `<div class="alert-banner red" onclick="setUrgentFilter('red')">⚠ ${urgentRed} agreement${urgentRed===1?'':'s'} expiring within 7 days ${state.urgentOnly==='red' ? '<span class="clear-btn" onclick="clearUrgentFilter(event)">clear filter</span>' : ''}</div>`;
  if(urgentOrange > 0) alertHtml += `<div class="alert-banner orange" onclick="setUrgentFilter('orange')">⚠ ${urgentOrange} agreement${urgentOrange===1?'':'s'} expiring within 30 days ${state.urgentOnly==='orange' ? '<span class="clear-btn" onclick="clearUrgentFilter(event)">clear filter</span>' : ''}</div>`;

  let bodyExtra = '';
  let propertiesSection = '';
  const scopeSummary = p.type === 'SQUAD' ? healthSummaryHtml(rows, `${p.name} squad`) : p.type === 'POC' ? healthSummaryHtml(rows, `${p.name}'s portfolio`) : '';
  if(p.type === 'ALL'){
    // Main dashboard combines portfolio signals with action-oriented work queues.
    bodyExtra = `
      ${portfolioAskHtml()}
      ${healthSummaryHtml(rows, 'Portfolio')}
      ${compactLeaderboardHtml()}
      ${renewalTimelineHtml(rows)}
      ${followUpWorkflowHtml(rows)}
      ${squadDistributionChartHtml()}
      ${topSquadStripsHtml()}
      ${needsAttentionCompactHtml()}
    `;
  } else {
    propertiesSection = `
      ${renewalTimelineHtml(rows)}
      ${followUpWorkflowHtml(rows)}
      <div class="section-card">
        <div class="section-title">Properties</div>
        <div class="section-desc">Search within ${escapeHtml(p.name)}.</div>
        <div class="search-row"><input id="search-box" placeholder="Search by property, city, or POC…" /></div>
        <div id="result-area"></div>
      </div>`;
  }

  root.innerHTML = `
    ${heroHtml}
    <div class="view-header">
      <div><h2>${p.name}</h2><p class="desc">${p.type==='ALL' ? 'Portfolio-wide summary' : p.type==='SQUAD' ? 'Squad-level view' : 'POC-level view'} · live from Supabase</p></div>
      ${p.type!=='ALL' ? '<div class="btn" style="cursor:default;">↓ Export</div>' : ''}
    </div>
    ${healthHtml}
    ${scopeSummary}
    <div class="kpi-row">${kpiHtml}</div>
    ${alertHtml}
    ${bodyExtra}
    ${propertiesSection}
  `;

  if(p.type !== 'ALL' && p.type !== 'SOP'){
    const searchBox = document.getElementById('search-box');
    searchBox.value = state.search;
    searchBox.addEventListener('input', (e)=>{ state.search = e.target.value.toLowerCase(); renderResultArea(); });
    renderResultArea();
  }
}

function setStatusFilter(key){ getTabState(activeTabId).statusFilter = key; renderActiveTab(); }
function setUrgentFilter(level){
  const state = getTabState(activeTabId);
  state.urgentOnly = state.urgentOnly === level ? null : level;
  renderActiveTab();
}
function clearUrgentFilter(evt){ evt.stopPropagation(); getTabState(activeTabId).urgentOnly = null; renderActiveTab(); }

function applyFilters(rows){
  const state = getTabState(activeTabId);
  return rows.filter(row=>{
    const f = fieldsFor(row);
    const matchesSearch = !state.search || f.name.toLowerCase().includes(state.search) || f.owner.toLowerCase().includes(state.search) || f.city.toLowerCase().includes(state.search);
    const matchesStatus = state.statusFilter === 'all' || statusKey(f.status) === state.statusFilter;
    const matchesUrgent = !state.urgentOnly || urgencyLevel(f.endDateRaw) === state.urgentOnly;
    return matchesSearch && matchesStatus && matchesUrgent;
  });
}

function renderResultArea(){
  const area = document.getElementById('result-area');
  const rows = rowsForTab(activeTabId);
  const filtered = applyFilters(rows);
  window.__filteredRows = filtered;
  if(filtered.length === 0){
    area.innerHTML = `<div class="empty-note">No properties match this search/filter.</div>`;
    return;
  }
  area.innerHTML = `
    <div class="result-count">${filtered.length} result${filtered.length===1?'':'s'}</div>
    <div class="grid">${filtered.map((row,i)=>cardHtml(row,i)).join('')}</div>
  `;
}

function cardHtml(row, idx){
  const f = fieldsFor(row);
  const st = styleFor(statusKey(f.status));
  const health = healthFor(row);
  const lvl = urgencyLevel(f.endDateRaw);
  const d = daysRemaining(f.endDateRaw);
  const badgeHtml = lvl ? `<div class="urgency-badge ${lvl}">${d<0 ? 'Expired' : d+' days left'}</div>` : '';
  return `
    <div class="card ${lvl?'urgent-'+lvl:''}">
      ${badgeHtml}
      <div class="card-top">
        <h3>${escapeHtml(f.name)}</h3>
        <div class="card-status"><span class="health-badge ${health.tone}">${health.score}<small>${health.label}</small></span><span class="pill" style="background:${st.bg};color:${st.fg}">${escapeHtml(f.status)}</span></div>
      </div>
      <div class="highlight-block">
        <div class="highlight-row"><span class="k">POC</span><span class="v">${escapeHtml(f.owner)}</span></div>
        <div class="highlight-row"><span class="k">Live Date</span><span class="v">${escapeHtml(f.kickoff)}</span></div>
        <div class="highlight-row"><span class="k">Contract Status</span><span class="v">${escapeHtml(f.contractStatus)}</span></div>
      </div>
      <button class="view-btn" onclick="openRowDirect(${idx})">View full details →</button>
    </div>`;
}

function openRowDirect(idx){
  const filtered = window.__filteredRows || [];
  activeRow = filtered[idx];
  renderActiveTab();
}

function renderRowDetail(){
  const root = document.getElementById('view-root');
  const f = fieldsFor(activeRow);
  const rowsHtml = Object.entries(activeRow).map(([key,val])=>`
    <div class="detail-row"><div class="label">${escapeHtml(key)}</div><div class="val">${val===null||val===undefined||val===''?'<span style="color:#bbb">—</span>':escapeHtml(String(val))}</div></div>
  `).join('');
  root.innerHTML = `
    <button class="back-link" onclick="activeRow=null; renderActiveTab();">← Back</button>
    <div class="view-header"><div><h2>${escapeHtml(f.name)}</h2><p class="desc">Full record from Supabase</p></div></div>
    <div class="detail-list">${rowsHtml}</div>
  `;
}

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
window.setStatusFilter = setStatusFilter;
window.setUrgentFilter = setUrgentFilter;
window.clearUrgentFilter = clearUrgentFilter;
window.openRowDirect = openRowDirect;
window.openDetailFromRow = openDetailFromRow;
window.toggleAttnSquad = toggleAttnSquad;
window.setAttnTab = setAttnTab;
window.selectPieSlice = selectPieSlice;
window.closePieInfo = closePieInfo;
window.manualRefresh = manualRefresh;
window.downloadReportCsv = downloadReportCsv;
window.toggleFollowUp = toggleFollowUp;
window.prepareNudge = prepareNudge;
window.askPortfolio = askPortfolio;
