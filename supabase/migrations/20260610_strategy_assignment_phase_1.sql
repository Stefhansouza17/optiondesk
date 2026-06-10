-- Strategy Assignment Phase 1.
-- Schema-only: does not migrate, mutate, or delete existing trades.

create extension if not exists pgcrypto;

create table if not exists strategies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid default auth.uid(),
  asset_id text references assets(id) on delete set null,
  ticker text not null,
  name text not null,
  strategy_type text not null,
  status text not null default 'open',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint strategies_status_check check (status in ('open','closed','archived')),
  constraint strategies_type_check check (strategy_type in (
    'Long Call',
    'Long Put',
    'Covered Call',
    'Cash Secured Put',
    'PMCC',
    'Bull Call Spread',
    'Bear Put Spread',
    'Bull Put Spread',
    'Bear Call Spread',
    'Iron Condor',
    'Straddle',
    'Strangle'
  ))
);

create table if not exists trade_strategy_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid default auth.uid(),
  trade_id uuid not null references trades(id) on delete cascade,
  strategy_id uuid not null references strategies(id) on delete cascade,
  assignment_status text not null default 'confirmed',
  assigned_at timestamptz not null default now(),
  detached_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint trade_strategy_links_status_check check (assignment_status in ('confirmed','detached'))
);

create index if not exists idx_strategies_asset on strategies(asset_id);
create index if not exists idx_strategies_ticker on strategies(ticker);
create index if not exists idx_trade_strategy_links_trade on trade_strategy_links(trade_id);
create index if not exists idx_trade_strategy_links_strategy on trade_strategy_links(strategy_id);

create unique index if not exists uq_trade_strategy_links_one_active
  on trade_strategy_links(trade_id)
  where assignment_status = 'confirmed' and detached_at is null;

alter table strategies enable row level security;
alter table trade_strategy_links enable row level security;

drop policy if exists "Strategy assignment select own or anon" on strategies;
create policy "Strategy assignment select own or anon"
  on strategies for select
  using (auth.uid() is null or user_id = auth.uid());

drop policy if exists "Strategy assignment insert own or anon" on strategies;
create policy "Strategy assignment insert own or anon"
  on strategies for insert
  with check (auth.uid() is null or user_id = auth.uid());

drop policy if exists "Strategy assignment update own or anon" on strategies;
create policy "Strategy assignment update own or anon"
  on strategies for update
  using (auth.uid() is null or user_id = auth.uid())
  with check (auth.uid() is null or user_id = auth.uid());

drop policy if exists "Strategy assignment delete own or anon" on strategies;
create policy "Strategy assignment delete own or anon"
  on strategies for delete
  using (auth.uid() is null or user_id = auth.uid());

drop policy if exists "Trade strategy links select own or anon" on trade_strategy_links;
create policy "Trade strategy links select own or anon"
  on trade_strategy_links for select
  using (auth.uid() is null or user_id = auth.uid());

drop policy if exists "Trade strategy links insert own or anon" on trade_strategy_links;
create policy "Trade strategy links insert own or anon"
  on trade_strategy_links for insert
  with check (auth.uid() is null or user_id = auth.uid());

drop policy if exists "Trade strategy links update own or anon" on trade_strategy_links;
create policy "Trade strategy links update own or anon"
  on trade_strategy_links for update
  using (auth.uid() is null or user_id = auth.uid())
  with check (auth.uid() is null or user_id = auth.uid());

drop policy if exists "Trade strategy links delete own or anon" on trade_strategy_links;
create policy "Trade strategy links delete own or anon"
  on trade_strategy_links for delete
  using (auth.uid() is null or user_id = auth.uid());
