// Game backend. Online it calls the Supabase functions in supabase/schema.sql,
// which pick the people, check guesses and keep the leaderboard, so answers
// never reach the browser. Offline (no config) it plays the same daily rules
// locally from data.js, without a shared leaderboard.
//
// Every method resolves to the same shapes in both modes:
//   state  = { day, username, status: "new"|"playing"|"finished", score, hint_used,
//              total, person: {born, died} | null, standing: {rank, players} | null }
//   guess  → { correct, answer: {name, born:{year,place}, died:{year,place}}, state }
(function () {
  "use strict";

  function storageGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function storageSet(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* private mode etc. */ }
  }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
      (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)
    );
  }

  // Identifies this browser to the server instead of a login.
  function deviceId() {
    let id = storageGet("hg_device");
    if (!id) {
      id = uuid();
      storageSet("hg_device", id);
    }
    return id;
  }

  // ---------- Online (Supabase) ----------
  function remoteApi(url, key) {
    const device = deviceId();
    async function rpc(fn, args) {
      const res = await fetch(`${url.replace(/\/$/, "")}/rest/v1/rpc/${fn}`, {
        method: "POST",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(args || {}),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error((body && body.message) || `Request failed (${res.status})`);
      return body;
    }
    return {
      online: true,
      today: () => rpc("hg_today", { p_device: device }),
      setName: (name) => rpc("hg_set_name", { p_device: device, p_name: name }),
      start: () => rpc("hg_start", { p_device: device }),
      guess: (text) => rpc("hg_guess", { p_device: device, p_guess: text }),
      hint: () => rpc("hg_hint", { p_device: device }).then((r) => r.hint),
      leaderboard: (limit) => rpc("hg_leaderboard", { p_device: device, p_limit: limit || 10 }),
    };
  }

  // ---------- Player-chosen names ----------
  // Same basic rules as hg_set_name in supabase/schema.sql, for instant feedback.
  // The word filter only runs on the server (offline mode has no filter; only
  // you see your name there).
  const NAME_RULES = "Use 2–24 characters: letters, numbers, spaces and . _ ' -";
  window.HG_NAME_RULES = NAME_RULES;
  window.HG_cleanName = (name) => String(name || "").normalize("NFC").trim().replace(/\s+/g, " ");
  window.HG_validName = (n) =>
    n.length >= 2 && n.length <= 24 && /^[\p{Script=Latin}\p{M}\p{N} ._'-]+$/u.test(n) && /[\p{L}\p{N}]/u.test(n);

  // ---------- Offline (local, from data.js) ----------
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`Could not load ${src}`));
      document.head.appendChild(s);
    });
  }

  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  // Guess matching rules are shared with the scripts (match.js).
  const { normalize: norm, words, answerMatches } = window.HG_MATCH;

  function localApi() {
    const ready = loadScript("data.js?v=10");
    const todayKey = () => new Date().toISOString().slice(0, 10); // UTC day, like the server

    function load() {
      const day = todayKey();
      let run = null;
      try { run = JSON.parse(storageGet("hg_run") || "null"); } catch (e) { run = null; }
      // A run started yesterday can still be finished after midnight UTC.
      if (!run || (run.day !== day && !(run.started && !run.finished))) {
        run = { day, username: null, score: 0, hint_used: false, started: false, finished: false };
        save(run);
      }
      return run;
    }
    function save(run) { storageSet("hg_run", JSON.stringify(run)); }

    // Famous people first, with a daily nudge — like hg_private.person_at.
    // (data.js is sorted most famous first.)
    const orderCache = {};
    function order(day) {
      if (!orderCache[day]) {
        orderCache[day] = PEOPLE
          .map((p, i) => ({ p, key: Math.log(i + 21) + 2.4 * (hash(day + ":" + p.name) / 4294967296 - 0.5) }))
          .sort((x, y) => x.key - y.key)
          .map((x) => x.p);
      }
      return orderCache[day];
    }
    function current(run) { return order(run.day)[run.score]; }

    function state(run) {
      const status = run.finished ? "finished" : run.started ? "playing" : "new";
      const p = status === "playing" ? current(run) : null;
      return {
        day: run.day,
        username: run.username,
        status,
        score: run.score,
        hint_used: run.hint_used,
        total: PEOPLE.length,
        person: p && {
          born: { year: p.born.year, lat: p.born.lat, lng: p.born.lng },
          died: { year: p.died.year, lat: p.died.lat, lng: p.died.lng },
        },
        standing: status === "new" ? null : { rank: 1, players: 1 },
      };
    }

    return {
      online: false,
      today: async () => { await ready; return state(load()); },
      setName: async (name) => {
        await ready;
        const run = load();
        if (run.started) throw new Error("run already started");
        const n = window.HG_cleanName(name);
        if (!window.HG_validName(n)) throw new Error(NAME_RULES);
        run.username = n;
        save(run);
        return state(run);
      },
      start: async () => {
        await ready;
        const run = load();
        if (!run.username) throw new Error("Choose a name first");
        run.started = true;
        save(run);
        return state(run);
      },
      guess: async (text) => {
        await ready;
        const run = load();
        if (!run.started || run.finished) throw new Error("no run in progress");
        const p = current(run);
        if (words(norm(text)).length < 2 && words(norm(p.name)).length >= 2) {
          return { needs_full_name: true, state: state(run) };
        }
        const correct = p.answers.concat(p.name).some((a) => answerMatches(norm(text), norm(a)));
        if (correct) {
          run.score += 1;
          if (run.score >= PEOPLE.length) run.finished = true;
        } else {
          run.finished = true;
        }
        save(run);
        return {
          correct,
          answer: {
            name: p.name,
            born: { year: p.born.year, place: p.born.place },
            died: { year: p.died.year, place: p.died.place },
          },
          state: state(run),
        };
      },
      hint: async () => {
        await ready;
        const run = load();
        if (!run.started || run.finished) throw new Error("no run in progress");
        if (run.hint_used) throw new Error("hint already used");
        run.hint_used = true;
        save(run);
        return current(run).hint;
      },
      leaderboard: async () => {
        await ready;
        const run = load();
        if (!run.started) return [];
        return [{ rank: 1, username: run.username, score: run.score, playing: !run.finished, me: true }];
      },
    };
  }

  const cfg = window.HG_CONFIG || {};
  window.HG_API = cfg.supabaseUrl && cfg.supabaseAnonKey
    ? remoteApi(cfg.supabaseUrl, cfg.supabaseAnonKey)
    : localApi();
})();
