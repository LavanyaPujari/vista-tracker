# Vista Tracker — Web App

A Vite project: `index.html` (structure), `src/style.css` (styling),
`src/main.js` (all logic), `.env` (configuration). Vite is what makes `.env`
work — a plain `.html` file has no build step to inject those values.

## What's in the dashboard

Left-hand nav — every tab obeys the same filters, the same summary logic and the
same responsive rules:

| Tab | What it shows |
| --- | --- |
| Overview | KPI cards + the agreement status split, with a Snapshot / Status detail sub-tab |
| KAM-wise Summary | The MIS pivot keyed on *Owner Facing Account Manager* |
| Squad-wise Summary | The same pivot keyed on *New Squad Mapping* |
| Properties | Every underlying row, sub-tabbed by status |
| Live Properties | **Opens in a new browser tab** (`target="_blank"`) |

Both summary tables carry the seven MIS columns — Email Confirmation, Expired,
Founder/Partner Approved, Not Signed, To Expire, Valid, Grand Total — plus
**Agreement Valid %** (Valid ÷ Grand Total) on the same red→yellow→green scale
as the sheet. Any status the sheet uses that doesn't map to those six appears in
an extra *Unmapped* column, which stays hidden when it's empty, so the totals
always reconcile against the MIS.

Filters (Squad, KAM, Status, plus free-text search) are multi-select dropdowns
with search and select-all. What you've picked is visible in three places: on the
dropdown button, as removable chips underneath, and in the row count beside them.
Selections survive tab switches and are written into the URL, so a filtered view
can be pasted to someone else.

Responsiveness: below 980px the sidebar becomes a drawer behind the ☰ button;
wide tables scroll sideways with the first column frozen; below 540px the
row-level tables restack as cards.

### Optional setting
`VITE_LIVE_PROPERTIES_URL` — point the Live Properties nav item at an external
URL. Leave it blank and it opens the app's own Live Properties page in a new tab.

## Folder structure
```
vista-tracker-app/
├── index.html          <- page structure
├── src/
│   ├── style.css        <- all styling, including every responsive breakpoint
│   └── main.js           <- data loading, filters, summaries, routing
├── .env                  <- your Supabase URL/key (already filled in)
├── .env.example           <- template reference
├── package.json
├── vite.config.js
└── .gitignore
```

## Running it locally
```
npm install
npm run dev
```
Opens at `http://localhost:5173` with live-reload.

---

## What the app does

### Left-hand tabs
| Tab | What it shows |
|---|---|
| **Overview** | Property summary (total / live / not live) + agreement summary + status split. Sub-tabs: Snapshot, Status detail |
| **KAM-wise Summary** | The MIS pivot by Owner Facing Account Manager. Sub-tabs: Counts, Valid % ranking |
| **Squad-wise Summary** | The MIS pivot by New Squad Mapping. Same sub-tabs |
| **Properties** | Every underlying row. Sub-tabs: All / Not signed / Expired / To expire / Valid |
| **Live Properties** | Opens in another tab of the same browser window, carrying the current filters |
| **Connection check** | Under Setup — what was fetched, how each column mapped, why each status was assigned |

### Agreement Summary columns
Both summaries reproduce the MIS pivot, in MIS order:

`Email Confirmation · Expired · Founder/Partner Approved · Not Signed ·
To Expire · Valid · Grand Total · Agreement Valid %`

`Agreement Valid %` = Valid ÷ Grand Total, with the same red→yellow→green
colour scale Excel applies in the source MIS. Column headings are sortable.

Raw status text is normalised before counting, so sheet spellings like
`Not signed`, `not_signed`, `Founder / Partner approved` or `valid` all land in
the right bucket. Anything genuinely unrecognised appears in an extra
**Unmapped** column — if that column shows up, a new status value has been
added to the Acq Master and `normalizeStatus()` in `src/main.js` needs one more
line.

### Filters
Squad, KAM and Status are multi-select dropdowns with a search box, Select all
and Clear. Selections stay visible in three places at once: the trigger button
(`Goa, Pune` or `Goa +3 more`) with a count badge, a row of removable chips
under the filter bar, and the `n of N properties` readout. Filters are global —
they apply to every tab, and they travel in the URL, so a filtered view can be
bookmarked or shared and the Live Properties tab inherits them.

