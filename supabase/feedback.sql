-- Stylish Care App — reply feedback loop.
-- Captures, per AI-assisted send, how much the agent changed the AI draft.
-- LIGHTWEIGHT: full texts (ai_draft / sent_text) are stored ONLY when the
-- reply was actually edited; sent-as-is rows keep just the metrics.
-- Paste into the Supabase SQL Editor and run.

create table if not exists reply_feedback (
  id            bigint generated always as identity primary key,
  ticket_id     text,
  ticket_number text,
  intent        text,
  confidence    text,
  lane          text,
  sensitive     boolean,
  kb_covered    boolean,
  kb_used       jsonb,
  ai_chars      int,
  sent_chars    int,
  edit_ratio    real,        -- 0 = identical, 1 = fully rewritten
  edit_class    text,        -- as_is | light | heavy
  ai_draft      text,        -- only when edited (class != as_is)
  sent_text     text,        -- only when edited
  created_at    timestamptz default now()
);

create index if not exists reply_feedback_created_idx on reply_feedback (created_at);
create index if not exists reply_feedback_intent_idx  on reply_feedback (intent);

-- Aggregated metrics for the dashboard (last N days).
create or replace function reply_feedback_metrics(num_days int default 90)
returns json language sql stable as $$
  with recent as (
    select * from reply_feedback
    where created_at >= now() - (num_days || ' days')::interval
  )
  select json_build_object(
    'total',        (select count(*) from recent),
    'asIs',         (select count(*) from recent where edit_class = 'as_is'),
    'light',        (select count(*) from recent where edit_class = 'light'),
    'heavy',        (select count(*) from recent where edit_class = 'heavy'),
    'avgEditRatio', (select avg(edit_ratio) from recent),
    'byIntent', (
      select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
        select intent,
               count(*)                                    as total,
               count(*) filter (where edit_class = 'as_is') as as_is,
               count(*) filter (where edit_class = 'heavy') as heavy,
               avg(edit_ratio)                              as avg_edit
        from recent
        where intent is not null
        group by intent
        order by count(*) desc
      ) t
    )
  );
$$;
