# Vista Tracker — Web App

A proper multi-file project: `index.html` (structure), `src/style.css`
(styling), `src/main.js` (logic), and `.env` (configuration) — built with
[Vite](https://vitejs.dev), a lightweight tool that turns these separate
files into a fast static site and is what makes the `.env` file actually work
(a plain `.html` file can't read `.env` — there's no build step to inject
those values otherwise).

## Folder structure
```
vista-tracker-app/
├── index.html          <- page structure
├── src/
│   ├── style.css        <- all styling
│   └── main.js           <- all app logic (fetches from Supabase, renders UI)
├── .env                  <- your Supabase URL/key (already filled in)
├── .env.example           <- template reference
├── package.json
├── vite.config.js
└── .gitignore
```

## Running it locally (optional, to preview before deploying)
If you have Node.js installed:
```
npm install
npm run dev
```
This opens the dashboard at `http://localhost:5173` with live-reload.

## Deploying to Vercel (this is the actual shareable link)

### 1. Push this folder to GitHub
- Create a new GitHub repo.
- Upload every file in this folder, **including `.env`** this time —
  unlike the earlier service-account setup, this `.env` only contains the
  Supabase **anon public key**, which is safe to expose (your data stays
  protected by Supabase's Row Level Security policies, not by hiding this key).

### 2. Import into Vercel
- Go to vercel.com → **Add New Project** → select your repo.
- Vercel will auto-detect this as a **Vite** project — no configuration needed.
- Click **Deploy**.

### 3. Where the `.env` link actually goes
The `.env` file in this project already has your real Supabase project filled in:
```
VITE_SUPABASE_URL=https://benzjvkbevombzjwwtqr.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGci...
VITE_SUPABASE_TABLE=agreement track
```
Since you pushed `.env` to GitHub along with everything else, Vercel picks
these up automatically at build time — nothing further to do.

**If you ever want to change the Supabase project or table without editing
code:** update the values in this `.env` file (or, more properly, set the same
variable names under Vercel → Project Settings → Environment Variables, which
overrides the file) and redeploy.

### 4. Confirm it works
Visit your new `https://your-project.vercel.app` link — you should see the
login screen, and after entering any email, the dashboard should load your
real property data from Supabase.

## If the dashboard shows no data after deploying
Almost always Row Level Security — go to Supabase → Table Editor → your table
→ make sure a `SELECT` policy exists allowing read access (same fix used
throughout this project's setup).

## Note on the Google Sheet → Supabase sync
This project only covers the **dashboard** (reading from Supabase). Keeping
Supabase itself updated from your Google Sheet is a separate piece — either
the Apps Script sync or the service-account-based sync discussed earlier —
and runs independently of this web app.
