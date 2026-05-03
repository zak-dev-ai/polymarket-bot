# Polymarket BTC 5-Min Prediction Bot + Dashboard

Trades BTC Up/Down 5-min binary markets on Polymarket.
Live dashboard built with Next.js + Supabase + Vercel (free tier).

## Architecture

```
┌─────────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  VPS (bot/)         │────▶│  Supabase (free) │◀───▶│  Vercel (free)   │
│  • Signal engine    │     │  • PostgreSQL    │     │  • Next.js 14    │
│  • Strategy         │     │  • Realtime      │     │  • Recharts P&L  │
│  • Polymarket API   │     │  • Row-level sec │     │  • Dark theme    │
└─────────────────────┘     └──────────────────┘     └──────────────────┘
```

## Quick Start

### 1. Bot (on VPS)
```bash
cd projects/polymarket-bot/bot
npm install
MODE=dry node trader.js    # Paper trade mode
```

### 2. Supabase Setup
1. Create free project at https://supabase.com
2. Run `supabase/schema.sql` in SQL Editor
3. Copy your project URL + service_role key

### 3. Dashboard (deploy to Vercel)
```bash
cd projects/polymarket-bot/dashboard
npm install
# Set env vars:
#   NEXT_PUBLIC_SUPABASE_URL=your_url
#   NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key
npm run dev     # Local dev
npm run build   # Deploy to Vercel
```

## Environment Variables

| Variable | Where | Required |
|----------|-------|----------|
| `SUPABASE_URL` | VPS (bot) | Yes |
| `SUPABASE_SERVICE_KEY` | VPS (bot) | Yes |
| `NEXT_PUBLIC_SUPABASE_URL` | Vercel (dashboard) | Yes |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Vercel (dashboard) | Yes |
| `POLY_PRIVATE_KEY` | VPS (live only) | No |
| `POLY_API_KEY` | VPS (live only) | No |
| `POLY_API_SECRET` | VPS (live only) | No |
| `POLY_API_PASSPHRASE` | VPS (live only) | No |

## Strategy
- **Signal**: RSI + EMA crossover + Bollinger Bands + candle patterns + volume
- **Bet Sizing**: Kelly Criterion × 25% (conservative)
- **Risk**: Pause after 3 consecutive losses, resume after 2 wins
- **Min Edge**: 5% over market price

## File Structure
```
polymarket-bot/
├── bot/              # VPS trading bot
│   ├── trader.js     # Main loop + Supabase integration
│   ├── signal.js     # BTC signal engine
│   ├── strategy.js   # Trade evaluation
│   ├── polymarket.js # API client
│   ├── wallet.js     # Wallet manager
│   ├── supabase.js   # DB client (stubs if no creds)
│   └── config.js     # Configuration
├── dashboard/        # Next.js 14 app (Vercel)
│   ├── app/page.tsx  # Live dashboard
│   └── lib/supabase.ts # Types + client
├── supabase/
│   └── schema.sql    # DB tables
└── README.md
```

