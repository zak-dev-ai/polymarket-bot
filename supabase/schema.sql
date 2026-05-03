-- ============================================================
-- POLYMARKET BOT — SUPABASE SCHEMA
-- Run this in Supabase SQL Editor once after creating project
-- ============================================================

-- 1. MARKETS — BTC 5-min markets we are watching
create table if not exists markets (
  id text primary key,                    -- Polymarket condition_id
  question text not null,
  end_date_iso text,
  yes_price numeric,                      -- current market YES price (0–1)
  no_price numeric,
  volume numeric default 0,
  active boolean default true,
  last_seen_at timestamptz default now(),
  created_at timestamptz default now()
);

-- 2. SIGNALS — every signal engine evaluation
create table if not exists signals (
  id bigserial primary key,
  market_id text references markets(id),
  ts timestamptz default now(),

  -- Raw indicator values
  rsi numeric,
  ema9 numeric,
  ema21 numeric,
  bb_upper numeric,
  bb_lower numeric,
  bb_mid numeric,
  btc_price numeric,
  volume_spike boolean default false,
  candle_pattern text,                    -- 'hammer','shooting_star','doji','none'
  momentum numeric,

  -- Vote breakdown (each 0–3)
  vote_rsi numeric default 0,
  vote_ema numeric default 0,
  vote_bb numeric default 0,
  vote_candle numeric default 0,
  vote_volume numeric default 0,
  vote_momentum numeric default 0,

  -- Aggregated
  net_score numeric,                      -- positive = UP, negative = DOWN
  direction text,                         -- 'UP' | 'DOWN' | 'SKIP'
  confidence text,                        -- 'LOW' | 'MEDIUM' | 'HIGH' | 'SKIP'
  edge numeric,                           -- abs(signal_prob - market_price)
  signal_prob numeric,                    -- what we think true prob is
  market_price numeric,                   -- YES price from Polymarket at signal time
  tradeable boolean default false         -- net>=2 AND edge>=0.05
);

-- 3. TRADES — every order placed
create table if not exists trades (
  id bigserial primary key,
  signal_id bigint references signals(id),
  market_id text references markets(id),
  ts timestamptz default now(),

  side text not null,                     -- 'YES' | 'NO'
  size_usdc numeric not null,             -- dollar amount
  price_target numeric not null,          -- limit price
  order_id text,                          -- Polymarket order ID
  status text default 'pending',          -- 'pending','filled','cancelled','failed'
  filled_price numeric,
  filled_size numeric,
  pnl numeric,                            -- filled in on resolution
  resolved_at timestamptz,
  notes text
);

-- 4. BOT_STATE — single-row running state
create table if not exists bot_state (
  id integer primary key default 1,       -- always row 1
  running boolean default true,
  consecutive_losses integer default 0,
  consecutive_wins integer default 0,
  paused_until timestamptz,               -- set when 3 consecutive losses hit
  total_trades integer default 0,
  total_wins integer default 0,
  total_pnl numeric default 0,
  bankroll numeric default 30,            -- starting USDC
  current_bankroll numeric default 30,
  last_heartbeat timestamptz default now(),
  last_trade_at timestamptz,
  status_message text default 'Initialising',
  updated_at timestamptz default now()
);

insert into bot_state (id) values (1) on conflict (id) do nothing;

-- 5. ALERTS — things surfaced to Aurelia / Telegram
create table if not exists alerts (
  id bigserial primary key,
  ts timestamptz default now(),
  level text not null,                    -- 'info' | 'warning' | 'critical'
  source text,                            -- 'bot' | 'aurelia' | 'monitor'
  message text not null,
  acknowledged boolean default false,
  acknowledged_at timestamptz
);

-- 6. AGENT_STATUS — for the live dashboard (all agents)
create table if not exists agent_status (
  agent_name text primary key,
  status text,                            -- 'running' | 'paused' | 'error' | 'idle'
  current_task text,
  last_active timestamptz default now(),
  metadata jsonb default '{}'
);

insert into agent_status (agent_name, status, current_task) values
  ('trading-bot', 'idle', 'Waiting to start'),
  ('signal-engine', 'idle', 'Waiting for first tick'),
  ('monitor', 'idle', 'Waiting to start')
on conflict (agent_name) do nothing;

-- ============================================================
-- ENABLE REALTIME on all tables (run in Supabase dashboard
-- under Database > Replication, or run these statements)
-- ============================================================
alter publication supabase_realtime add table trades;
alter publication supabase_realtime add table signals;
alter publication supabase_realtime add table bot_state;
alter publication supabase_realtime add table alerts;
alter publication supabase_realtime add table agent_status;
alter publication supabase_realtime add table markets;

-- ============================================================
-- INDEXES for dashboard query performance
-- ============================================================
create index if not exists idx_trades_ts on trades(ts desc);
create index if not exists idx_signals_ts on signals(ts desc);
create index if not exists idx_signals_tradeable on signals(tradeable, ts desc);
create index if not exists idx_alerts_ts on alerts(ts desc, acknowledged);
