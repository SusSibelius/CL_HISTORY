// Connect the game to your Supabase project to turn on the shared daily
// leaderboard. Both values are under Project Settings → API in Supabase.
// The anon key is meant to be public; the database only lets it call the
// game's functions (see supabase/schema.sql).
//
// Leave them empty to play offline: same daily rules, but no leaderboard.
window.HG_CONFIG = {
  supabaseUrl: "https://lpsadlmektsudiqefodz.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imxwc2FkbG1la3RzdWRpcWVmb2R6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAzMzgzMTEsImV4cCI6MjEwNTkxNDMxMX0.p0_UeqmYLB8DT5utIPL5CsOw8G3ruM4XLuwx9IJ6uv0",
};
