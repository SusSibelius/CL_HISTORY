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
      rerollName: () => rpc("hg_reroll_name", { p_device: device }),
      setName: (name) => rpc("hg_set_name", { p_device: device, p_name: name }),
      start: () => rpc("hg_start", { p_device: device }),
      guess: (text) => rpc("hg_guess", { p_device: device, p_guess: text }),
      hint: () => rpc("hg_hint", { p_device: device }).then((r) => r.hint),
      leaderboard: (limit) => rpc("hg_leaderboard", { p_device: device, p_limit: limit || 10 }),
      names: () => rpc("hg_names"),
    };
  }

  // ---------- Player-chosen names ----------
  // Same rules as hg_set_name in supabase/schema.sql.
  const NAME_RULES = "Use 2–24 characters: letters, numbers, spaces and . _ ' -";
  window.HG_NAME_RULES = NAME_RULES;
  window.HG_cleanName = (name) => String(name || "").normalize("NFC").trim().replace(/\s+/g, " ");
  window.HG_validName = (n) =>
    n.length >= 2 && n.length <= 24 && /^[\p{L}\p{N} ._'-]+$/u.test(n) && /[\p{L}\p{N}]/u.test(n);

  // ---------- Offline (local, from data.js) ----------
  const ADJECTIVES = ["Curious", "Bold", "Wandering", "Quiet", "Brave", "Clever", "Swift", "Patient",
    "Lucky", "Keen", "Gentle", "Restless", "Sharp", "Humble", "Daring", "Merry"];
  const NOUNS = ["Cartographer", "Archivist", "Chronicler", "Navigator", "Scribe", "Explorer", "Historian", "Pilgrim",
    "Voyager", "Scholar", "Herald", "Alchemist", "Astronomer", "Wanderer", "Curator", "Bard"];
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const randomName = () => `${pick(ADJECTIVES)} ${pick(NOUNS)} ${10 + Math.floor(Math.random() * 90)}`;

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

  function localApi() {
    const ready = loadScript("data.js?v=6");
    const todayKey = () => new Date().toISOString().slice(0, 10); // UTC day, like the server

    function load() {
      const day = todayKey();
      let run = null;
      try { run = JSON.parse(storageGet("hg_run") || "null"); } catch (e) { run = null; }
      // A run started yesterday can still be finished after midnight UTC.
      if (!run || (run.day !== day && !(run.started && !run.finished))) {
        run = { day, username: randomName(), score: 0, hint_used: false, started: false, finished: false };
        save(run);
      }
      return run;
    }
    function save(run) { storageSet("hg_run", JSON.stringify(run)); }

    function order(day) {
      return PEOPLE.slice().sort((a, b) => hash(day + ":" + a.name) - hash(day + ":" + b.name));
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

    const norm = (s) => String(s || "").toLowerCase().normalize("NFD")
      .replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9\s]/g, "").trim();

    return {
      online: false,
      today: async () => { await ready; return state(load()); },
      rerollName: async () => {
        await ready;
        const run = load();
        if (run.started) throw new Error("run already started");
        run.username = randomName();
        save(run);
        return state(run);
      },
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
        run.started = true;
        save(run);
        return state(run);
      },
      guess: async (text) => {
        await ready;
        const run = load();
        if (!run.started || run.finished) throw new Error("no run in progress");
        const p = current(run);
        const correct = norm(text) !== "" && p.answers.some((a) => norm(a) === norm(text));
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
      names: async () => { await ready; return PEOPLE.map((p) => p.name).sort(); },
    };
  }

  const cfg = window.HG_CONFIG || {};
  window.HG_API = cfg.supabaseUrl && cfg.supabaseAnonKey
    ? remoteApi(cfg.supabaseUrl, cfg.supabaseAnonKey)
    : localApi();
})();
