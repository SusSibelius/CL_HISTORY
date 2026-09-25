-- Historiegissare — daily multiplayer backend (Supabase / Postgres).
--
-- Run this whole file once in the Supabase SQL editor, then run seed.sql.
-- It is safe to re-run: functions are replaced, tables are only created if missing.
--
-- Everything the browser can do goes through the public functions below.
-- The tables have row level security switched on and no policies, so the
-- anonymous key can't read answers or write scores directly.

create schema if not exists extensions;
create extension if not exists unaccent with schema extensions;
create extension if not exists pgcrypto with schema extensions;

create schema if not exists hg_private;

-- ---------- Tables ----------

create table if not exists public.people (
  id          serial primary key,
  name        text    not null unique,
  answers     text[]  not null,
  hint        text    not null,
  born_year   int     not null,
  born_lat    float8  not null,
  born_lng    float8  not null,
  born_place  text    not null,
  died_year   int     not null,
  died_lat    float8  not null,
  died_lng    float8  not null,
  died_place  text    not null
);

-- One row per device per day. It is created (with a generated username) when
-- the player first opens the game that day, and becomes a run when started.
create table if not exists public.runs (
  id           uuid primary key default extensions.gen_random_uuid(),
  day          date not null,
  device_id    uuid not null,
  username     text not null,
  score        int  not null default 0,
  hint_used    boolean not null default false,
  started_at   timestamptz,
  finished_at  timestamptz,
  unique (day, device_id)
);
create index if not exists runs_day_score on public.runs (day, score desc);

alter table public.people enable row level security;
alter table public.runs   enable row level security;
revoke all on public.people, public.runs from anon, authenticated;

-- ---------- Private helpers (not exposed through the API) ----------

create or replace function hg_private.today() returns date
language sql stable as $$
  select (now() at time zone 'utc')::date
$$;

-- Same rules as normalize() in the browser: lowercase, strip accents and
-- punctuation, trim.
create or replace function hg_private.norm(t text) returns text
language sql stable as $$
  select trim(regexp_replace(extensions.unaccent(lower(coalesce(t, ''))), '[^a-z0-9\s]', '', 'g'))
$$;

-- Today's shuffled order is the same for every player: sort by a hash of the
-- day and the person id.
create or replace function hg_private.person_at(p_day date, p_pos int) returns public.people
language sql stable as $$
  select p.* from public.people p
  order by md5(p_day::text || ':' || p.id::text)
  offset p_pos limit 1
$$;

-- What the map needs, and nothing that gives the answer away.
create or replace function hg_private.clue(p public.people) returns json
language sql stable as $$
  select json_build_object(
    'born', json_build_object('year', p.born_year, 'lat', p.born_lat, 'lng', p.born_lng),
    'died', json_build_object('year', p.died_year, 'lat', p.died_lat, 'lng', p.died_lng)
  )
$$;

create or replace function hg_private.reveal(p public.people) returns json
language sql stable as $$
  select json_build_object(
    'name', p.name,
    'born', json_build_object('year', p.born_year, 'place', p.born_place),
    'died', json_build_object('year', p.died_year, 'place', p.died_place)
  )
$$;

create or replace function hg_private.random_name() returns text
language sql volatile as $$
  select (array['Curious','Bold','Wandering','Quiet','Brave','Clever','Swift','Patient',
                'Lucky','Keen','Gentle','Restless','Sharp','Humble','Daring','Merry'])[1 + floor(random() * 16)::int]
      || ' ' ||
         (array['Cartographer','Archivist','Chronicler','Navigator','Scribe','Explorer','Historian','Pilgrim',
                'Voyager','Scholar','Herald','Alchemist','Astronomer','Wanderer','Curator','Bard'])[1 + floor(random() * 16)::int]
      || ' ' || (10 + floor(random() * 90)::int)::text
$$;

-- Rank among everyone who has started a run that day (1 = best).
create or replace function hg_private.rank_of(r public.runs) returns json
language sql stable as $$
  select json_build_object(
    'rank',    (select count(*) + 1 from public.runs o
                 where o.day = r.day and o.started_at is not null and o.score > r.score),
    'players', (select count(*) from public.runs o
                 where o.day = r.day and o.started_at is not null)
  )
$$;

create or replace function hg_private.state(r public.runs) returns json
language plpgsql stable as $$
declare
  total int := (select count(*) from public.people);
  st text := case when r.finished_at is not null then 'finished'
                  when r.started_at  is not null then 'playing'
                  else 'new' end;
begin
  return json_build_object(
    'day',       r.day,
    'username',  r.username,
    'status',    st,
    'score',     r.score,
    'hint_used', r.hint_used,
    'total',     total,
    'person',    case when st = 'playing' then hg_private.clue(hg_private.person_at(r.day, r.score)) end,
    'standing',  case when st <> 'new' then hg_private.rank_of(r) end
  );
end
$$;

-- The device's run that is in progress. Also finds yesterday's run, so a run
-- that crosses midnight UTC can still be finished.
create or replace function hg_private.active_run(p_device uuid) returns public.runs
language sql stable as $$
  select * from public.runs
  where device_id = p_device and started_at is not null and finished_at is null
    and day >= hg_private.today() - 1
  order by day desc limit 1
