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

-- One row per device per day. It is created when the player first opens the
-- game that day, gets the name the player picks, and becomes a run when started.
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
-- Players choose their own name before starting, so it is empty until then.
alter table public.runs alter column username drop not null;

-- Words that aren't allowed in player names. Add your own any time:
--   insert into hg_private.name_filter (word, whole_word) values ('example', true);
-- whole_word = false: blocked anywhere in the name, even run together with
--   other words or split up ("f.u.c.k", "fuuuck", "f4ck" are caught too).
-- whole_word = true: only blocked as a word of its own (plus plural -s/-es),
--   for short words hiding inside ordinary names (Cassandra, Essex, Dickens).
create table if not exists hg_private.name_filter (
  word        text primary key check (word ~ '^[a-z]+$'),
  whole_word  boolean not null default false
);
alter table hg_private.name_filter enable row level security;

insert into hg_private.name_filter (word, whole_word) values
  -- English, blocked anywhere
  ('fuck', false), ('cunt', false), ('nigger', false), ('nigga', false), ('faggot', false),
  ('whore', false), ('slut', false), ('bitch', false), ('hitler', false), ('pedophile', false),
  ('paedophile', false), ('dildo', false), ('blowjob', false), ('handjob', false), ('jizz', false),
  ('wank', false), ('retard', false), ('porn', false), ('asshole', false), ('arsehole', false),
  ('bastard', false), ('shit', false), ('vagina', false), ('pussy', false), ('penis', false),
  ('boner', false), ('twat', false), ('bollock', false), ('motherf', false), ('molest', false),
  ('heilhitler', false), ('siegheil', false), ('killyourself', false), ('kys', true),
  ('phuck', false), ('fcuk', false), ('fvck', false), ('fuk', true), ('fck', true), ('stfu', true),
  -- English, whole word only
  ('ass', true), ('arse', true), ('anal', true), ('anus', true), ('dick', true), ('cock', true),
  ('cum', true), ('tit', true), ('tits', true), ('sex', true), ('sexy', true), ('rape', true),
  ('rapist', true), ('pedo', true), ('paedo', true), ('nazi', true), ('fag', true), ('piss', true),
  ('kkk', true), ('nsfw', true), ('xxx', true), ('milf', true), ('horny', true), ('nude', true),
  ('nudes', true), ('hoe', true), ('negro', true), ('coon', true), ('spic', true), ('chink', true),
  ('kike', true), ('wetback', true), ('tranny', true),
  -- Swedish, blocked anywhere
  ('fitta', false), ('knull', false), ('runka', false), ('kuksug', false), ('horunge', false),
  ('javla', false), ('neger', false), ('subba', false), ('slyna', false),
  -- Swedish, whole word only
  ('hora', true), ('kuk', true), ('porr', true), ('bog', true), ('mongo', true), ('cp', true)
on conflict (word) do nothing;

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

-- Edit distance counting a swap of two neighbouring letters as one edit
-- ("khalo" → "kahlo" is 1), so common typos stay cheap.
create or replace function hg_private.typo_distance(a text, b text) returns int
language plpgsql immutable as $$
declare
  la int := char_length(a);
  lb int := char_length(b);
  w int := lb + 1;
  d int[];
  i int;
  j int;
begin
  if la = 0 then return lb; end if;
  if lb = 0 then return la; end if;
  d := array_fill(0, array[(la + 1) * w]);
  -- d[i*w + j + 1] = distance between the first i letters of a and first j of b
  for i in 0..la loop d[i * w + 1] := i; end loop;
  for j in 0..lb loop d[j + 1] := j; end loop;
  for i in 1..la loop
    for j in 1..lb loop
      d[i * w + j + 1] := least(
        d[(i - 1) * w + j + 1] + 1,
        d[i * w + j] + 1,
        d[(i - 1) * w + j] + case when substr(a, i, 1) = substr(b, j, 1) then 0 else 1 end);
      if i > 1 and j > 1 and substr(a, i, 1) = substr(b, j - 1, 1) and substr(a, i - 1, 1) = substr(b, j, 1) then
        d[i * w + j + 1] := least(d[i * w + j + 1], d[(i - 2) * w + j - 1] + 1);
      end if;
    end loop;
  end loop;
  return d[la * w + lb + 1];
end
$$;

