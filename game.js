(function () {
  "use strict";

  const api = window.HG_API;

  // ---------- State ----------
  let state = null; // today's run, as returned by the API
  let bornMarker, deathMarker;
  let accepting = false;
  let countdownTimer = null;

  // ---------- DOM ----------
  const streakNumEl = document.getElementById("streakNum");
  const playerChip = document.getElementById("playerChip");
  const lifelineBtn = document.getElementById("lifelineBtn");
  const guessCapsule = document.getElementById("guessCapsule");
  const guessForm = document.getElementById("guessForm");
  const guessInput = document.getElementById("guessInput");
  const feedbackEl = document.getElementById("feedback");
  const overlay = document.getElementById("dailyOverlay");
  const card = document.getElementById("dailyCard");
  const mapEl = document.getElementById("map");
  const topbarEl = document.querySelector(".topbar");
  const legendEl = document.querySelector(".legend");

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
    // Fractional zoom: the view can fit the pins tightly instead of jumping
    // between whole zoom levels (which often left them small in the middle).
    zoomSnap: 0.25,
    zoomDelta: 0.25,
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

  // Years before 1 AD are stored as negative numbers.
  function formatYear(year) {
    return year < 0 ? `${-year} f.Kr.` : String(year);
  }

  function makeIcon(year, kind) {
    return L.divIcon({
      className: "",
      html: `<div class="map-marker">
               <div class="marker-year ${kind}">${formatYear(year)}</div>
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

    // Labels differ in width ("1889" vs "551 f.Kr."): keep their centres far enough apart.
    const gap = Math.max(LABEL_GAP,
      (bornEl.querySelector(".marker-year").offsetWidth + diedEl.querySelector(".marker-year").offsetWidth) / 2 + 12);
    let shift = 0;
    if (Math.abs(dx) < gap && Math.abs(dy) < LABEL_H) {
      shift = (gap - Math.abs(dx)) / 2;
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
  // Fit both pins into the part of the map that's actually visible: below the
  // top bar (and the legend on desktop), above the guess box (and the keyboard
  // on phones). Measured from the page, so it adapts when the keyboard opens.
  const LABEL_ROOM = 48; // the year label sits above the pin
  function fitToBounds(bounds) {
    const mapRect = mapEl.getBoundingClientRect();
    const mid = mapRect.top + mapRect.height / 2;
    let top = topbarEl.getBoundingClientRect().bottom;
    let bottom = guessCapsule.getBoundingClientRect().top;
    const legend = legendEl.getBoundingClientRect();
    if (legend.height && getComputedStyle(legendEl).display !== "none") {
      if (legend.bottom < mid) top = Math.max(top, legend.bottom);
      else bottom = Math.min(bottom, legend.top);
    }
    let padTop = Math.max(0, top - mapRect.top) + LABEL_ROOM;
    let padBottom = Math.max(0, mapRect.bottom - bottom) + 12;
    // Never ask for more padding than the map has room for: Leaflet would then
    // zoom right out or centre somewhere odd. Keep at least 80px for the pins.
    const spare = mapRect.height - padTop - padBottom - 80;
    if (spare < 0) {
      const scale = Math.max(0, (padTop + padBottom + spare) / (padTop + padBottom));
      padTop *= scale;
      padBottom *= scale;
    }
    const side = mapRect.width < 500 ? 36 : 48; // room for the year labels
    if (!mapRect.width || !mapRect.height) return; // not laid out yet
    map.fitBounds(bounds, {
      paddingTopLeft: [side, padTop],
      paddingBottomRight: [side, padBottom],
      maxZoom: 7,
      animate: false,
    });
    // Single-point bounds (born == died) collapse to a point; give it a sane zoom.
    if (bounds.getNorthEast().equals(bounds.getSouthWest())) {
      map.setZoom(5);
    }
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
    );
  }

  function formatDay(day) {
    return new Date(day + "T00:00:00Z").toLocaleDateString("sv-SE", {
      weekday: "long", day: "numeric", month: "long", timeZone: "UTC",
    });
  }

  // ---------- Rounds ----------
  const GUESS_TIP = "För- och efternamn – små stavfel är okej.";

  function showTip() {
    feedbackEl.textContent = GUESS_TIP;
    feedbackEl.className = "feedback";
  }

  function showPerson(person) {
    accepting = true;
    guessInput.value = "";
    guessInput.disabled = false;
    guessInput.readOnly = false;
    lifelineBtn.disabled = state.hint_used;

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
    feedbackEl.textContent = `Kunde inte nå spelservern – ${err.message}`;
    feedbackEl.className = "feedback wrong";
  }

  async function handleGuess(raw) {
    if (!accepting || !raw.trim()) return;
    // (One-word guesses are handled by the server: some people only have one name.)
    accepting = false;
    // Read-only rather than disabled: the input keeps focus, so a phone's
    // keyboard stays open between people instead of closing and reopening.
    guessInput.readOnly = true;

    let res;
    try {
      res = await api.guess(raw);
    } catch (err) {
      showError(err);
      accepting = true;
      guessInput.readOnly = false;
      return;
    }
    state = res.state;

    if (res.needs_full_name) {
      feedbackEl.textContent = "Skriv både för- och efternamn.";
      feedbackEl.className = "feedback wrong";
      accepting = true;
      guessInput.readOnly = false;
      guessInput.focus();
      return;
    }

    if (res.correct) {
      setScore(state.score, true);
      feedbackEl.textContent = `${res.answer.name} – rätt!`;
      feedbackEl.className = "feedback correct";
      guessCapsule.classList.add("pulse-correct");
      setTimeout(() => guessCapsule.classList.remove("pulse-correct"), 550);

      if (state.status === "playing") {
        setTimeout(() => {
          showTip();
          showPerson(state.person);
        }, 850);
      } else {
        setTimeout(() => showCard({ answer: res.answer, perfect: true }), 900);
      }
    } else {
      feedbackEl.textContent = "Fel svar.";
      feedbackEl.className = "feedback wrong";
      const last = { day: state.day, guess: raw.trim(), answer: res.answer };
      saveLastMiss(last);
      setTimeout(() => showCard(last), 700);
    }
  }

  // ---------- Daily card ----------
  function leaderboardHtml(rows) {
    if (!api.online) {
      return `<p class="board-note">Offlineläge – koppla in Supabase i <code>config.js</code> för att tävla på en gemensam topplista.</p>`;
    }
    if (!rows.length) {
      return `<p class="board-note">Ingen har spelat idag än. Bli först!</p>`;
    }
    return `<ol class="board">${rows.map((r) => `
      <li class="${r.me ? "me" : ""}">
        <span class="board-rank">${r.rank}</span>
        <span class="board-name">${escapeHtml(r.username)}${r.me ? " <em>(du)</em>" : ""}</span>
        ${r.playing ? `<span class="board-live" title="Spelar fortfarande">spelar</span>` : ""}
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
      ? `<p class="board-note">Kunde inte ladda topplistan.</p>`
      : leaderboardHtml(rows);

    const s = state;
    let html = `<p class="card-eyebrow">Dagens runda · ${escapeHtml(formatDay(s.day))}</p>`;

    if (s.status === "new") {
      setTimeout(() => {
        const input = document.getElementById("nameInput");
        if (input && !input.value) input.focus();
      }, 50);
      html += `
        <label class="card-lead" for="nameInput">Välj ditt namn för dagens runda</label>
        <div class="card-name">
          <input class="name-input" id="nameInput" type="text" maxlength="24" autocomplete="nickname"
                 spellcheck="false" placeholder="Ditt namn" value="${escapeHtml(s.username || savedName())}" />
        </div>
        <p class="name-error" id="nameError" role="alert"></p>
        <p class="card-rules">Du får <strong>en runda per dag</strong>. Alla får samma personer i samma ordning. Nämn så många du kan i rad med <strong>för- och efternamn</strong> (små stavfel är okej) – en felgissning avslutar rundan. En 💡-ledtråd per runda.</p>
        <button class="primary-btn" id="startBtn" type="button">Starta dagens runda</button>`;
    } else if (s.status === "playing") {
      html += `
        <p class="card-lead">Din runda pågår</p>
        <h1>${escapeHtml(s.username)}</h1>
        <p class="card-rules">Du har <strong>${s.score}</strong> i rad. Fortsätt där du slutade.</p>
        <button class="primary-btn" id="startBtn" type="button">Fortsätt rundan</button>`;
    } else {
      // The miss that ended the run: just now, or remembered from earlier today.
      const miss = extra.answer ? extra : (loadLastMiss(s.day) || {});
      const a = miss.answer;
      const st = s.standing || { rank: 1, players: 1 };
      if (extra.perfect) {
        html += `<p class="card-lead good">Perfekt runda – du kunde alla!</p>`;
      } else if (a) {
        html += `
          <p class="card-lead bad">${extra.answer ? "Rundan är slut" : `Du har spelat idag, ${escapeHtml(s.username)}`}</p>
          <div class="guess-compare">
            ${miss.guess ? `<div class="guess-row wrong"><span>Du gissade</span><strong>${escapeHtml(miss.guess)}</strong></div>` : ""}
            <div class="guess-row right"><span>Rätt svar</span><strong>${escapeHtml(a.name)}</strong></div>
          </div>
          <p class="card-sub">Född ${formatYear(a.born.year)} i ${escapeHtml(a.born.place)}, död ${formatYear(a.died.year)} i ${escapeHtml(a.died.place)}.</p>`;
      } else {
        html += `<p class="card-lead">Du har spelat idag, ${escapeHtml(s.username)}</p>`;
      }
      html += `
        <div class="card-stats">
          <div><span class="card-stat-num">${s.score}</span><span class="card-stat-label">i rad</span></div>
          ${api.online ? `<div><span class="card-stat-num">#${st.rank}</span><span class="card-stat-label">av ${st.players} idag</span></div>` : ""}
        </div>
        <p class="card-next">Nästa runda om <strong id="countdown">${countdownText()}</strong></p>`;
    }

    html += `<div class="card-board"><p class="board-title">Dagens topplista</p>${board}</div>`;
    card.innerHTML = html;
    overlay.hidden = false;

    const startBtn = document.getElementById("startBtn");
    if (startBtn) startBtn.addEventListener("click", startRun);
    const nameInput = document.getElementById("nameInput");
    if (nameInput) {
      nameInput.addEventListener("input", () => {
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

  // The guess that ended today's run, so the card can still show it after a reload.
  function saveLastMiss(miss) {
    try { localStorage.setItem("hg_last_miss", JSON.stringify(miss)); } catch (e) { /* private mode etc. */ }
  }
  function loadLastMiss(day) {
    try {
      const m = JSON.parse(localStorage.getItem("hg_last_miss") || "null");
      return m && m.day === day ? m : null;
    } catch (e) { return null; }
  }

  // The player's name is remembered for the next days.
  function savedName() {
    try { return localStorage.getItem("hg_name") || ""; } catch (e) { return ""; }
  }
  function saveName(name) {
    try { localStorage.setItem("hg_name", name); } catch (e) { /* private mode etc. */ }
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
        errorEl.textContent = name ? window.HG_NAME_RULES : "Välj ett namn för att starta";
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
      saveName(state.username);
      playerChip.textContent = state.username;
      playerChip.hidden = false;
    }

    try {
      state = await api.start();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Kunde inte starta – försök igen";
      return;
    }
    overlay.hidden = true;
    clearInterval(countdownTimer);
    showTip();
    setScore(state.score);
    if (state.status === "playing") showPerson(state.person);
    else showCard();
  }

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

  function refit() {
    map.invalidateSize({ animate: false });
    if (bornMarker && deathMarker) {
      fitToBounds(L.latLngBounds([bornMarker.getLatLng(), deathMarker.getLatLng()]));
      layoutMarkers();
    }
  }

  // ---------- Phones: keyboard and touch ----------
  // Everything the player sees lives in #app, which is sized and placed to
  // match the part of the screen that's actually visible (the "visual
  // viewport"). When a phone keyboard opens, the visible part shrinks: #app
  // shrinks with it, the guess box stays just above the keyboard, and the pins
  // are refitted into the space that's left. iPhones only shrink the visual
  // viewport; Android resizes the page (viewport meta tag) — both end up here.
  const appEl = document.getElementById("app");
  const vv = window.visualViewport;
  let fullHeight = 0;
  let syncQueued = false;

  const typing = () => document.activeElement && document.activeElement.tagName === "INPUT";

  function syncViewport() {
    syncQueued = false;
    const height = vv ? vv.height : window.innerHeight;
    const offsetTop = vv ? vv.offsetTop : 0;
    if (!typing() || !fullHeight) fullHeight = Math.max(fullHeight, height, window.innerHeight);
    appEl.style.height = `${Math.round(height)}px`;
    appEl.style.transform = offsetTop ? `translateY(${Math.round(offsetTop)}px)` : "";
    document.body.classList.toggle("keyboard-open", typing() && height < fullHeight * 0.8);
    refit();
  }

  function queueSync() {
    if (syncQueued) return;
    syncQueued = true;
    requestAnimationFrame(syncViewport);
  }

  if (vv) {
    vv.addEventListener("resize", queueSync);
    vv.addEventListener("scroll", queueSync);
  }
  window.addEventListener("resize", queueSync);
  window.addEventListener("orientationchange", () => { fullHeight = 0; setTimeout(queueSync, 300); });
  // Keyboards animate in and out; sync again once they've settled.
  document.addEventListener("focusin", () => { queueSync(); setTimeout(queueSync, 350); });
  document.addEventListener("focusout", () => { queueSync(); setTimeout(queueSync, 350); });
  // The map area itself can change size (e.g. while the card is open).
  if (window.ResizeObserver) new ResizeObserver(queueSync).observe(mapEl);

  // The page must never move: no dragging, rubber-banding or pinch zoom.
  // Only the card (which can be taller than a small screen) may scroll.
  document.addEventListener("touchmove", (e) => {
    if (e.touches.length > 1 || !e.target.closest(".overlay-card")) e.preventDefault();
  }, { passive: false });
  document.addEventListener("gesturestart", (e) => e.preventDefault());
  document.addEventListener("dblclick", (e) => e.preventDefault());
  window.addEventListener("scroll", () => { if (window.scrollY || window.scrollX) window.scrollTo(0, 0); });

  // ---------- Boot ----------
  async function boot() {
    setPlaying(false);
    card.innerHTML = `<p class="card-lead">Laddar dagens runda…</p>`;
    overlay.hidden = false;
    try {
      state = await api.today();
    } catch (err) {
      card.innerHTML = `
        <p class="card-lead bad">Kunde inte nå spelservern</p>
        <p class="card-sub">${escapeHtml(err.message)}</p>
        <button class="primary-btn" id="retryBtn" type="button">Försök igen</button>`;
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

  syncViewport();
  boot();
})();
