(function () {
  "use strict";

  const api = window.HG_API;

  // ---------- State ----------
  let state = null; // today's run, as returned by the API
  let names = [];
  let bornMarker, deathMarker;
  let accepting = false;
  let countdownTimer = null;
  let nameEdited = false; // the player typed their own name (vs. a suggestion)

  // ---------- DOM ----------
  const streakNumEl = document.getElementById("streakNum");
  const playerChip = document.getElementById("playerChip");
  const lifelineBtn = document.getElementById("lifelineBtn");
  const guessCapsule = document.getElementById("guessCapsule");
  const guessForm = document.getElementById("guessForm");
  const guessInput = document.getElementById("guessInput");
  const suggestionsEl = document.getElementById("suggestions");
  const feedbackEl = document.getElementById("feedback");
  const overlay = document.getElementById("dailyOverlay");
  const card = document.getElementById("dailyCard");

  // ---------- Map ----------
  const map = L.map("map", {
    zoomControl: false,
    attributionControl: true,
    dragging: false,
    touchZoom: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    boxZoom: false,
    keyboard: false,
    tap: false,
  }).setView([20, 0], 2);

  L.tileLayer(
    "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    {
      attribution: "Tiles &copy; Esri",
      maxZoom: 16,
    }
  ).addTo(map);

  L.tileLayer(
    "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
    {
      maxZoom: 16,
    }
  ).addTo(map);

  function makeIcon(year, kind) {
    return L.divIcon({
      className: "",
      html: `<div class="map-marker">
               <div class="marker-year ${kind}">${year}</div>
               <div class="marker-pin ${kind}"></div>
             </div>`,
      iconSize: [70, 56],
      iconAnchor: [35, 50],
    });
  }

  // Keep both markers readable when born/died are close together on screen:
  // spread the year labels apart sideways, and merge the pins into one
  // two-tone pin when they would sit on top of each other.
  const LABEL_GAP = 62; // px between label centres (labels are ~50px wide)
  const LABEL_H = 30;
  const PIN_MERGE = 12;

  function layoutMarkers() {
    if (!bornMarker || !deathMarker) return;
    const bornEl = bornMarker.getElement();
    const diedEl = deathMarker.getElement();
    if (!bornEl || !diedEl) return;

    const pb = map.latLngToLayerPoint(bornMarker.getLatLng());
    const pd = map.latLngToLayerPoint(deathMarker.getLatLng());
    const dx = pd.x - pb.x;
    const dy = pd.y - pb.y;

    let shift = 0;
    if (Math.abs(dx) < LABEL_GAP && Math.abs(dy) < LABEL_H) {
      shift = (LABEL_GAP - Math.abs(dx)) / 2;
    }
    // Born goes to whichever side it already leans towards (left on a tie).
    const dir = dx >= 0 ? 1 : -1;
    bornEl.querySelector(".marker-year").style.transform = `translateX(${-dir * shift}px)`;
    diedEl.querySelector(".marker-year").style.transform = `translateX(${dir * shift}px)`;

    const merge = Math.hypot(dx, dy) < PIN_MERGE;
    bornEl.querySelector(".marker-pin").classList.toggle("hidden", merge);
    diedEl.querySelector(".marker-pin").classList.toggle("shared", merge);
  }

  map.on("zoomend", layoutMarkers);

  // ---------- Helpers ----------
  function fitToBounds(bounds) {
    const capsuleH = guessCapsule.offsetHeight + 48;
    map.fitBounds(bounds, {
      paddingTopLeft: [40, 110],
      paddingBottomRight: [40, Math.max(capsuleH, 140)],
      maxZoom: 6,
    });
    // Single-point bounds (born == died) collapse to a point; give it a sane zoom.
    if (bounds.getNorthEast().equals(bounds.getSouthWest())) {
      map.setZoom(5);
    }
  }

  function normalize(str) {
    return str
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9\s]/g, "")
      .trim();
  }


  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
    );
  }

  function formatDay(day) {
    return new Date(day + "T00:00:00Z").toLocaleDateString(undefined, {
      weekday: "long", day: "numeric", month: "long", timeZone: "UTC",
    });
  }

  // ---------- Rounds ----------
  function showPerson(person) {
    accepting = true;
    guessInput.value = "";
    guessInput.disabled = false;
    lifelineBtn.disabled = state.hint_used;
    hideSuggestions();

    if (bornMarker) map.removeLayer(bornMarker);
    if (deathMarker) map.removeLayer(deathMarker);

    const b = person.born;
    const d = person.died;
    bornMarker = L.marker([b.lat, b.lng], { icon: makeIcon(b.year, "born"), keyboard: false }).addTo(map);
    deathMarker = L.marker([d.lat, d.lng], { icon: makeIcon(d.year, "died"), keyboard: false }).addTo(map);

    fitToBounds(L.latLngBounds([[b.lat, b.lng], [d.lat, d.lng]]));
    layoutMarkers();

    guessInput.focus();
  }

  function setScore(score, bump) {
    streakNumEl.textContent = String(score);
    if (bump) {
      streakNumEl.classList.add("bump");
      setTimeout(() => streakNumEl.classList.remove("bump"), 250);
    }
  }

  function setPlaying(on) {
    guessInput.disabled = !on;
    lifelineBtn.disabled = !on || (state && state.hint_used);
    if (!on) accepting = false;
  }

  function showError(err) {
    feedbackEl.textContent = `Couldn't reach the game server — ${err.message}`;
    feedbackEl.className = "feedback wrong";
  }

  async function handleGuess(raw) {
    if (!accepting || !raw.trim()) return;
    accepting = false;
    guessInput.disabled = true;
    hideSuggestions();

    let res;
    try {
      res = await api.guess(raw);
    } catch (err) {
      showError(err);
      accepting = true;
      guessInput.disabled = false;
      return;
    }
    state = res.state;

    if (res.correct) {
      setScore(state.score, true);
      feedbackEl.textContent = `${res.answer.name} — correct.`;
      feedbackEl.className = "feedback correct";
      guessCapsule.classList.add("pulse-correct");
      setTimeout(() => guessCapsule.classList.remove("pulse-correct"), 550);

      if (state.status === "playing") {
        setTimeout(() => {
          feedbackEl.textContent = "";
          feedbackEl.className = "feedback";
          showPerson(state.person);
        }, 850);
      } else {
        setTimeout(() => showCard({ answer: res.answer, perfect: true }), 900);
      }
    } else {
      feedbackEl.textContent = "Not quite.";
      feedbackEl.className = "feedback wrong";
      setTimeout(() => showCard({ answer: res.answer }), 700);
    }
  }

  // ---------- Daily card ----------
  function leaderboardHtml(rows) {
    if (!api.online) {
      return `<p class="board-note">Offline mode — connect Supabase in <code>config.js</code> to compete on a shared leaderboard.</p>`;
    }
    if (!rows.length) {
      return `<p class="board-note">No one has played today yet. Be the first!</p>`;
    }
    return `<ol class="board">${rows.map((r) => `
      <li class="${r.me ? "me" : ""}">
        <span class="board-rank">${r.rank}</span>
        <span class="board-name">${escapeHtml(r.username)}${r.me ? " <em>(you)</em>" : ""}</span>
        ${r.playing ? `<span class="board-live" title="Still playing">playing</span>` : ""}
        <span class="board-score">${r.score}</span>
      </li>`).join("")}</ol>`;
  }

  function countdownText() {
    const now = new Date();
    const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    const s = Math.max(0, Math.floor((next - now.getTime()) / 1000));
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  }

  async function showCard(extra) {
    extra = extra || {};
    setPlaying(false);
    clearInterval(countdownTimer);

    let rows = [];
    try {
      rows = await api.leaderboard(10);
    } catch (err) {
      rows = null;
    }
    const board = rows === null
      ? `<p class="board-note">Couldn't load the leaderboard.</p>`
      : leaderboardHtml(rows);

    const s = state;
    let html = `<p class="card-eyebrow">Daily run · ${escapeHtml(formatDay(s.day))}</p>`;

    if (s.status === "new") {
      html += `
        <label class="card-lead" for="nameInput">Choose your name for today's run</label>
        <div class="card-name">
          <input class="name-input" id="nameInput" type="text" maxlength="24" autocomplete="nickname"
                 spellcheck="false" value="${escapeHtml(savedName() || s.username)}" />
          <button class="reroll" id="rerollBtn" type="button" title="Suggest a random name" aria-label="Suggest a random name">↻</button>
        </div>
        <p class="name-error" id="nameError" role="alert"></p>
        <p class="card-rules">You get <strong>one run per day</strong>. Everyone gets the same people in the same order. Name as many as you can in a row; one wrong guess ends the run. One 💡 hint per run.</p>
        <button class="primary-btn" id="startBtn" type="button">Start today's run</button>`;
    } else if (s.status === "playing") {
      html += `
        <p class="card-lead">Your run is in progress</p>
        <h1>${escapeHtml(s.username)}</h1>
        <p class="card-rules">You're on <strong>${s.score}</strong> in a row. Pick up where you left off.</p>
        <button class="primary-btn" id="startBtn" type="button">Resume run</button>`;
    } else {
      const a = extra.answer;
      const st = s.standing || { rank: 1, players: 1 };
      html += a
        ? `<p class="card-lead ${extra.perfect ? "good" : "bad"}">${extra.perfect ? "Perfect run — you named everyone!" : "Run over — it was"}</p>
           ${extra.perfect ? "" : `<h1>${escapeHtml(a.name)}</h1>
           <p class="card-sub">Born ${a.born.year} in ${escapeHtml(a.born.place)}, died ${a.died.year} in ${escapeHtml(a.died.place)}.</p>`}`
        : `<p class="card-lead">You've played today, ${escapeHtml(s.username)}</p>`;
      html += `
        <div class="card-stats">
          <div><span class="card-stat-num">${s.score}</span><span class="card-stat-label">in a row</span></div>
          ${api.online ? `<div><span class="card-stat-num">#${st.rank}</span><span class="card-stat-label">of ${st.players} today</span></div>` : ""}
        </div>
        <p class="card-next">Next run in <strong id="countdown">${countdownText()}</strong></p>`;
    }

    html += `<div class="card-board"><p class="board-title">Today's leaderboard</p>${board}</div>`;
    card.innerHTML = html;
    overlay.hidden = false;

    const startBtn = document.getElementById("startBtn");
    if (startBtn) startBtn.addEventListener("click", startRun);
    const rerollBtn = document.getElementById("rerollBtn");
    if (rerollBtn) rerollBtn.addEventListener("click", rerollName);
    const nameInput = document.getElementById("nameInput");
    if (nameInput) {
      nameEdited = Boolean(savedName());
      nameInput.addEventListener("input", () => {
        nameEdited = true;
        document.getElementById("nameError").textContent = "";
      });
      nameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") startRun();
      });
    }
    const cd = document.getElementById("countdown");
    if (cd) {
      countdownTimer = setInterval(() => {
        cd.textContent = countdownText();
        // A new day has started: fetch the new run.
        if (cd.textContent === "00:00:00") setTimeout(boot, 1500);
      }, 1000);
    }
  }

  // A name the player typed themselves is remembered for the next days.
  function savedName() {
    try { return localStorage.getItem("hg_name") || ""; } catch (e) { return ""; }
  }
  function saveName(name) {
    try { localStorage.setItem("hg_name", name); } catch (e) { /* private mode etc. */ }
  }

  async function rerollName() {
    const btn = document.getElementById("rerollBtn");
    const errorEl = document.getElementById("nameError");
    btn.disabled = true;
    try {
      state = await api.rerollName();
      document.getElementById("nameInput").value = state.username;
      nameEdited = false;
      errorEl.textContent = "";
    } catch (err) {
      errorEl.textContent = err.message;
    }
    btn.disabled = false;
  }

  async function startRun() {
    const btn = document.getElementById("startBtn");
    if (btn.disabled) return;
    btn.disabled = true;

    const nameInput = document.getElementById("nameInput");
    if (nameInput) {
      const errorEl = document.getElementById("nameError");
      const name = window.HG_cleanName(nameInput.value);
      if (!window.HG_validName(name)) {
        errorEl.textContent = window.HG_NAME_RULES;
        btn.disabled = false;
        nameInput.focus();
        return;
      }
      if (name !== state.username) {
        try {
          state = await api.setName(name);
        } catch (err) {
          errorEl.textContent = err.message;
          btn.disabled = false;
          nameInput.focus();
          return;
        }
      }
      if (nameEdited) saveName(state.username);
      playerChip.textContent = state.username;
      playerChip.hidden = false;
    }

    try {
      state = await api.start();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Couldn't start — try again";
      return;
    }
    overlay.hidden = true;
    clearInterval(countdownTimer);
    feedbackEl.textContent = "";
    feedbackEl.className = "feedback";
    setScore(state.score);
    if (state.status === "playing") showPerson(state.person);
    else showCard();
  }

  // ---------- Autocomplete ----------
  function hideSuggestions() {
    suggestionsEl.hidden = true;
    suggestionsEl.innerHTML = "";
  }

  function showSuggestions(query) {
    const q = normalize(query);
    if (!q) return hideSuggestions();
    const matches = names.filter((n) => normalize(n).includes(q)).slice(0, 6);
    if (!matches.length) return hideSuggestions();

    suggestionsEl.innerHTML = matches
      .map((n) => `<div class="suggestion-item" data-name="${escapeHtml(n)}">${escapeHtml(n)}</div>`)
      .join("");
    suggestionsEl.hidden = false;
  }

  suggestionsEl.addEventListener("click", (e) => {
    const item = e.target.closest(".suggestion-item");
    if (!item) return;
    guessInput.value = item.dataset.name;
    hideSuggestions();
    guessInput.focus();
  });

  guessInput.addEventListener("input", () => showSuggestions(guessInput.value));
  guessInput.addEventListener("blur", () => setTimeout(hideSuggestions, 120));

  // ---------- Form / buttons ----------
  guessForm.addEventListener("submit", (e) => {
    e.preventDefault();
    handleGuess(guessInput.value);
  });

  lifelineBtn.addEventListener("click", async () => {
    if (!accepting || state.hint_used) return;
    lifelineBtn.disabled = true;
    try {
      const hint = await api.hint();
      state.hint_used = true;
      feedbackEl.textContent = `💡 ${hint}`;
      feedbackEl.className = "feedback hint";
    } catch (err) {
      lifelineBtn.disabled = false;
      showError(err);
    }
    guessInput.focus();
  });

  window.addEventListener("resize", () => {
    map.invalidateSize();
    if (bornMarker && deathMarker) {
      fitToBounds(L.latLngBounds([bornMarker.getLatLng(), deathMarker.getLatLng()]));
      layoutMarkers();
    }
  });

  // ---------- Boot ----------
  async function boot() {
    setPlaying(false);
    card.innerHTML = `<p class="card-lead">Loading today's run…</p>`;
    overlay.hidden = false;
    try {
      [state, names] = await Promise.all([api.today(), names.length ? names : api.names()]);
    } catch (err) {
      card.innerHTML = `
        <p class="card-lead bad">Couldn't reach the game server</p>
        <p class="card-sub">${escapeHtml(err.message)}</p>
        <button class="primary-btn" id="retryBtn" type="button">Try again</button>`;
      document.getElementById("retryBtn").addEventListener("click", boot);
      return;
    }
    playerChip.textContent = state.username;
    playerChip.hidden = state.status === "new"; // shown once the name is locked in
    setScore(state.score);
    if (bornMarker) { map.removeLayer(bornMarker); bornMarker = null; }
    if (deathMarker) { map.removeLayer(deathMarker); deathMarker = null; }
    showCard();
  }

  boot();
})();
