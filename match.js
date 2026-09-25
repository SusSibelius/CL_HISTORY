// How a guess is compared with a person's accepted answers. Used by the game
// in offline mode and by the scripts (import checks). The server uses the same
// rules in supabase/schema.sql (hg_private.norm / answer_matches) — keep them
// in step.
(function (root) {
  "use strict";

  // Lowercase, strip accents and punctuation, collapse spaces.
  function normalize(str) {
    return String(str || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9\s]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  const words = (s) => s.split(" ").filter(Boolean);

  // Edit distance where swapping two neighbouring letters counts as one edit.
  function typoDistance(a, b) {
    const d = [];
    for (let i = 0; i <= a.length; i++) d.push([i]);
    for (let j = 0; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
      }
    }
    return d[a.length][b.length];
  }

  // Roman numerals ("xiv") and numbers must be exact: Louis XIV isn't Louis XV.
  const EXACT = /^(\d+|m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3}))$/;

  // Typos allowed in one word of an answer.
  function allowedTypos(w) {
    if (w.length <= 2 || EXACT.test(w)) return 0;
    return w.length <= 6 ? 1 : 2;
  }

  // Does a normalized guess match a normalized answer? Word by word, with a few
  // typos per word; if the spacing differs ("davinci" vs "da vinci") the names
  // are compared without spaces, allowing 1 typo.
  function answerMatches(g, a) {
    if (!g || !a) return false;
    const gw = words(g), aw = words(a);
    if (gw.length === aw.length) {
      return aw.every((w, i) => typoDistance(gw[i], w) <= allowedTypos(w));
    }
    if (aw.some((w) => EXACT.test(w))) return false;
    return typoDistance(g.replace(/ /g, ""), a.replace(/ /g, "")) <= 1;
  }

  const api = { normalize, words, typoDistance, answerMatches };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.HG_MATCH = api;
})(this);