### Responsiveness
One shared shell, so all tabs behave identically:
- **≥981px** — fixed sidebar, full pivot tables
- **≤980px** — sidebar becomes a slide-in drawer behind the ☰ button
- **≤760px** — filters stack full-width, tables scroll sideways with a frozen
  first column and sticky header
- **≤540px** — property and status lists restack as cards; pivot tables keep
  horizontal scroll, which is the readable option for 9 columns
- Keyboard focus is visible throughout, `prefers-reduced-motion` is respected,
  and the summaries print cleanly

---

## Where the data comes from

Everything on every tab comes from one Supabase REST call:

```
GET  {VITE_SUPABASE_URL}/rest/v1/{VITE_SUPABASE_TABLE}?select=*
     apikey:        {VITE_SUPABASE_ANON_KEY}
     Authorization: Bearer {VITE_SUPABASE_ANON_KEY}
     Range:         0-999, then 1000-1999, ...
```

With your current `.env` that resolves to:

```
https://benzjvkbevombzjwwtqr.supabase.co/rest/v1/agreement%20track?select=*
```

To test it outside the app, paste this into a terminal — if it prints rows, the
app will show them:

```bash
curl -s "https://benzjvkbevombzjwwtqr.supabase.co/rest/v1/agreement%20track?select=*&limit=2" \
  -H "apikey: YOUR_ANON_KEY" -H "Authorization: Bearer YOUR_ANON_KEY"
```

There is no other data source. Nothing is cached, bundled or hard-coded — if a
tab is empty, that request returned nothing.

## The **Connection check** tab

Left sidebar → **Setup → Connection check**. Four sub-tabs:

- **Connection** — the exact URL called, the table requested vs. the table
  actually read, the HTTP status, rows fetched, and every table your anon key
  can see. A **Copy this report** button puts it all on the clipboard as plain
  text (no keys, no property data) — that is the single most useful thing to
  send me if something still looks wrong.
- **Columns** — each thing the app needs, the column it matched, and a sample
  value. Anything red is a required column it could not find. Also lists the
  columns in your table that went unused, so you can tell me the right name.
- **Status values** — every distinct spelling in your `Agreement status`
  column, which of the seven buckets it landed in, and the row count.
- **Sample row** — the first record exactly as Supabase returned it, with the
  real column names.

## Case sensitivity — handled at four levels

Postgres table names, column headers and cell values are all case-sensitive
over the REST API. The app normalises every one of them (lowercase, and ignore
spaces, underscores, slashes and punctuation):

| Level | Example that now works |
|---|---|
| **Table name** | `.env` says `agreement track`, the real table is `Agreement Track`. The app probes the configured name, and on a 404 asks the API for the table list and matches case-insensitively. The Connection tab tells you it did this. |
| **Column headers** | `Owner Facing Account Manager`, `owner_facing_account_manager`, `OWNER FACING ACCOUNT MANAGER` all resolve to the same field |
| **Status values** | `Valid`, `valid`, `VALID`, `Not signed`, `not_signed`, `NOT SIGNED`, `Founder / Partner approved` all bucket correctly |
| **Squad & KAM values** | `Goa`, `goa`, `GOA ` count as one squad, not three rows. The label shown is whichever spelling is most common in the table |

Genuinely unknown status values are not dropped — they appear in an extra
**Unmapped** column so a miscount is visible rather than silent.

---

## Columns this app reads

Wired to your live schema. Matching ignores case, spaces and underscores, and
each field falls back to looser patterns if a column is ever renamed.

| Used for | Column | Required |
|---|---|---|
| Squad-wise summary | `squad` | yes |
| KAM-wise summary | `poc` | yes |
| Pre-signature statuses | `contract_signing_status` | yes |
| Valid / expiry statuses | `contract_lifecycle_status` | no |
| Expiry fallback | `agreement_end_date` | no |
| Property names | `vista_name` (then `property_name`) | no |
| Property links | `villa_details_link` (then `google_link`) | no |
| Agreement links | `agreement_link` | no |
| Live / not live | `current_status` | no |
| Live fallback | `live_date`, `delist_date`, `pause_date` | no |
| City | `city` | no |
| Property ID | `property_id` | no |
| Why not signed | `reason_not_signed` | no |

