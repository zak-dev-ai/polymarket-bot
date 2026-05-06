-- ============================================================
-- AURELIA — SCHEMA MIGRATION v3 (Pre-Production Fixes)
-- Run this in Supabase SQL Editor after migration_v2
-- ============================================================

-- BUG FIX: Drop FK constraints on signals and trades
-- These crash insertSignal/insertTrade when market_id doesn't exist
ALTER TABLE signals DROP CONSTRAINT IF EXISTS signals_market_id_fkey;
ALTER TABLE trades DROP CONSTRAINT IF EXISTS trades_market_id_fkey;

-- Add today_pnl column for daily P&L tracking
ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS today_pnl numeric DEFAULT 0;
ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS today_bankroll_start numeric;
ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS last_pnl_reset_date text;

-- Verify drop succeeded:
SELECT table_name, constraint_name 
FROM information_schema.table_constraints 
WHERE constraint_type = 'FOREIGN KEY' 
AND table_name IN ('signals', 'trades');
