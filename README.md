# Vista Tracker — Web App

A Vite project: `index.html` (structure), `src/style.css` (styling),
`src/main.js` (all logic), `.env` (configuration). Vite is what makes `.env`
work — a plain `.html` file has no build step to inject those values.

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
| **Overview** | KPI cards + the agreement status split. Sub-tabs: Snapshot, Status detail |
| **KAM-wise Summary** | The MIS pivot by Owner Facing Account Manager. Sub-tabs: Counts, Valid % ranking |
| **Squad-wise Summary** | The MIS pivot by New Squad Mapping. Same sub-tabs |
| **Properties** | Every underlying row. Sub-tabs: All / Not signed / Expired / To expire / Valid |
| **Live Properties** | Opens in a **new browser tab**, carrying the current filters |

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

## Columns this app reads

Column names are matched loosely (case and punctuation are ignored), so a
rename in the Acq Master will not silently blank out a tab:

| Needed for | Matches | Required |
|---|---|---|
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
