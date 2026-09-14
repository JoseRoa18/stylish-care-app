-- Stylish Care App — post-resolution satisfaction survey + product model on tickets.
-- Paste into the Supabase SQL Editor and run once.

-- ── which product a ticket is about ──────────────────────────
-- Filled by matching the catalogue's real SKUs against the ticket text, so a
-- value here is a code the customer actually wrote, never a guess.
alter table tickets add column if not exists model    text;
alter table tickets add column if not exists model_at timestamptz;
create index if not exists tickets_model_idx on tickets (model);

-- ── satisfaction surveys ─────────────────────────────────────
-- One row per ticket. Created when the ticket is closed and the survey mail
-- goes out; updated in place when the customer answers, so a reminder or a
-- second close can never create a duplicate.
create table if not exists surveys (
  token          text primary key,          -- unguessable id used in the survey link
  ticket_id      text not null,
  ticket_number  text,
  customer_email text,
  customer_name  text,
  sent_at        timestamptz default now(),
  answered_at    timestamptz,
  resolved       text,                      -- yes | partly | no
  satisfaction   int,                       -- 1..5
  speed          int,                       -- 1..5
  constraint surveys_satisfaction_range check (satisfaction is null or satisfaction between 1 and 5),
  constraint surveys_speed_range        check (speed is null or speed between 1 and 5),
  constraint surveys_resolved_values    check (resolved is null or resolved in ('yes','partly','no'))
);

create unique index if not exists surveys_ticket_idx   on surveys (ticket_id);
create index if not exists        surveys_answered_idx on surveys (answered_at);
create index if not exists        surveys_sent_idx     on surveys (sent_at);

-- Headline numbers for the dashboard over the last N days.
-- `satisfaction_rate` is the share of answers rating 4 or 5 — the usual CSAT
-- definition, so it can be compared against an industry benchmark.
create or replace function survey_metrics(num_days int default 90)
returns json language sql stable as $$
  with recent as (
    select * from surveys
    where answered_at is not null
      and (num_days <= 0 or answered_at >= now() - (num_days || ' days')::interval)
  ), sent as (
    select count(*) as n from surveys
    where num_days <= 0 or sent_at >= now() - (num_days || ' days')::interval
  )
  select json_build_object(
    'sent',             (select n from sent),
    'answered',         (select count(*) from recent),
    'avgSatisfaction',  (select round(avg(satisfaction)::numeric, 2) from recent),
    'avgSpeed',         (select round(avg(speed)::numeric, 2) from recent),
    'satisfactionRate', (select case when count(*) = 0 then null
                                else round(100.0 * count(*) filter (where satisfaction >= 4) / count(*)) end
                         from recent),
    'resolvedYes',      (select count(*) from recent where resolved = 'yes'),
    'resolvedPartly',   (select count(*) from recent where resolved = 'partly'),
    'resolvedNo',       (select count(*) from recent where resolved = 'no'),
    'stars',            (select json_object_agg(satisfaction, n) from
                          (select satisfaction, count(*) as n from recent
                           where satisfaction is not null group by satisfaction) s)
  );
$$;
