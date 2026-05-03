# Polymarket Bot — Setup Guide
## Zero to live in ~45 minutes, $0/month

---

## STEP 1 — Create your Supabase project (5 min)

1. Go to https://supabase.com → New Project (free)
2. Save your **Project URL** and **anon key** (Settings → API)
3. Go to **SQL Editor** → paste the entire contents of `supabase/schema.sql` → Run
4. Go to **Database → Replication** → enable Realtime for:
   - trades, signals, bot_state, alerts, agent_status, markets

---

## STEP 2 — Set up your Polymarket account (10 min)

1. Go to https://polymarket.com → connect a wallet (MetaMask recommended)
2. Deposit USDC on **Polygon network** (minimum $30 to start)
3. Get your API credentials:
   - Go to https://docs.polymarket.com → Authentication
   - Run the key derivation script (they provide it) with your wallet private key
   - Save: `POLY_API_KEY`, `POLY_API_SECRET`, `POLY_API_PASSPHRASE`
   - Your `POLY_PRIVATE_KEY` is your wallet private key — keep this VERY safe

---

## STEP 3 — Set up Telegram bot (3 min)

1. Open Telegram → search `@BotFather` → `/newbot`
2. Follow prompts → copy your **BOT_TOKEN**
3. Message your new bot once, then visit:
   `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
4. Copy your **chat_id** from the response

---

## STEP 4 — Deploy the bot on Deno Deploy (10 min)

1. Go to https://dash.deno.com → New Project → Connect GitHub
2. Point it at your repo, entry file: `deno/main.ts`
3. Add these environment variables (Settings → Environment Variables):

```
SUPABASE_URL            = https://xxxx.supabase.co
SUPABASE_SERVICE_KEY    = your-service-role-key   ← NOT anon key, use service_role
POLY_PRIVATE_KEY        = your-wallet-private-key
POLY_API_KEY            = your-polymarket-api-key
POLY_API_SECRET         = your-polymarket-api-secret
POLY_API_PASSPHRASE     = your-polymarket-api-passphrase
TELEGRAM_BOT_TOKEN      = your-telegram-bot-token
TELEGRAM_CHAT_ID        = your-telegram-chat-id
```

4. Deploy → the bot starts immediately and runs 24/7

---

## STEP 5 — Deploy the dashboard (5 min)

**Option A — Cloudflare Pages (recommended, replaces Vercel)**
1. Go to https://pages.cloudflare.com → New Project → Connect GitHub
2. Select your repo → **Build settings:**
   - Build command: *(leave empty)*
   - Output directory: `dashboard`
   - Root directory: *(leave empty)*
3. Done — your dashboard is live at `yourproject.pages.dev`

**Option B — Netlify**
1. Go to https://netlify.com → New site → Import from GitHub
2. Select repo → Publish directory: `dashboard` → Deploy
3. Done — live at `yourproject.netlify.app`

**Option C — GitHub Pages (zero config)**
1. GitHub repo → Settings → Pages
2. Source: Deploy from branch → main → /dashboard folder
3. Done — live at `yourusername.github.io/yourrepo`

**After deploying:**
Open `dashboard/index.html` and replace:
```js
const SUPABASE_URL = 'YOUR_SUPABASE_URL'
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY'
```
with your actual values, then push to GitHub.

---

## STEP 6 — Verify everything works

1. Check `https://your-deno-deploy-url.deno.dev/health`
   → Should return JSON with bot status
2. Open your dashboard URL
   → Green "Live" dot should appear
3. Check Telegram
   → You should get a heartbeat message within the hour

---

## File structure

```
polymarket-bot/
├── deno/
│   ├── main.ts              ← Bot entry point (Deno Deploy)
│   ├── signal_engine.ts     ← 6-factor voting system
│   ├── position_sizer.ts    ← Kelly × 25% + circuit breakers
│   ├── polymarket_client.ts ← Order placement + market data
│   ├── btc_data.ts          ← Binance candle fetcher (free)
│   ├── supabase_client.ts   ← DB operations
│   └── telegram.ts          ← Alert notifications
├── dashboard/
│   └── index.html           ← Single-file live dashboard
├── supabase/
│   └── schema.sql           ← Run once in Supabase SQL editor
└── SETUP.md                 ← This file
```

---

## How to control the bot (via Deno Deploy URL)

```bash
# Pause trading
curl -X POST https://your-bot.deno.dev/pause

# Resume trading
curl -X POST https://your-bot.deno.dev/resume

# Check health
curl https://your-bot.deno.dev/health

# Manually trigger a cycle
curl -X POST https://your-bot.deno.dev/trigger
```

Or tell Aurelia: *"pause the trading bot"* — she can call these endpoints.

---

## Important notes

- **Paper trading first**: the bot will place REAL orders with REAL money.
  Consider setting `current_bankroll` to $0 in Supabase and monitoring signals
  for a few days before funding.

- **Private key security**: never commit your `.env` file or private key to GitHub.
  Always use Deno Deploy's environment variable secrets.

- **Polygon gas**: you need a tiny amount of MATIC in your wallet for gas.
  ~$1 worth is enough for months of trading.

- **Market availability**: BTC 5-min markets on Polymarket are not always active.
  The bot will idle gracefully when no markets are found.
