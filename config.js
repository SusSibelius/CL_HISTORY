// Connect the game to your Supabase project to turn on the shared daily
// leaderboard. Both values are under Project Settings → API in Supabase.
// The anon key is meant to be public; the database only lets it call the
// game's functions (see supabase/schema.sql).
//
// Leave them empty to play offline: same daily rules, but no leaderboard.
window.HG_CONFIG = {
  supabaseUrl: "",
  supabaseAnonKey: "",
};
