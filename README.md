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

1. Create a new repo and push these files (`index.html`, `style.css`, `game.js`, `data.js`) to the root (or to a `/docs` folder — your choice).
2. In the repo, go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to "Deploy from a branch", pick your branch and the folder you used (`/root` or `/docs`).
4. Save — GitHub gives you a `https://<username>.github.io/<repo>/` URL a minute or two later.

No server, API keys, or config needed — it's a fully static site.

## How the game works

- Each round shows one person's birth pin (teal) and death pin (plum), each labeled with its year.
- Type a guess into the floating capsule at the bottom. A correct guess advances your streak and loads a new person; a wrong guess ends the run and reveals the answer.
- One hint per run: the 💡 button reveals a short description (occupation/role) for the *current* person. It stays used up until you start a new run.
- Best streak is kept in the browser's local storage.

## Files

- `index.html` — page structure
- `style.css` — design system (paper background, teal/plum palette, glass chrome)
- `data.js` — the dataset of people (name, accepted answers, hint, birth/death year + coordinates)
- `game.js` — map setup and game logic

## Extending it

- **More people:** add entries to `data.js` following the existing shape. Coordinates just need to be roughly right — city-level is enough.
- **iOS / desktop app:** this is a plain responsive web app on purpose, so it already installs as a home-screen PWA on iOS. To ship it as a real native app later, the cleanest path is wrapping this same code with [Capacitor](https://capacitorjs.com/) (iOS + desktop via Electron) without rewriting the game logic.
- **Map tiles:** currently using CARTO's free "Positron" tiles. For higher traffic you'll want your own tile provider (e.g. MapTiler, Stadia Maps) with an API key.
