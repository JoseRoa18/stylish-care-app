-- Stylish Care App — tickets history (synced from Zoho).
-- METADATA ONLY (no message bodies). Paste into the Supabase SQL Editor and run.

create table if not exists tickets (
  id                     text primary key,   -- Zoho ticket id
  number                 text,
  subject                text,
  status                 text,
  channel                text,
  customer_name          text,
  customer_email         text,
  created_time           timestamptz,
  modified_time          timestamptz,
  closed_time            timestamptz,
  customer_response_time timestamptz,
  web_url                text,
  synced_at              timestamptz default now()
);

create index if not exists tickets_created_idx  on tickets (created_time);
create index if not exists tickets_status_idx   on tickets (status);
create index if not exists tickets_modified_idx on tickets (modified_time);

-- ── dashboard aggregates over the WHOLE history ──────────────

-- single-row metrics object
create or replace function ticket_metrics()
returns json language sql stable as $$
  select json_build_object(
    'total',            count(*),
    'active',           count(*) filter (where status not ilike '%closed%'),
    'closed',           count(*) filter (where status ilike '%closed%'),
    'avgWaitMs',        avg(extract(epoch from (now() - customer_response_time)) * 1000)
                          filter (where status not ilike '%closed%'),
    'oldestWaitMs',     max(extract(epoch from (now() - customer_response_time)) * 1000)
                          filter (where status not ilike '%closed%'),
    'avgResolutionMs',  avg(extract(epoch from (closed_time - created_time)) * 1000)
                          filter (where status ilike '%closed%' and closed_time is not null),
    'resolvedSample',   count(*) filter (where status ilike '%closed%' and closed_time is not null)
  )
  from tickets;
$$;

create or replace function tickets_by_status()
returns table(status text, count bigint) language sql stable as $$
  select status, count(*) from tickets group by status order by count(*) desc;
$$;

create or replace function tickets_by_channel()
returns table(channel text, count bigint) language sql stable as $$
  select coalesce(channel, 'Other') as channel, count(*) from tickets group by 1 order by count(*) desc;
$$;

-- new tickets per day for the last N days (zero-filled)
create or replace function tickets_per_day(num_days int default 7)
returns table(day date, count bigint) language sql stable as $$
  select d::date as day, count(t.id) as count
  from generate_series((now() - ((num_days - 1) || ' days')::interval)::date, now()::date, '1 day') d
  left join tickets t on t.created_time::date = d::date
  group by d order by d;
$$;
