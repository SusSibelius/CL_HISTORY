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
-- How famous the person is (number of Wikipedia/sister-project language
-- editions with an article, from Wikidata). Runs go from famous to obscure.
alter table public.people add column if not exists fame int not null default 0;
alter table public.people add column if not exists wikidata text;

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
  finished_at  timestamptz
);
create index if not exists runs_day_score on public.runs (day, score desc);
-- Players choose their own name before starting, so it is empty until then.
alter table public.runs alter column username drop not null;

-- ---------- Accounts (optional) ----------
-- Players can play as guests (a run per browser per day, as before) or log in
-- with an email link to keep statistics and achievements. A logged-in
-- player's runs belong to their account: one run per day per account, on any
-- device.
alter table public.runs add column if not exists user_id uuid references auth.users(id) on delete set null;
alter table public.runs drop constraint if exists runs_day_device_id_key;
create unique index if not exists runs_guest_day on public.runs (day, device_id) where user_id is null;
create unique index if not exists runs_user_day on public.runs (day, user_id) where user_id is not null;

-- An account's name, reserved so guests can't play under it.
create table if not exists public.profiles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  username    text,
  created_at  timestamptz not null default now()
);
create unique index if not exists profiles_username on public.profiles (lower(username));

-- Every guess, for statistics and achievements.
create table if not exists public.guesses (
  id          bigserial primary key,
  run_id      uuid not null references public.runs(id) on delete cascade,
  pos         int not null,
  person_id   int not null,
  correct     boolean not null,
  guess       text,
  created_at  timestamptz not null default now()
);
create index if not exists guesses_run on public.guesses (run_id);

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

alter table public.people   enable row level security;
alter table public.runs     enable row level security;
alter table public.profiles enable row level security;
alter table public.guesses  enable row level security;
revoke all on public.people, public.runs, public.profiles, public.guesses from anon, authenticated;

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