$$;

-- ---------- Public API (called by the browser) ----------

-- Today's state for this device; creates today's row with a username if needed.
create or replace function public.hg_today(p_device uuid) returns json
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare r public.runs;
begin
  if p_device is null then raise exception 'device required'; end if;
  insert into public.runs (day, device_id, username)
  values (hg_private.today(), p_device, hg_private.random_name())
  on conflict (day, device_id) do nothing;
  select * into r from public.runs where day = hg_private.today() and device_id = p_device;
  return hg_private.state(r);
end
$$;

-- Pick another username; only allowed before today's run has started.
create or replace function public.hg_reroll_name(p_device uuid) returns json
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare r public.runs;
begin
  update public.runs set username = hg_private.random_name()
  where day = hg_private.today() and device_id = p_device and started_at is null
  returning * into r;
  if r.id is null then raise exception 'run already started'; end if;
  return hg_private.state(r);
end
$$;

-- Let the player choose their own name; only allowed before today's run has
-- started. Names are unique per day (ignoring case).
create or replace function public.hg_set_name(p_device uuid, p_name text) returns json
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  r public.runs;
  n text := regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g');
begin
  if char_length(n) < 2 or char_length(n) > 24
     or n !~ '^[[:alnum:] ._''-]+$' or n !~ '[[:alnum:]]' then
    raise exception 'Use 2–24 characters: letters, numbers, spaces and . _ '' -';
  end if;
  perform public.hg_today(p_device);
  if exists (select 1 from public.runs
             where day = hg_private.today() and device_id <> p_device and lower(username) = lower(n)) then
    raise exception 'Someone already has that name today — try another';
  end if;
  update public.runs set username = n
  where day = hg_private.today() and device_id = p_device and started_at is null
  returning * into r;
  if r.id is null then raise exception 'run already started'; end if;
  return hg_private.state(r);
end
$$;

create or replace function public.hg_start(p_device uuid) returns json
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare r public.runs;
begin
  perform public.hg_today(p_device);
  update public.runs set started_at = now()
  where day = hg_private.today() and device_id = p_device and started_at is null;
  select * into r from public.runs where day = hg_private.today() and device_id = p_device;
  return hg_private.state(r);
end
$$;

create or replace function public.hg_guess(p_device uuid, p_guess text) returns json
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  r public.runs := hg_private.active_run(p_device);
  p public.people;
  total int := (select count(*) from public.people);
  ok boolean;
begin
  if r.id is null then raise exception 'no run in progress'; end if;
  select * into r from public.runs where id = r.id for update;
  if r.finished_at is not null then raise exception 'no run in progress'; end if;

  p := hg_private.person_at(r.day, r.score);
  ok := hg_private.norm(p_guess) <> ''
        and exists (select 1 from unnest(p.answers) a where hg_private.norm(a) = hg_private.norm(p_guess));

  if ok then
    update public.runs set score = score + 1,
           finished_at = case when score + 1 >= total then now() end
    where id = r.id returning * into r;
  else
    update public.runs set finished_at = now() where id = r.id returning * into r;
  end if;

  return json_build_object(
    'correct', ok,
    'answer',  hg_private.reveal(p),
    'state',   hg_private.state(r)
  );
end
$$;

-- One hint per run, for the current person.
create or replace function public.hg_hint(p_device uuid) returns json
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare r public.runs := hg_private.active_run(p_device);
begin
  if r.id is null then raise exception 'no run in progress'; end if;
  if r.hint_used then raise exception 'hint already used'; end if;
  update public.runs set hint_used = true where id = r.id;
  return json_build_object('hint', (hg_private.person_at(r.day, r.score)).hint);
end
$$;

-- Today's top scores. Runs still in progress are included and marked.
create or replace function public.hg_leaderboard(p_device uuid, p_limit int default 20) returns json
language sql stable security definer set search_path = public, pg_temp as $$
  with ranked as (
    select username, score, finished_at is null as playing, device_id = p_device as me,
           rank() over (order by score desc) as rank,
           row_number() over (order by score desc, coalesce(finished_at, 'infinity'), started_at) as n
    from public.runs
    where day = hg_private.today() and started_at is not null
  )
  select coalesce(json_agg(json_build_object(
           'rank', rank, 'username', username, 'score', score, 'playing', playing, 'me', me)
         order by n), '[]'::json)
  from ranked
  where n <= least(greatest(p_limit, 1), 100) or me
$$;

-- Names for the guess box's autocomplete (the whole pool, in no useful order).
create or replace function public.hg_names() returns json
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(json_agg(name order by name), '[]'::json) from public.people
$$;

-- Only the public API is callable with the anonymous key.
revoke all on all functions in schema hg_private from public, anon, authenticated;
revoke usage on schema hg_private from public, anon, authenticated;
grant execute on function
  public.hg_today(uuid), public.hg_reroll_name(uuid), public.hg_set_name(uuid, text), public.hg_start(uuid),
  public.hg_guess(uuid, text), public.hg_hint(uuid),
  public.hg_leaderboard(uuid, int), public.hg_names()
to anon, authenticated;
