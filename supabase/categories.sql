-- Stylish Care App — issue categories on tickets.
-- Gemini labels every ticket with WHAT went wrong, so the dashboard can report
-- which problems actually drive volume (shipping, missing parts, packaging…).
-- Paste into the Supabase SQL Editor and run once.

alter table tickets add column if not exists category    text;
alter table tickets add column if not exists category_at timestamptz;

create index if not exists tickets_category_idx on tickets (category);

-- Ticket counts per category. Pass num_days = 0 for the whole history.
-- `notification` is returned like any other row; the dashboard splits it out,
-- so the count stays visible without swamping the real issues.
create or replace function tickets_by_category(num_days int default 0)
returns table(category text, count bigint) language sql stable as $$
  select coalesce(t.category, 'uncategorized') as category, count(*) as count
  from tickets t
  where num_days <= 0
     or t.created_time >= now() - (num_days || ' days')::interval
  group by 1
  order by count desc;
$$;

-- Which issues are sitting in "Awaiting Response" right now — the ball is in
-- the customer's court on these, so they are the backlog worth chasing.
create or replace function awaiting_by_category()
returns table(category text, count bigint) language sql stable as $$
  select coalesce(t.category, 'uncategorized') as category, count(*) as count
  from tickets t
  where t.status ilike 'awaiting%'
  group by 1
  order by count desc;
$$;

-- New tickets per WEEK / MONTH for the trend selector (zero-filled), mirroring
-- the existing tickets_per_day so the dashboard can switch granularity.
create or replace function tickets_per_week(num_weeks int default 8)
returns table(day date, count bigint) language sql stable as $$
  select d::date as day, count(t.id) as count
  from generate_series(
         date_trunc('week', now() - ((num_weeks - 1) || ' weeks')::interval),
         date_trunc('week', now()), '1 week') d
  left join tickets t on date_trunc('week', t.created_time) = d
  group by d order by d;
$$;

create or replace function tickets_per_month(num_months int default 6)
returns table(day date, count bigint) language sql stable as $$
  select d::date as day, count(t.id) as count
  from generate_series(
         date_trunc('month', now() - ((num_months - 1) || ' months')::interval),
         date_trunc('month', now()), '1 month') d
  left join tickets t on date_trunc('month', t.created_time) = d
  group by d order by d;
$$;

-- New tickets per day between two explicit dates, for the custom range.
create or replace function tickets_per_day_range(start_day date, end_day date)
returns table(day date, count bigint) language sql stable as $$
  select d::date as day, count(t.id) as count
  from generate_series(start_day, end_day, '1 day') d
  left join tickets t on t.created_time::date = d::date
  group by d order by d;
$$;
