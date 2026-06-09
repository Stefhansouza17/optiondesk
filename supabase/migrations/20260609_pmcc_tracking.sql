-- PMCC tracking foundation for OptionDesk.
-- This migration is intentionally schema-only. It does not modify existing data.

create extension if not exists pgcrypto;

create table if not exists pmcc_cycles (
  id uuid primary key default gen_random_uuid(),
  asset_id text not null references assets(id) on delete cascade,
  leap_id text references leaps(id) on delete set null,
  cycle_number integer not null,
  opened_at date,
  closed_at date,
  status text not null default 'open',
  short_trade_id uuid references trades(id) on delete set null,
  closing_trade_id uuid references trades(id) on delete set null,
  roll_from_cycle_id uuid references pmcc_cycles(id) on delete set null,
  roll_to_cycle_id uuid references pmcc_cycles(id) on delete set null,
  opening_premium numeric default 0,
  closing_debit numeric default 0,
  net_premium numeric default 0,
  contracts integer not null default 1,
  strike numeric,
  expiration date,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists premium_events (
  id uuid primary key default gen_random_uuid(),
  asset_id text not null references assets(id) on delete cascade,
  leap_id text references leaps(id) on delete set null,
  cycle_id uuid references pmcc_cycles(id) on delete set null,
  trade_id uuid references trades(id) on delete set null,
  event_type text not null,
  amount numeric not null default 0,
  contracts integer not null default 1,
  date date,
  source text,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists roll_events (
  id uuid primary key default gen_random_uuid(),
  asset_id text not null references assets(id) on delete cascade,
  leap_id text references leaps(id) on delete set null,
  from_cycle_id uuid references pmcc_cycles(id) on delete set null,
  to_cycle_id uuid references pmcc_cycles(id) on delete set null,
  close_trade_id uuid references trades(id) on delete set null,
  open_trade_id uuid references trades(id) on delete set null,
  roll_date date,
  old_strike numeric,
  old_expiration date,
  old_close_debit numeric default 0,
  new_strike numeric,
  new_expiration date,
  new_open_credit numeric default 0,
  net_roll_credit numeric default 0,
  contracts integer not null default 1,
  roll_type text,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists position_health_snapshots (
  id uuid primary key default gen_random_uuid(),
  asset_id text not null references assets(id) on delete cascade,
  leap_id text references leaps(id) on delete set null,
  cycle_id uuid references pmcc_cycles(id) on delete set null,
  date date not null default current_date,
  underlying_price numeric,
  short_strike numeric,
  short_delta numeric,
  short_dte integer,
  distance_to_strike_pct numeric,
  extrinsic_value numeric,
  intrinsic_risk numeric,
  health_score integer,
  health_state text,
  created_at timestamptz not null default now()
);

create index if not exists idx_pmcc_cycles_asset on pmcc_cycles(asset_id);
create index if not exists idx_pmcc_cycles_leap on pmcc_cycles(leap_id);
create index if not exists idx_premium_events_asset on premium_events(asset_id);
create index if not exists idx_roll_events_asset on roll_events(asset_id);
create index if not exists idx_position_health_asset on position_health_snapshots(asset_id);
