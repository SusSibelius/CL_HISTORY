# Historiegissare

Guess the historical figure from their birth and death — shown only as a year and a place on the map.

## Run it locally

No build step. Any static server works, e.g.:

```bash
npx serve .
# or
python3 -m http.server 8000
```

Then open the printed local URL.

## Deploy to GitHub Pages

1. Create a new repo and push these files to the root (or to a `/docs` folder — your choice).
2. In the repo, go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to "Deploy from a branch", pick your branch and the folder you used (`/root` or `/docs`).
4. Save — GitHub gives you a `https://<username>.github.io/<repo>/` URL a minute or two later.

The site itself is fully static. The shared leaderboard needs a free Supabase project (see below); without it the game runs in offline mode.

## How the game works

It's a **daily challenge**: everyone gets one run per day with the same people in the same order, and competes on a shared leaderboard.

- Before your run you type the name you'll appear under on the leaderboard. Names are 2–24 characters (Latin letters incl. accents, numbers, spaces and `. _ ' -`), unique per day, and checked against a word filter. Your name is remembered for the next days. No login needed.
- Each round shows one person's birth pin (teal) and death pin (plum), labeled with the year. Type who it is — **first and last name**; there are no suggestions. A correct guess moves you to the next person; one wrong guess ends the run and reveals the answer.
- Small typos are forgiven (checked per word: 1–2 letter words must be exact, 3–6 letters may have 1 typo, longer words 2; two swapped letters count as one typo). A one-word guess doesn't end the run — you're just asked for the full name.
- One 💡 hint per run reveals a short description of the current person.
- After the run you see your score, your rank today, the leaderboard and a countdown to the next run. Days change at midnight UTC.
- Reloading mid-run resumes where you left off; you can't restart a run you've already played.

## Turn on the shared leaderboard (Supabase)

Without this the game runs in **offline mode**: same daily rules, but scores stay on your device. To connect it:

1. Create a free project at [supabase.com](https://supabase.com).
2. In the project, open **SQL Editor**, paste the contents of `supabase/schema.sql` and run it. Then do the same with `supabase/seed.sql`.
3. Open **Project Settings → API** and copy the **Project URL** and the **anon public** key into `config.js`.
4. Commit and push. The page now uses the shared leaderboard.

The anon key is designed to be public. The database only lets it call the game's functions: the browser never receives the answers, and scores are recorded by the server as you guess, so a score can't just be sent in.

### Updating the database

When `supabase/schema.sql` changes (new features), paste the whole file into the SQL Editor again and run it. It's safe to re-run: it keeps all runs and scores.

### Moderating names

Vulgar and offensive names are rejected by a word filter in the database (`hg_private.name_filter`, see `schema.sql`). It also catches split-up (`f.u.c.k`), stretched (`fuuuck`) and number-for-letter (`sh1t`) spellings. To block another word, run in the SQL Editor:

```sql
insert into hg_private.name_filter (word, whole_word) values ('someword', false);
```

Use `whole_word = true` for short words that appear inside ordinary names (like "ass" in Cassandra), so they're only blocked on their own. To remove a name that already got through from today's leaderboard:

```sql
update public.runs set username = 'Removed' where day = current_date and username ilike 'the name';
```

## Adding people

1. Add entries to `data.js` following the existing shape. City-level coordinates are enough. `answers` should only hold full names (e.g. other spellings or a full birth name) — typos are handled automatically, and the display `name` is always accepted too.
2. Run `node scripts/build-seed.js` to regenerate `supabase/seed.sql`.
3. Run `supabase/seed.sql` in the Supabase SQL editor again (it updates existing people and adds new ones).

A perfect run means naming everyone in the pool, so more people = longer possible runs.

## Files

- `index.html` — page structure
- `style.css` — design system (paper background, teal/plum palette, glass chrome)
- `config.js` — Supabase URL and anon key (empty = offline mode)
- `api.js` — talks to Supabase, or plays locally from `data.js` in offline mode
- `game.js` — map, daily run flow and leaderboard UI
- `data.js` — the people (name, accepted answers, hint, birth/death year + coordinates)
- `supabase/schema.sql` — tables and the game's server functions
- `supabase/seed.sql` — the people, generated from `data.js`
- `scripts/build-seed.js` — regenerates `seed.sql`

After changing `style.css`, `config.js`, `api.js`, `game.js` or `data.js`, bump the `?v=` number on their links in `index.html` (and the `data.js?v=` in `api.js`), so browsers don't mix old and new files.

## Known limits

- Without logins, "one run per day" is per browser. Someone who clears their browser data (or uses another device) can play again under a new name. Accounts would close that gap later.

## Extending it

- **iOS / desktop app:** this is a plain responsive web app on purpose, so it already installs as a home-screen PWA on iOS. To ship it as a real native app later, the cleanest path is wrapping this same code with [Capacitor](https://capacitorjs.com/) (iOS + desktop via Electron) without rewriting the game logic.
- **Map tiles:** currently using Esri's free "World Light Gray" tiles. For higher traffic you'll want your own tile provider (e.g. MapTiler, Stadia Maps) with an API key.
