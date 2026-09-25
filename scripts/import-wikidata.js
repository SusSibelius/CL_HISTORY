// Builds data.js from Wikidata: the most famous people who have died and whose
// birth and death places have map coordinates. Fame = how many Wikipedia (and
// sister project) language editions have an article about the person; the game
// uses it to make each daily run start easy and get harder.
//
// Usage:  node scripts/import-wikidata.js [count]      (default 2000)
// Then:   node scripts/build-seed.js   and run the seed files in Supabase.
"use strict";

const fs = require("fs");
const path = require("path");
const { normalize, words, answerMatches } = require("../match.js");

const ENDPOINT = "https://query.wikidata.org/sparql";
const USER_AGENT = "Historiegissare-import/1.0 (https://github.com/SusSibelius/CL_HISTORY)";
const TARGET = Number(process.argv[2]) || 2000;
const MIN_FAME = 40;          // only consider people with at least this many sitelinks
const BATCH = 150;            // people per detail query

// ---------- Wikidata ----------

// Responses are cached for a day in the system temp folder.
const CACHE = path.join(require("os").tmpdir(), "historiegissare-wikidata-cache.json");
let cache = {};
try {
  const c = JSON.parse(fs.readFileSync(CACHE, "utf8"));
  if (Date.now() - c.time < 24 * 3600 * 1000) cache = c.entries;
} catch (e) { /* no cache yet */ }
function saveCache() {
  fs.writeFileSync(CACHE, JSON.stringify({ time: Date.now(), entries: cache }));
}

async function sparql(query) {
  const key = require("crypto").createHash("sha1").update(query).digest("hex");
  if (!cache[key]) {
    cache[key] = await sparqlFetch(query);
    saveCache();
  }
  return cache[key];
}

