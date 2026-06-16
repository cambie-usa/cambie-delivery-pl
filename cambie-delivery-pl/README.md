# Cambie Local Delivery P&L

A browser-based P&L tracker for Cambie's local delivery business.
Data is stored in Supabase so all team members share the same view in real time.

---

## One-time setup (≈10 minutes)

### 1. Create a Supabase project

1. Go to [supabase.com](https://supabase.com) and sign in to the Cambie org.
2. Click **New project** → name it `cambie-delivery-pl`.
3. Once the project is ready, open **SQL Editor** → **New query**.
4. Paste the contents of `supabase/schema.sql` and click **Run**.

### 2. Grab your credentials

In the Supabase dashboard go to **Project Settings → API**:

- Copy **Project URL** (looks like `https://xxxx.supabase.co`)
- Copy **anon / public** key

### 3. Add credentials to config.js

Open `public/config.js` and replace the placeholder values:

```js
const SUPABASE_URL  = 'https://xxxx.supabase.co';
const SUPABASE_ANON = 'eyJ...your anon key...';
```

### 4. Deploy to Netlify

**Option A — drag and drop (fastest)**
1. Go to [app.netlify.com/drop](https://app.netlify.com/drop)
2. Drag the entire `public/` folder onto the page.
3. Done — Netlify gives you a URL instantly.

**Option B — GitHub (recommended for ongoing updates)**
1. Push this repo to GitHub.
2. In Netlify: **Add new site → Import from Git**.
3. Set **Publish directory** to `public`.
4. Deploy.

---

## Using the app

| Action | How |
|--------|-----|
| Add invoice | Click **＋ Add Invoice** or drag a CIN7 PDF onto the upload zone |
| Enter margins | In the modal, type the margin % for each line item |
| Enter delivery charge | Type the courier charge in the orange field |
| Save | Click **Save Invoice** — syncs to Supabase immediately |
| Edit | Click **Edit** on any invoice row |
| Export | Click **↓ Export PDF** for a formatted CFO report |

All team members who open the URL see the same data.

---

## File structure

```
cambie-delivery-pl/
├── public/
│   ├── index.html      ← main app shell
│   ├── style.css       ← all styles
│   ├── config.js       ← Supabase credentials (edit this)
│   ├── app.js          ← Supabase data layer
│   └── dashboard.js    ← UI logic, PDF parsing, PDF export
├── supabase/
│   └── schema.sql      ← run once in Supabase SQL Editor
├── netlify.toml        ← Netlify config
└── README.md
```
