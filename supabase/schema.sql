-- Stylish Care App — Supabase schema
-- Paste this whole file into the Supabase SQL Editor and run it once.

-- 1) pgvector for semantic search
create extension if not exists vector;

-- 2) Knowledge Base articles + their embedding (768-dim, gemini-embedding-001)
create table if not exists kb_articles (
  id          text primary key,
  title       text,
  body        text,
  finish      text,
  tags        jsonb default '[]'::jsonb,
  source      text not null,          -- manual | web | dropbox | zoho-template | youtube
  source_url  text,
  updated_at  timestamptz,
  embedding   vector(768)
);

create index if not exists kb_articles_source_idx on kb_articles (source);

-- 3) Semantic match: top-k KB articles by cosine similarity to a query vector.
--    Vectors are L2-normalized, so cosine distance (<=>) is exact here.
create or replace function match_kb_articles(
  query_embedding vector(768),
  match_count int default 8
)
returns table (
  id text,
  title text,
  body text,
  finish text,
  tags jsonb,
  source text,
  source_url text,
  score float
)
language sql stable
as $$
  select
    a.id, a.title, a.body, a.finish, a.tags, a.source, a.source_url,
    1 - (a.embedding <=> query_embedding) as score
  from kb_articles a
  where a.embedding is not null
  order by a.embedding <=> query_embedding
  limit match_count;
$$;

-- 4) Keyword fallback used when embeddings are unavailable.
create or replace function search_kb_articles(
  q text,
  match_count int default 8
)
returns setof kb_articles
language sql stable
as $$
  select *
  from kb_articles
  where title ilike '%' || q || '%' or body ilike '%' || q || '%'
  limit match_count;
$$;
