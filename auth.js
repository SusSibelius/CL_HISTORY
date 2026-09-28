// Optional accounts: log in with a link sent by email (Supabase Auth), to keep
// statistics and achievements. Playing as a guest needs none of this.
//
// Flow: sendLink(email) → Supabase emails a link → the link opens the game
// with the session in the URL (#access_token=…) → handleRedirect() stores it.
// The session is kept in localStorage and refreshed before it expires.
(function () {
  "use strict";

  const cfg = window.HG_CONFIG || {};
  const base = (cfg.supabaseUrl || "").replace(/\/$/, "");
  const key = cfg.supabaseAnonKey;
  const KEY = "hg_session";

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) { return null; }
  }
  function save(s) {
    try {
      if (s) localStorage.setItem(KEY, JSON.stringify(s));
      else localStorage.removeItem(KEY);
    } catch (e) { /* private mode etc. */ }
  }

  let session = load();

  async function call(path, opts) {
    const res = await fetch(`${base}/auth/v1/${path}`, {
      ...opts,
      headers: { apikey: key, "Content-Type": "application/json", ...(opts && opts.headers) },
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = (body && (body.msg || body.error_description || body.message)) || `Fel ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  function fromTokens(t, user) {
    return {
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_at: Date.now() + (Number(t.expires_in) || 3600) * 1000,
      user: user ? { id: user.id, email: user.email } : null,
    };
  }

  // Where the email link should bring the player back to: this page.
  const here = () => location.origin + location.pathname;

  const api = {
    enabled: Boolean(base && key),

    user: () => (session && session.user) || null,

    // Send a login link. New emails get an account automatically.
    async sendLink(email) {
      try {
        await call(`otp?redirect_to=${encodeURIComponent(here())}`, {
          method: "POST",
          body: JSON.stringify({ email, create_user: true }),
        });
      } catch (err) {
        if (err.status === 429) throw new Error("För många försök – vänta en stund och försök igen.");
        throw new Error(`Kunde inte skicka länken: ${err.message}`);
      }
    },

    // Called on page load: picks up the session from a login link.
    // Returns "login" (just logged in), "error" (link failed) or null.
    async handleRedirect() {
      const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
      const clean = () => history.replaceState(null, "", location.pathname + location.search);
      if (hash.get("error") || hash.get("error_description")) {
        clean();
        api.lastError = hash.get("error_description") || hash.get("error");
        return "error";
      }
      if (!hash.get("access_token")) return null;
      clean();
      const tokens = { access_token: hash.get("access_token"), refresh_token: hash.get("refresh_token"), expires_in: hash.get("expires_in") };
      try {
        const user = await call("user", { headers: { Authorization: `Bearer ${tokens.access_token}` } });
        session = fromTokens(tokens, user);
        save(session);
        return "login";
      } catch (err) {
        api.lastError = "Inloggningslänken fungerade inte – den kan ha gått ut. Försök igen.";
        return "error";
      }
    },

    // A valid access token, refreshed if it's about to expire; null for guests.
    async token(forceRefresh) {
      if (!session) return null;
      if (forceRefresh || Date.now() > session.expires_at - 60 * 1000) {
        try {
          const t = await call("token?grant_type=refresh_token", {
            method: "POST",
            body: JSON.stringify({ refresh_token: session.refresh_token }),
          });
          session = fromTokens(t, t.user || session.user);
          save(session);
        } catch (err) {
          // The session can't be renewed: continue as a guest.
          session = null;
          save(null);
          return null;
        }
      }
      return session.access_token;
    },

    async signOut() {
      const token = session && session.access_token;
      session = null;
      save(null);
      if (token) {
        try { await call("logout", { method: "POST", headers: { Authorization: `Bearer ${token}` } }); } catch (e) { /* already gone */ }
      }
    },
  };

  window.HG_AUTH = api;
})();