-- Words that must be typed exactly: numbers and Roman numerals.
create or replace function hg_private.exact_word() returns text
language sql immutable as $$
  select '^([0-9]+|m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3}))$'
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
      -- Roman numerals and numbers must be exact (Louis XIV isn't Louis XV).
      allowed := case when char_length(aw[i]) <= 2 or aw[i] ~ hg_private.exact_word() then 0
                      when char_length(aw[i]) <= 6 then 1 else 2 end;
      if hg_private.typo_distance(gw[i], aw[i]) > allowed then
        return false;
      end if;
    end loop;
    return true;
  end if;
  if exists (select 1 from unnest(aw) w where w ~ hg_private.exact_word()) then return false; end if;
  return hg_private.typo_distance(replace(g, ' ', ''), replace(a, ' ', '')) <= 1;
end
$$;

-- A number in [0, 1) from a hash of the text: the same for everyone on a day.
create or replace function hg_private.unit_hash(t text) returns float8
language sql immutable as $$
  select ('x' || substr(md5(t), 1, 8))::bit(32)::bigint / 4294967296.0
$$;

-- Today's order, the same for every player. Runs go from famous to obscure:
-- people are ranked by fame, and each day every person gets a random nudge
-- (log(rank + 20) moves by at most ±1.2). The +20 lets the top ~50 mix freely
-- at the start, so runs don't open with the same people every day, while
-- someone far down the list never shows up early.
create or replace function hg_private.person_at(p_day date, p_pos int) returns public.people
language sql stable as $$
  select p.* from public.people p
  join (select id, row_number() over (order by fame desc, id) as rk from public.people) r on r.id = p.id
  order by ln(r.rk + 20) + 2.4 * (hg_private.unit_hash(p_day::text || ':' || p.id::text) - 0.5), p.id
  offset p_pos limit 1
$$;

-- What the player sees: the pins and the hint, nothing that gives the name away.
create or replace function hg_private.clue(p public.people) returns json
language sql stable as $$
  select json_build_object(
    'hint', p.hint,
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

-- Is this run the caller's? A logged-in player's runs are found by account,
-- a guest's by device.
create or replace function hg_private.is_mine(r public.runs, p_device uuid) returns boolean
language sql stable as $$
  select case when auth.uid() is null then r.user_id is null and r.device_id = p_device
              else r.user_id = auth.uid() end
$$;

-- The caller's run on a given day.
create or replace function hg_private.my_run(p_device uuid, p_day date) returns public.runs
language sql stable as $$
  select * from public.runs r
  where r.day = p_day and hg_private.is_mine(r, p_device)
  limit 1
$$;

-- Today's run for the caller, created if needed. A logged-in player who
-- hasn't played today takes over this device's guest row for today (if any).
create or replace function hg_private.ensure_today(p_device uuid) returns public.runs
language plpgsql volatile as $$
declare
  r public.runs;
  uid uuid := auth.uid();
begin
  if p_device is null then raise exception 'Enhets-id saknas'; end if;
  r := hg_private.my_run(p_device, hg_private.today());
  if r.id is not null then
    -- Keep an account's name on a run that hasn't started.
    if uid is not null and r.started_at is null then
      update public.runs set username = coalesce((select username from public.profiles where user_id = uid), username)
      where id = r.id returning * into r;
    end if;
    return r;
  end if;
  if uid is null then
    insert into public.runs (day, device_id) values (hg_private.today(), p_device)
    on conflict (day, device_id) where user_id is null do nothing;
  else
    update public.runs set user_id = uid,
           username = coalesce((select username from public.profiles where user_id = uid), username)
    where day = hg_private.today() and device_id = p_device and user_id is null;
    if not found then
      insert into public.runs (day, device_id, user_id, username)
      values (hg_private.today(), p_device, uid, (select username from public.profiles where user_id = uid))
      on conflict (day, user_id) where user_id is not null do nothing;
    end if;
  end if;
  return hg_private.my_run(p_device, hg_private.today());
end
$$;

-- The caller's run that is in progress. Also finds yesterday's run, so a run
-- that crosses midnight UTC can still be finished.
create or replace function hg_private.active_run(p_device uuid) returns public.runs
language sql stable as $$
  select * from public.runs r
  where hg_private.is_mine(r, p_device) and r.started_at is not null and r.finished_at is null
    and r.day >= hg_private.today() - 1
  order by r.day desc limit 1
$$;

-- ---------- Public API (called by the browser) ----------

-- Today's state for this device; creates today's (still nameless) row if needed.
create or replace function public.hg_today(p_device uuid) returns json
language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  return hg_private.state(hg_private.ensure_today(p_device));
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
    raise exception 'Använd 2–24 tecken: bokstäver, siffror, mellanslag och . _ '' -';
  end if;
  if hg_private.name_blocked(n) then
    raise exception 'Det namnet är inte tillåtet – välj ett annat';
  end if;
  r := hg_private.ensure_today(p_device);
  if r.started_at is not null then raise exception 'Rundan har redan startat'; end if;
  -- Names of accounts are reserved for their owners.
  if exists (select 1 from public.profiles
             where lower(username) = lower(n) and user_id is distinct from auth.uid()) then
    raise exception 'Det namnet tillhör ett konto – välj ett annat';
  end if;
  if exists (select 1 from public.runs
             where day = hg_private.today() and id <> r.id and lower(username) = lower(n)) then
    raise exception 'Någon har redan det namnet idag – välj ett annat';
  end if;
  -- A logged-in player's name is their account's name from now on.
  if auth.uid() is not null then
    insert into public.profiles (user_id, username) values (auth.uid(), n)
    on conflict (user_id) do update set username = excluded.username;
  end if;
  update public.runs set username = n where id = r.id returning * into r;
  return hg_private.state(r);
end
$$;

create or replace function public.hg_start(p_device uuid) returns json
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare r public.runs;
begin
  r := hg_private.ensure_today(p_device);
  if r.started_at is null and r.username is null then
    raise exception 'Välj ett namn först';
  end if;
  update public.runs set started_at = coalesce(started_at, now()) where id = r.id returning * into r;
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
  if r.id is null then raise exception 'Ingen runda pågår'; end if;
  select * into r from public.runs where id = r.id for update;
  if r.finished_at is not null then raise exception 'Ingen runda pågår'; end if;

  p := hg_private.person_at(r.day, r.score);

  -- One word (a surname, "Beethoven") is enough for most people. For those
  -- where it isn't — surnames shared by several people, "Johannes Paulus II" —
  -- a one-word guess doesn't count as a wrong answer: the player is asked for
  -- the full name (and nothing is revealed).
  if array_length(regexp_split_to_array(hg_private.norm(p_guess), '\s+'), 1) < 2
     and not exists (select 1 from unnest(p.answers || p.name) a
                     where array_length(regexp_split_to_array(hg_private.norm(a), '\s+'), 1) = 1) then
    return json_build_object('needs_full_name', true, 'state', hg_private.state(r));
  end if;

  ok := exists (select 1 from unnest(p.answers || p.name) a
                where hg_private.answer_matches(hg_private.norm(p_guess), hg_private.norm(a)));
  -- Small typos are forgiven, but the exact name of someone else in the game
  -- never counts ("Chopin" isn't a typo of "Chaplin").
  if ok
     and not exists (select 1 from unnest(p.answers || p.name) a
                     where hg_private.norm(a) = hg_private.norm(p_guess))
     and exists (select 1 from public.people o, unnest(o.answers || o.name) a
                 where o.id <> p.id and hg_private.norm(a) = hg_private.norm(p_guess)) then
    ok := false;
  end if;

  insert into public.guesses (run_id, pos, person_id, correct, guess)
  values (r.id, r.score, p.id, ok, left(p_guess, 80));

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
  if r.id is null then raise exception 'Ingen runda pågår'; end if;
  if r.hint_used then raise exception 'Ledtråden är redan använd'; end if;
  update public.runs set hint_used = true where id = r.id;
  return json_build_object('hint', (hg_private.person_at(r.day, r.score)).hint);
end
$$;

-- Today's top scores. Runs still in progress are included and marked.
-- The run in review, once it's over: every person the player got to, in
-- order, with the pins, the hint, the answer and whether they got it right.
-- Only for a finished run, so it can't be used to look up answers.
create or replace function public.hg_recap(p_device uuid) returns json
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  r public.runs;
  total int := (select count(*) from public.people);
begin
  r := hg_private.my_run(p_device, hg_private.today());
  if r.id is null or r.finished_at is null then raise exception 'Rundan är inte slut än'; end if;
  return (
    select coalesce(json_agg(json_build_object(
             'correct', pos < r.score,
             'name', p.name,
             'hint', p.hint,
             'born', json_build_object('year', p.born_year, 'lat', p.born_lat, 'lng', p.born_lng, 'place', p.born_place),
             'died', json_build_object('year', p.died_year, 'lat', p.died_lat, 'lng', p.died_lng, 'place', p.died_place)
           ) order by pos), '[]'::json)
    from generate_series(0, least(r.score, total - 1)) pos,
         lateral hg_private.person_at(r.day, pos) p
  );
end
$$;

create or replace function public.hg_leaderboard(p_device uuid, p_limit int default 20) returns json
language sql stable security definer set search_path = public, pg_temp as $$
  with ranked as (
    select username, score, finished_at is null as playing,
           id = (hg_private.my_run(p_device, hg_private.today())).id as me,
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

-- ---------- Accounts: claim guest runs, statistics, achievements ----------

-- After logging in: this browser's guest runs become the account's (for days
-- the account hasn't played), and the account gets the name last used here if
-- it has none yet and nobody else has it.
create or replace function public.hg_claim(p_device uuid) returns json
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid uuid := auth.uid();
  n int;
  last_name text;
begin
  if uid is null then raise exception 'Inte inloggad'; end if;
  insert into public.profiles (user_id) values (uid) on conflict (user_id) do nothing;
  update public.runs g set user_id = uid
  where g.device_id = p_device and g.user_id is null
    and not exists (select 1 from public.runs u where u.user_id = uid and u.day = g.day);
  get diagnostics n = row_count;
  select username into last_name from public.runs
  where user_id = uid and username is not null order by day desc limit 1;
  update public.profiles set username = last_name
  where user_id = uid and username is null and last_name is not null
    and not exists (select 1 from public.profiles o where lower(o.username) = lower(last_name) and o.user_id <> uid);
  return json_build_object('claimed', n, 'username', (select username from public.profiles where user_id = uid));
end
$$;

-- Rough continent of a birthplace, for the "Världsresenär" achievement.
create or replace function hg_private.continent(lat float8, lng float8) returns text
language sql immutable as $$
  select case
    when lat between -56 and 13 and lng between -82 and -34 then 'Sydamerika'
    when lng between -170 and -50 and lat > 7 then 'Nordamerika'
    when lat between -50 and 0 and lng between 110 and 180 then 'Oceanien'
    when lat between 35 and 72 and lng between -25 and 45 then 'Europa'
    when lat between -35 and 37.5 and (lng between -20 and 33 or (lng between 33 and 52 and lat < 12)) then 'Afrika'
    when lng between 25 and 180 then 'Asien'
    else 'Övrigt' end
$$;

-- Everything for the profile view: numbers, the spread of results, recent
-- runs and achievements (with progress).
create or replace function public.hg_stats() returns json
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  uid uuid := auth.uid();
  total int := (select count(*) from public.people);
  v_played int; v_best int; v_avg numeric; v_correct int; v_perfect int;
  v_cur int; v_long int;
  v_ancient int; v_medieval int; v_continents int;
begin
  if uid is null then raise exception 'Inte inloggad'; end if;

  select count(*), coalesce(max(score), 0), round(avg(score)::numeric, 1), coalesce(sum(score), 0),
         count(*) filter (where score >= total)
    into v_played, v_best, v_avg, v_correct, v_perfect
  from public.runs where user_id = uid and finished_at is not null;

  -- Days in a row with a run: the current streak (ending today or yesterday)
  -- and the longest ever.
  with days as (select distinct day from public.runs where user_id = uid and started_at is not null),
       islands as (select day, day - (row_number() over (order by day))::int as grp from days),
       streaks as (select count(*) as len, max(day) as last_day from islands group by grp)
  select coalesce((select len from streaks where last_day >= hg_private.today() - 1 order by last_day desc limit 1), 0),
         coalesce((select max(len) from streaks), 0)
    into v_cur, v_long;

  select count(*) filter (where p.born_year < 0),
         count(*) filter (where p.born_year between 500 and 1499),
         count(distinct hg_private.continent(p.born_lat, p.born_lng)) filter (where hg_private.continent(p.born_lat, p.born_lng) <> 'Övrigt')
    into v_ancient, v_medieval, v_continents
  from public.guesses g join public.runs r on r.id = g.run_id join public.people p on p.id = g.person_id
  where r.user_id = uid and g.correct;

  return json_build_object(
    'username', (select username from public.profiles where user_id = uid),
    'played', v_played,
    'best', v_best,
    'average', coalesce(v_avg, 0),
    'total_correct', v_correct,
    'current_days', v_cur,
    'longest_days', v_long,
    'distribution', (
      select json_agg(json_build_object('label', b.label, 'count',
               (select count(*) from public.runs
                where user_id = uid and finished_at is not null and score between b.lo and b.hi)) order by b.lo)
      from (values ('0', 0, 0), ('1–2', 1, 2), ('3–5', 3, 5), ('6–10', 6, 10), ('11–20', 11, 20), ('21+', 21, 1000000)) b(label, lo, hi)
    ),
    'history', (
      select coalesce(json_agg(json_build_object('day', x.day, 'score', x.score, 'standing', hg_private.rank_of(x)) order by x.day desc), '[]'::json)
      from (select * from public.runs where user_id = uid and finished_at is not null order by day desc limit 10) x
    ),
    'achievements', json_build_array(
      json_build_object('id', 'first',     'icon', '🎯', 'title', 'Första rundan',  'text', 'Spela din första runda',                    'value', least(v_played, 1),    'goal', 1),
      json_build_object('id', 'row10',     'icon', '🔥', 'title', 'Tio i rad',      'text', 'Klara 10 personer i en runda',             'value', least(v_best, 10),     'goal', 10),
      json_build_object('id', 'row25',     'icon', '⚡', 'title', 'Tjugofem i rad', 'text', 'Klara 25 personer i en runda',             'value', least(v_best, 25),     'goal', 25),
      json_build_object('id', 'row50',     'icon', '🏆', 'title', 'Femtio i rad',   'text', 'Klara 50 personer i en runda',             'value', least(v_best, 50),     'goal', 50),
      json_build_object('id', 'perfect',   'icon', '👑', 'title', 'Perfekt runda',  'text', 'Klara alla personer i en runda',           'value', least(v_perfect, 1),   'goal', 1),
      json_build_object('id', 'week',      'icon', '📅', 'title', 'En hel vecka',   'text', 'Spela 7 dagar i rad',                      'value', least(v_long, 7),      'goal', 7),
      json_build_object('id', 'month',     'icon', '🗓️', 'title', 'En hel månad',   'text', 'Spela 30 dagar i rad',                     'value', least(v_long, 30),     'goal', 30),
      json_build_object('id', 'c100',      'icon', '💯', 'title', 'Hundra rätt',    'text', 'Gissa rätt 100 gånger totalt',             'value', least(v_correct, 100), 'goal', 100),
      json_build_object('id', 'c1000',     'icon', '🧠', 'title', 'Tusen rätt',     'text', 'Gissa rätt 1 000 gånger totalt',           'value', least(v_correct, 1000),'goal', 1000),
      json_build_object('id', 'antiquity', 'icon', '🏛️', 'title', 'Antiken',        'text', 'Gissa rätt på någon född före Kristus',    'value', least(v_ancient, 1),   'goal', 1),
      json_build_object('id', 'medieval',  'icon', '🏰', 'title', 'Medeltiden',     'text', 'Gissa rätt på någon född 500–1499',        'value', least(v_medieval, 1),  'goal', 1),
      json_build_object('id', 'world',     'icon', '🌍', 'title', 'Världsresenär',  'text', 'Gissa rätt på personer födda på 5 kontinenter', 'value', least(v_continents, 5), 'goal', 5)
    )
  );
end
$$;

-- The guess box no longer suggests names, so the list of people isn't exposed.
drop function if exists public.hg_names();

-- Only the public API is callable with the anonymous key.
revoke all on all functions in schema hg_private from public, anon, authenticated;
revoke usage on schema hg_private from public, anon, authenticated;
grant execute on function
  public.hg_today(uuid), public.hg_set_name(uuid, text), public.hg_start(uuid),
  public.hg_guess(uuid, text), public.hg_hint(uuid),
  public.hg_leaderboard(uuid, int), public.hg_recap(uuid)
to anon, authenticated;
grant execute on function public.hg_claim(uuid), public.hg_stats() to authenticated;
revoke execute on function public.hg_claim(uuid), public.hg_stats() from public, anon;