-- Does a (normalized) guess match a (normalized) accepted answer, allowing
-- small typos? Compared word by word: words of 1–2 letters must be exact,
-- 3–6 letters may have 1 typo, longer words 2. If the spacing differs
-- ("davinci" vs "da vinci"), the names are compared without spaces instead,
-- allowing 1 typo.
create or replace function hg_private.answer_matches(g text, a text) returns boolean
language plpgsql immutable as $$
declare
  gw text[] := regexp_split_to_array(g, '\s+');
  aw text[] := regexp_split_to_array(a, '\s+');
  i int;
  allowed int;
begin
  if g = '' then return false; end if;
  if array_length(gw, 1) = array_length(aw, 1) then
    for i in 1..array_length(aw, 1) loop
      allowed := case when char_length(aw[i]) <= 2 then 0 when char_length(aw[i]) <= 6 then 1 else 2 end;
      if hg_private.typo_distance(gw[i], aw[i]) > allowed then
        return false;
      end if;
    end loop;
    return true;
  end if;
  return hg_private.typo_distance(replace(g, ' ', ''), replace(a, ' ', '')) <= 1;
end
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

drop function if exists hg_private.random_name();

-- True if the name contains a word from hg_private.name_filter. Checks the name
-- with accents removed and digits read as letters (0→o, 1→i or l, 3→e, 4→a,
-- 5→s, 7→t, 8→b), and tolerates repeated letters ("fuuuck").
create or replace function hg_private.name_blocked(p_name text) returns boolean
language plpgsql stable as $$
declare
  base text := lower(extensions.unaccent(coalesce(p_name, '')));
  v text;
  squashed text;
  f record;
  pat text;
begin
  foreach v in array array[translate(base, '0134578', 'oieastb'), translate(base, '0134578', 'oleastb')] loop
    squashed := regexp_replace(v, '[^a-z]', '', 'g');
    for f in select word, whole_word from hg_private.name_filter loop
      pat := regexp_replace(f.word, '(.)', '\1+', 'g');
      if f.whole_word then
        pat := '^' || pat || '(e?s)?$';
        if squashed ~ pat or exists (select 1 from regexp_split_to_table(v, '[^a-z]+') t where t ~ pat) then
          return true;
        end if;
      elsif squashed ~ pat then
        return true;
      end if;
    end loop;
  end loop;
  return false;
end
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

-- Today's state for this device; creates today's (still nameless) row if needed.
create or replace function public.hg_today(p_device uuid) returns json
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare r public.runs;
begin
  if p_device is null then raise exception 'device required'; end if;
  insert into public.runs (day, device_id)
  values (hg_private.today(), p_device)
  on conflict (day, device_id) do nothing;
  select * into r from public.runs where day = hg_private.today() and device_id = p_device;
  return hg_private.state(r);
end
$$;

drop function if exists public.hg_reroll_name(uuid);

-- The player picks their name; only allowed before today's run has started.
-- Names are Latin letters (accents are fine), unique per day ignoring case, and
-- must pass the word filter.
create or replace function public.hg_set_name(p_device uuid, p_name text) returns json
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  r public.runs;
  n text := regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g');
begin
  if char_length(n) < 2 or char_length(n) > 24
     or lower(extensions.unaccent(n)) !~ '^[a-z0-9 ._''-]+$' or n !~ '[[:alnum:]]' then
    raise exception 'Use 2–24 characters: letters, numbers, spaces and . _ '' -';
  end if;
  if hg_private.name_blocked(n) then
    raise exception 'That name isn''t allowed — please choose another';
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
  if exists (select 1 from public.runs where day = hg_private.today() and device_id = p_device
             and started_at is null and username is null) then
    raise exception 'Choose a name first';
  end if;
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

  -- First and last name are required. A one-word guess doesn't count as a
  -- wrong answer (and isn't checked, so it doesn't reveal anything).
  if array_length(regexp_split_to_array(hg_private.norm(p_guess), '\s+'), 1) < 2
     and array_length(regexp_split_to_array(hg_private.norm(p.name), '\s+'), 1) >= 2 then
    return json_build_object('needs_full_name', true, 'state', hg_private.state(r));
  end if;

  ok := exists (select 1 from unnest(p.answers || p.name) a
                where hg_private.answer_matches(hg_private.norm(p_guess), hg_private.norm(a)));

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

-- The guess box no longer suggests names, so the list of people isn't exposed.
drop function if exists public.hg_names();

-- Only the public API is callable with the anonymous key.
revoke all on all functions in schema hg_private from public, anon, authenticated;
revoke usage on schema hg_private from public, anon, authenticated;
grant execute on function
  public.hg_today(uuid), public.hg_set_name(uuid, text), public.hg_start(uuid),
  public.hg_guess(uuid, text), public.hg_hint(uuid),
  public.hg_leaderboard(uuid, int)
to anon, authenticated;