Everything else in the table is read but unused — the Connection check tab
lists those, so you can point me at a better column any time.

## How Agreement status is worked out

Your table has no single "Agreement status" column, so the seven MIS buckets are
derived in this order, and the Connection check tab shows which rule fired for
every row:

1. **`contract_signing_status`** — if it reads Not Signed, Email Confirmation or
   Founder/Partner Approved, that is the answer. These are pre-signature states,
   so nothing later can override them.
2. **`contract_lifecycle_status`** — if it reads Valid, To Expire or Expired,
   that wins.
3. **`agreement_end_date`** — if neither column decided it:
   - end date in the past → **Expired**
   - end date within the next 90 days → **To Expire**
   - end date further out → **Valid**
4. Nothing usable → **Unmapped**, shown as its own column so it is never a
   silent miscount.

The 90-day window is `VITE_EXPIRY_WINDOW_DAYS` in `.env` — change it and
redeploy if the MIS uses a different threshold.

## How Live / Not live is worked out

1. **`current_status`** — Delisted, Churned, Paused or On Hold → not live;
   Live or Active → live.
2. **`delist_date`** in the past → not live.
3. **`live_date`** in the past → live.
4. Nothing usable → counted separately as "no live status" rather than guessed.

---|---|---|
| KAM summaries | `Owner Facing Account Manager`, or anything like `Account Manager` / `KAM` | yes |
| Squad summaries | `New Squad Mapping`, or anything containing `Squad` | yes |
| All status counts | `Agreement status`, or anything like `Status` | yes |
| Property list | `Property Name` / `Villa Name` / `Name` | no |
| Clickable links | any column containing `Link` / `URL` | no |
| Live Properties filter | any column containing `Live` (e.g. `Live Status`) | no |

If there is no live/not-live column, the Live Properties tab lists every
property and says so.

---

## Deploying to Vercel

1. Push this folder to GitHub, **including `.env`** — it only holds the
   Supabase **anon public key**, which is safe to expose. Your data is
   protected by Row Level Security, not by hiding this key.
2. vercel.com → **Add New Project** → select the repo. Vercel auto-detects
   Vite; no configuration needed. **Deploy**.
3. To change project/table later, edit `.env` (or set the same variable names
   under Vercel → Project Settings → Environment Variables, which overrides the
   file) and redeploy.

### Optional variable
`VITE_LIVE_PROPERTIES_URL` — leave blank and the Live Properties tab opens this
app's own Live Properties page in a new browser tab. Set it to any URL and that
opens in the new tab instead.

## If the dashboard shows no data
Almost always Row Level Security: Supabase → Table Editor → your table → make
sure a `SELECT` policy exists allowing read access. The app says so on screen
when the table returns zero rows.

## Note on row limits
Supabase caps a single REST response at 1000 rows. The app pages through in
1000-row batches, so all ~1,190 properties are counted. Without that the
Grand Total would silently stop at 1000.

## Note on the Google Sheet → Supabase sync
This project only covers the dashboard (reading from Supabase). Keeping
Supabase updated from your Google Sheet is a separate piece — either the Apps
Script sync or the service-account sync discussed earlier — and runs
independently of this web app.

## Refresh

Top right of the header. It re-runs the Supabase fetch without a full page
reload — your current tab, sub-tab and filters stay exactly where they were.
The button spins while it works and the time of the last successful load sits
next to it.

## How the Live Properties tab opens

It uses a **named window target** (`vista-tracker-live`) rather than
`target="_blank"`. That opens a tab in the same browser window and reuses that
same tab on every later click, instead of stacking up tabs or — as some browsers
do when `rel="noopener"` is set on a same-origin link — detaching a whole new
window. The Live properties card on the Overview opens the same tab.