async function sparqlFetch(query, attempt = 1) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/sparql-results+json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "query=" + encodeURIComponent(query),
  });
  if (!res.ok) {
    if (attempt < 4 && (res.status === 429 || res.status >= 500)) {
      const wait = Number(res.headers.get("retry-after")) * 1000 || 5000 * attempt;
      console.log(`  Wikidata answered ${res.status}, retrying in ${wait / 1000}s…`);
      await new Promise((r) => setTimeout(r, wait));
      return sparqlFetch(query, attempt + 1);
    }
    throw new Error(`Wikidata query failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()).results.bindings;
}

const qid = (uri) => uri.slice(uri.lastIndexOf("/") + 1);
const val = (b, k) => (b[k] ? b[k].value : null);

// Candidates: humans who have died, with coordinates for both places, ranked by fame.
async function fetchCandidates() {
  const rows = await sparql(`
    SELECT ?p ?links WHERE {
      ?p wikibase:sitelinks ?links . hint:Prior hint:rangeSafe true .
      FILTER(?links >= ${MIN_FAME})
      ?p wdt:P31 wd:Q5 ; wdt:P570 ?death ; wdt:P19/wdt:P625 ?bc ; wdt:P20/wdt:P625 ?dc .
    }`);
  const fame = new Map();
  for (const r of rows) fame.set(qid(r.p.value), Number(r.links.value));
  return [...fame.entries()].sort((a, b) => b[1] - a[1]).map(([id, links]) => ({ id, fame: links }));
}

async function fetchDetails(ids) {
  const values = ids.map((id) => "wd:" + id).join(" ");
  const main = await sparql(`
    SELECT ?p ?label ?svLabel ?desc ?birth ?bprec ?death ?dprec
           ?bpLabel ?bcoord ?bcLabel ?baLabel ?dpLabel ?dcoord ?dcLabel ?daLabel WHERE {
      VALUES ?p { ${values} }
      ?p rdfs:label ?label . FILTER(lang(?label) = "en")
      OPTIONAL { ?p rdfs:label ?svLabel . FILTER(lang(?svLabel) = "sv") }
      OPTIONAL { ?p schema:description ?desc . FILTER(lang(?desc) = "en") }
      ?p wdt:P569 ?birth ; p:P569/psv:P569 [ wikibase:timeValue ?birth ; wikibase:timePrecision ?bprec ] .
      ?p wdt:P570 ?death ; p:P570/psv:P570 [ wikibase:timeValue ?death ; wikibase:timePrecision ?dprec ] .
      ?p wdt:P19 ?bp . ?bp wdt:P625 ?bcoord . OPTIONAL { ?bp wdt:P17 ?bc . } OPTIONAL { ?bp wdt:P131 ?ba . }
      ?p wdt:P20 ?dp . ?dp wdt:P625 ?dcoord . OPTIONAL { ?dp wdt:P17 ?dc . } OPTIONAL { ?dp wdt:P131 ?da . }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en".
        ?bp rdfs:label ?bpLabel . ?dp rdfs:label ?dpLabel . ?bc rdfs:label ?bcLabel . ?dc rdfs:label ?dcLabel .
        ?ba rdfs:label ?baLabel . ?da rdfs:label ?daLabel . }
    }`);
  const alts = await sparql(`
    SELECT ?p ?alt WHERE {
      VALUES ?p { ${values} }
      ?p skos:altLabel ?alt . FILTER(lang(?alt) = "en")
    }`);
  const jobs = await sparql(`
    SELECT ?p ?jobLabel WHERE {
      VALUES ?p { ${values} }
      ?p wdt:P106 ?job .
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". ?job rdfs:label ?jobLabel . }
    }`);

  const byId = new Map();
  for (const r of main) {
    const id = qid(r.p.value);
    if (!byId.has(id)) byId.set(id, { id, rows: [], alts: [], jobs: [] });
    byId.get(id).rows.push(r);
  }
  for (const r of alts) byId.get(qid(r.p.value))?.alts.push(val(r, "alt"));
  for (const r of jobs) byId.get(qid(r.p.value))?.jobs.push(val(r, "jobLabel"));
  return byId;
}

// ---------- Cleaning ----------

// Wikidata writes 44 BC as year -43 (there is a year 0); we store -44.
function year(iso) {
  const m = /^([+-]?)(\d+)-/.exec(iso || "");
  if (!m) return null;
  const y = Number(m[2]) * (m[1] === "-" ? -1 : 1);
  return y <= 0 ? y - 1 : y;
}

function point(wkt) {
  const m = /Point\(([-\d.eE]+) ([-\d.eE]+)\)/.exec(wkt || "");
  if (!m) return null;
  const lng = Number(m[1]), lat = Number(m[2]);
  if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) return null;
  return { lat: Math.round(lat * 1e4) / 1e4, lng: Math.round(lng * 1e4) / 1e4 };
}

const isQid = (s) => !s || /^Q\d+$/.test(s);

// Buildings and the like get the town they're in added, so the reveal reads
// "UCLA Medical Center, Los Angeles, United States".
const BUILDING = /\b(hospital|clinic|cl[ií]nica|medical|cent(er|re)|infirmary|sanatorium|palace|castle|abbey|monastery|convent|church|cathedral|house|hall|bunker|estate|manor|villa|hotel|prison|residence|apartment|farm|school|university|college|barracks|camp|ship|mansion|château|chateau|schloss|palazzo|tower|fortress|court|garden)\b/i;

function placeName(place, admin, country, personName) {
  if (isQid(place)) return isQid(country) ? null : country;
  // Street addresses and places named after the person ("Birthplace of
  // Ronald Reagan") are replaced by the town they're in.
  const nameWords = words(normalize(personName)).filter((w) => w.length >= 4);
  if (/\d/.test(place) || /^(birthplace|home|house) of\b/i.test(place) ||
      words(normalize(place)).some((w) => nameWords.includes(w))) {
    if (!isQid(admin)) place = admin;
    else if (/\d/.test(place) && !isQid(country)) return country;  // a bare street address
  }
  const parts = [place];
  if (BUILDING.test(place) && !isQid(admin) && admin !== country && !place.includes(admin)) parts.push(admin);
  if (!isQid(country) && place !== country && !place.includes(country)) parts.push(country);
  return parts.join(", ");
}

// Names must be written in the Latin alphabet (accents are fine).
const latin = (s) => /^[\p{Script=Latin}\p{M}\d .,'’()-]+$/u.test(s);

// A hint must not give away the name, and must not contain the years.
function makeHint(desc, jobs, name) {
  let h = (desc || "").replace(/\([^)]*\)/g, " ");
  // Cut the description where the first year appears: "French Emperor 1804–1814
  // and again in 1815" → "French Emperor".
  const firstYear = h.search(/\b(from |between |since |until |in |c\. |ca\. |circa )?\d{3,4}\b/i);
  if (firstYear > 10) h = h.slice(0, firstYear);
  h = h.replace(/\b(c\.|ca\.|circa|born|died|fl\.)?\s*\d{1,4}(s|\s*(BC|BCE|AD|CE))?\b/gi, " ");
  h = h.replace(/[–—-]\s*(?=[,;]|$)/g, " ").replace(/\s+,/g, ",").replace(/\s+/g, " ").trim();
  // Words left dangling by removing the years ("ruler from to", "in the").
  for (let i = 0; i < 3; i++) {
    h = h.replace(/\b(from|between|since|until|in|to|and|during)\s+(?=(to|and|until|,|;|$))/gi, "")
      .replace(/\s+(from|between|since|until|to|and|in|of|the|during)\s*$/i, "")
      .replace(/\s+,/g, ",").replace(/\s+/g, " ").trim();
  }
  h = h.replace(/^[,;:\s-]+|[,;:\s-]+$/g, "");
  if (h.length < 4 && jobs.length) h = [...new Set(jobs)].filter((j) => !isQid(j)).slice(0, 2).join(", ");
  if (!h) return "No description available";
  const nameWords = new Set(words(normalize(name)).filter((w) => w.length >= 4));
  h = h.split(" ").map((w) => (nameWords.has(normalize(w)) ? "…" : w)).join(" ");
  return h.charAt(0).toUpperCase() + h.slice(1);
}

function toPerson(d, fame) {
  const r = d.rows[0];
  const name = val(r, "label").replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (!latin(name)) return { skip: "name not in Latin alphabet" };

  const bPrec = Math.max(...d.rows.map((x) => Number(val(x, "bprec"))));
  const dPrec = Math.max(...d.rows.map((x) => Number(val(x, "dprec"))));
  if (bPrec < 9 || dPrec < 9) return { skip: "birth/death year not known exactly" };
  const born = year(val(r, "birth")), died = year(val(r, "death"));
  if (born == null || died == null || died < born || died - born > 110) return { skip: "implausible dates" };

  const bc = point(val(r, "bcoord")), dc = point(val(r, "dcoord"));
  const bPlace = placeName(val(r, "bpLabel"), val(r, "baLabel"), val(r, "bcLabel"), name);
  const dPlace = placeName(val(r, "dpLabel"), val(r, "daLabel"), val(r, "dcLabel"), name);
  if (!bc || !dc || !bPlace || !dPlace) return { skip: "missing place" };

  // Accepted answers: the English and Swedish names, plus English aliases that
  // are full names (at least two words, unless the person is known by one name)
  // and share a word with the English name — that keeps "M. K. Gandhi" and
  // "Napoleon I" but drops nicknames ("Father of the Nation") and odd
  // transliterations from other languages.
  const oneWord = words(normalize(name)).length === 1;
  const nameWords = words(normalize(name)).filter((w) => w.length >= 3);
  const sharesWord = (n) => words(n).some((w) => nameWords.some((l) => answerMatches(w, l)));
  const answers = [];
  const svLabel = val(r, "svLabel");
  for (const a of [name, svLabel, ...d.alts]) {
    if (!a || !latin(a) || a.length > 40) continue;
    const n = normalize(a.replace(/\([^)]*\)/g, ""));
    if (!n || (!oneWord && words(n).length < 2) || answers.includes(n)) continue;
    if (a !== name && a !== svLabel && !sharesWord(n)) continue;
    answers.push(n);
  }

  return {
    person: {
      name,
      answers,
      hint: makeHint(val(r, "desc"), d.jobs, name),
      fame,
      wikidata: d.id,
      born: { year: born, ...bc, place: bPlace },
      died: { year: died, ...dc, place: dPlace },
    },
  };
}

// ---------- Ambiguity check ----------

// Two people must never be guessable with the same answer (typos included).
// Aliases that clash are dropped; if the main names clash, the less famous
// person is dropped. One pass: first find
// every clashing pair, then resolve them most-famous first.
function resolveClashes(people) {
  const compact = (s) => s.replace(/ /g, "");
  const entries = [];
  people.forEach((p, i) =>
    [normalize(p.name), ...p.answers].forEach((a) => entries.push({ i, a, main: a === normalize(p.name), len: compact(a).length }))
  );
  entries.sort((x, y) => x.len - y.len);

  // Two answers can only match if their lengths are close (at most a few typos).
  const pairs = [];
  for (let x = 0; x < entries.length; x++) {
    for (let y = x + 1; y < entries.length && entries[y].len - entries[x].len <= 4; y++) {
      const A = entries[x], B = entries[y];
      if (A.i !== B.i && (answerMatches(A.a, B.a) || answerMatches(B.a, A.a))) pairs.push([A, B]);
    }
  }
  const fameOf = (e) => people[e.i].fame;
  pairs.sort((u, v) => Math.max(fameOf(v[0]), fameOf(v[1])) - Math.max(fameOf(u[0]), fameOf(u[1])));

  const gone = new Set();
  const dropped = [];
  const removeAlias = (e) => { people[e.i].answers = people[e.i].answers.filter((s) => s !== e.a); };
  for (const [A, B] of pairs) {
    if (gone.has(A.i) || gone.has(B.i)) continue;
    const pa = people[A.i], pb = people[B.i];
    const aLive = A.main || pa.answers.includes(A.a), bLive = B.main || pb.answers.includes(B.a);
    if (!aLive || !bLive) continue;
    if (!A.main) removeAlias(A);
    else if (!B.main) removeAlias(B);
    else {
      const loser = pa.fame >= pb.fame ? B : A;
      const winner = loser === A ? B : A;
      gone.add(loser.i);
      dropped.push(`${people[loser.i].name} (clashes with ${people[winner.i].name})`);
    }
  }
  const kept = people.filter((_, i) => !gone.has(i));
  people.length = 0;
  people.push(...kept);
  return dropped;
}

// ---------- Main ----------

async function main() {
  console.log("Finding candidates on Wikidata…");
  const candidates = await fetchCandidates();
  console.log(`  ${candidates.length} people with at least ${MIN_FAME} sitelinks`);

  const people = [];
  const skipped = {};

  for (let start = 0; start < candidates.length && people.length < TARGET * 1.05; start += BATCH) {
    const chunk = candidates.slice(start, start + BATCH);
    process.stdout.write(`Fetching details ${start + 1}–${start + chunk.length}…`);
    const details = await fetchDetails(chunk.map((c) => c.id));
    for (const c of chunk) {
      const d = details.get(c.id);
      if (!d) { skipped["incomplete data on Wikidata"] = (skipped["incomplete data on Wikidata"] || 0) + 1; continue; }
      const r = toPerson(d, c.fame);
      if (r.skip) skipped[r.skip] = (skipped[r.skip] || 0) + 1;
      else people.push(r.person);
    }
    console.log(` ${people.length} kept`);
  }

  console.log("Checking that no two people can be confused…");
  const dropped = resolveClashes(people);
  people.sort((a, b) => b.fame - a.fame);
  const out = people.slice(0, TARGET);
  const header = `// Generated by scripts/import-wikidata.js from Wikidata (CC0) on ${new Date().toISOString().slice(0, 10)}
// — don't edit by hand: change the import script and re-run it.
// ${out.length} people, most famous first. fame = number of Wikipedia/sister-project
// language editions with an article; the game uses it to order runs from easy to hard.
`;
  const body = "const PEOPLE = [\n" + out.map((p) => "  " + JSON.stringify(p)).join(",\n") + "\n];\n";
  fs.writeFileSync(path.join(__dirname, "..", "data.js"), header + body);

  console.log(`\nWrote data.js with ${out.length} people (fame ${out[0].fame} … ${out[out.length - 1].fame}).`);
  console.log("Skipped:", skipped);
  if (dropped.length) console.log(`Dropped ${dropped.length} for name clashes:\n  ` + dropped.join("\n  "));
}

main().catch((e) => { console.error(e); process.exit(1); });
