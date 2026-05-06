-- ============================================================
-- AURELIA — SCHEMA MIGRATION v2
-- Run this in Supabase SQL Editor to fix missing columns
-- Safe to run multiple times (uses IF NOT EXISTS / DO NOTHING)
-- ============================================================

-- BUG FIX 1: bot_state missing total_losses column
-- main.ts writes total_losses but schema never defined it
ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS total_losses integer DEFAULT 0;

-- BUG FIX 2: trades table — add pool_ratio and time_remaining
-- used by dashboard signal display
ALTER TABLE trades ADD COLUMN IF NOT EXISTS pool_ratio numeric;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS time_remaining integer;

-- BUG FIX 3: signals — add pool_ratio and time_remaining
ALTER TABLE signals ADD COLUMN IF NOT EXISTS pool_ratio numeric;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS time_remaining integer;

-- FIX: reset any corrupted bot_state so P&L calculation starts clean
-- ONLY run this if you want to reset counters (comment out if not)
-- UPDATE bot_state SET 
--   total_losses = 0,
--   consecutive_losses = 0, 
--   consecutive_wins = 0
-- WHERE id = 1 AND total_losses IS NULL;

-- Verify columns exist after migration:
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'bot_state' 
ORDER BY ordinal_position;

-- Also verify trades table has pnl, status columns:
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'trades' 
ORDER BY ordinal_position;

-- Check pending trades count (should show how many need resolution):
SELECT status, count(*) 
FROM trades 
GROUP BY status;

-- Check current bot state:
SELECT id, running, current_bankroll, total_pnl, total_wins, total_losses, total_trades
FROM bot_state;
