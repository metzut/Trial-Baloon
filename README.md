# Stash

Everything you find online — clothes, recipes, trips, home ideas — saved in one
place. Share from any app on your iPhone, pick a board, done. Open Stash to see
it all in a picture grid, like Pinterest.

- **Boards** for Shopping, Recipes, Travel, Home… make as many as you want.
- **Shared or private:** shared boards are visible to everyone in your Stash;
  "just me" boards are private.
- **Automatic previews:** picture, title, site and (for most shops) price.
  Pictures are copied into Stash, so they keep working after sites like TikTok
  and Instagram expire their links.
- **Notes, "Got it" checkmark, search**, and your own photo when a site hides
  its picture.

## Put it online (one time, ~10 minutes, free)

Stash runs on Cloudflare's free plan (website + database, no monthly cost).

1. Create a free account at <https://dash.cloudflare.com/sign-up>.
2. In the dashboard, go to **Workers & Pages → Create → Import a repository**.
3. Connect GitHub and pick **Trial-Baloon**. Keep the suggested settings
   (deploy command `npx wrangler deploy`) and choose the branch this code is on.
4. Click **Deploy**. Cloudflare creates the database automatically. After a
   minute you get an address like `https://stash.<your-name>.workers.dev`.
5. Open that address on your iPhone in Safari and **create your account first**
   (the first account doesn't need an invite code).

From then on, every change pushed to that branch goes live automatically.

## Set up each iPhone

1. Open Stash in Safari → **Share → Add to Home Screen**.
2. Open Stash → **Settings** (gear icon) and follow **Add Stash to your Share
   button**. It walks through building a 6-step Shortcut and gives you the
   links to paste.
3. Invite your partner: Settings shows an **invite code**. They create their
   own account with it, then do steps 1–2 on their phone with *their* links.

## For developers

```sh
npm install
npm run dev        # http://localhost:8787 with a local database
npm run typecheck
```

- `src/index.ts` — API (accounts, boards, items, Shortcut endpoints)
- `src/preview.ts` — reads a page's Open Graph tags (TikTok via oEmbed)
- `src/db.ts` — schema, created automatically on first request
- `public/` — the app itself (plain HTML/CSS/JS, no build step)

The Shortcut talks to two endpoints using a per-person secret link:
`GET /s/<token>/boards` returns board names; `POST /s/<token>/save` with JSON
`{ "input": "<shared link or text>", "board": "<chosen name>" }` saves it.
