(function () {
  "use strict";

  // ---------- State ----------
  let streak = 0;
  let bestStreak = Number(localStorage.getItem("hg_best") || 0);
  let usedIndices = [];
  let currentPerson = null;
  let lifelineUsed = false;
  let bornMarker, deathMarker;
  let accepting = true;

  // ---------- DOM ----------
  const streakNumEl = document.getElementById("streakNum");
  const lifelineBtn = document.getElementById("lifelineBtn");
  const guessCapsule = document.getElementById("guessCapsule");
  const guessForm = document.getElementById("guessForm");
  const guessInput = document.getElementById("guessInput");
  const suggestionsEl = document.getElementById("suggestions");
  const feedbackEl = document.getElementById("feedback");
  const overlay = document.getElementById("gameOverOverlay");
  const overlayAnswer = document.getElementById("overlayAnswer");
  const overlaySub = document.getElementById("overlaySub");
  const finalStreakEl = document.getElementById("finalStreak");
  const bestStreakEl = document.getElementById("bestStreak");
  const playAgainBtn = document.getElementById("playAgainBtn");

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

  // ---------- Round flow ----------
  function pickNextPerson() {
    if (usedIndices.length >= PEOPLE.length) usedIndices = [];
    let idx;
    do {
      idx = Math.floor(Math.random() * PEOPLE.length);
    } while (usedIndices.includes(idx));
    usedIndices.push(idx);
    return PEOPLE[idx];
  }

  function startRound() {
    accepting = true;
    feedbackEl.textContent = "";
    feedbackEl.className = "feedback";
    guessInput.value = "";
    guessInput.disabled = false;
    hideSuggestions();

    currentPerson = pickNextPerson();

    if (bornMarker) map.removeLayer(bornMarker);
    if (deathMarker) map.removeLayer(deathMarker);

    const b = currentPerson.born;
    const d = currentPerson.died;

    bornMarker = L.marker([b.lat, b.lng], { icon: makeIcon(b.year, "born"), keyboard: false }).addTo(map);
    deathMarker = L.marker([d.lat, d.lng], { icon: makeIcon(d.year, "died"), keyboard: false }).addTo(map);

    const bounds = L.latLngBounds([[b.lat, b.lng], [d.lat, d.lng]]);
    fitToBounds(bounds);
    layoutMarkers();

    guessInput.focus();
  }

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

  function endRun(correctAnswerShown) {
    accepting = false;
    guessInput.disabled = true;
    if (streak > bestStreak) {
      bestStreak = streak;
      localStorage.setItem("hg_best", String(bestStreak));
    }
    overlayAnswer.textContent = currentPerson.name;
    overlaySub.textContent = correctAnswerShown
      ? `Born ${currentPerson.born.year} in ${currentPerson.born.place}, died ${currentPerson.died.year} in ${currentPerson.died.place}.`
      : "";
    finalStreakEl.textContent = String(streak);
    bestStreakEl.textContent = String(bestStreak);
    setTimeout(() => {
      overlay.style.display = "flex";
    }, 700);
  }

  function handleGuess(raw) {
    if (!accepting || !raw.trim()) return;
    const guess = normalize(raw);
    const isCorrect = currentPerson.answers.some((a) => normalize(a) === guess);

    if (isCorrect) {
      streak += 1;
      streakNumEl.textContent = String(streak);
      streakNumEl.classList.add("bump");
      setTimeout(() => streakNumEl.classList.remove("bump"), 250);

      feedbackEl.textContent = `${currentPerson.name} — correct.`;
      feedbackEl.className = "feedback correct";

      guessCapsule.classList.add("pulse-correct");
      setTimeout(() => guessCapsule.classList.remove("pulse-correct"), 550);

      accepting = false;
      guessInput.disabled = true;
      setTimeout(startRound, 850);
    } else {
      feedbackEl.textContent = "Not quite.";
      feedbackEl.className = "feedback wrong";
      endRun(true);
    }
  }

  // ---------- Autocomplete ----------
  function hideSuggestions() {
    suggestionsEl.hidden = true;
    suggestionsEl.innerHTML = "";
  }

  function showSuggestions(query) {
    const q = normalize(query);
    if (!q) return hideSuggestions();
    const matches = PEOPLE
      .filter((p) => normalize(p.name).includes(q))
      .slice(0, 6);
    if (!matches.length) return hideSuggestions();

    suggestionsEl.innerHTML = matches
      .map((p) => `<div class="suggestion-item" data-name="${p.name}">${p.name}</div>`)
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

  lifelineBtn.addEventListener("click", () => {
    if (lifelineUsed || !accepting) return;
    lifelineUsed = true;
    lifelineBtn.disabled = true;
    feedbackEl.textContent = `💡 ${currentPerson.hint}`;
    feedbackEl.className = "feedback hint";
    guessInput.focus();
  });

  playAgainBtn.addEventListener("click", () => {
    overlay.style.display = "none";
    streak = 0;
    streakNumEl.textContent = "0";
    lifelineUsed = false;
    lifelineBtn.disabled = false;
    usedIndices = [];
    startRound();
  });

  window.addEventListener("resize", () => {
    map.invalidateSize();
    if (bornMarker && deathMarker) {
      fitToBounds(L.latLngBounds([bornMarker.getLatLng(), deathMarker.getLatLng()]));
      layoutMarkers();
    }
  });

  // ---------- Boot ----------
  startRound();
})();
