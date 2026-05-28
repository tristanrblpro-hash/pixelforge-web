-- PixelForge — Supabase schema, Phase 0.
-- Run this in the Supabase SQL Editor (https://supabase.com/dashboard).
--
-- For Phase 0 there is no authentication: tables are world-readable so the
-- /api/history endpoint can list batches without a session. We'll tighten this
-- to per-user RLS in Phase 1 when we add Supabase Auth.

create table if not exists public.batches (
  batch_id    text primary key,
  kind        text not null,
  model       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  status      text not null default 'running',
  cost_usd    numeric not null default 0,
  meta_json   jsonb not null default '{}'::jsonb
);

create table if not exists public.items (
  item_id     text primary key,
  batch_id    text not null references public.batches(batch_id) on delete cascade,
  idx         integer not null,
  status      text not null default 'queued',
  input_url   text,
  output_url  text,
  error       text,
  kie_task_id text,
  started_at  timestamptz,
  ended_at    timestamptz
);

create index if not exists idx_items_batch  on public.items(batch_id);
create index if not exists idx_batches_kind on public.batches(kind);

-- Phase 0: tables are read-only to the public role.
alter table public.batches enable row level security;
alter table public.items   enable row level security;

drop policy if exists "phase0_read_batches" on public.batches;
drop policy if exists "phase0_read_items"   on public.items;

create policy "phase0_read_batches" on public.batches for select using (true);
create policy "phase0_read_items"   on public.items   for select using (true);
