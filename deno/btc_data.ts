// ============================================================
// BTC DATA FETCHER — Aurelia v3.0
// Primary:  Binance US (api.binance.us) — works from US servers
// Fallback: Bybit — always works, no auth, no geo restrictions
// Fetches 5-min OHLCV candles for BTC/USDT
// ============================================================

import type { Candle } from './signal_engine.ts'

const BINANCE_US_BASE = 'https://api.binance.us'
const BYBIT_BASE = 'https://api.bybit.com'

export async function fetchBtcCandles(limit = 30): Promise<Candle[]> {
  try {
    const url = `${BINANCE_US_BASE}/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=${limit}`
    const res = await fetch(url)
    if (res.ok) {
      const raw = await res.json() as Array<[number, string, string, string, string, string, number, ...unknown[]]>
      console.log('[BTC] Binance US ✓')
      return raw.map(k => ({ ts: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]) }))
    }
    console.warn(`[BTC] Binance US ${res.status}, Bybit fallback...`)
  } catch (e) { console.warn('[BTC] Binance US:', e, '→ Bybit') }

  try {
    const url = `${BYBIT_BASE}/v5/market/kline?category=spot&symbol=BTCUSDT&interval=5&limit=${limit}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${res.status}`)
    const data = await res.json() as { result: { list: Array<[string, string, string, string, string, string, string]> } }
    console.log('[BTC] Bybit ✓')
    return data.result.list.reverse().map(k => ({
      ts: parseInt(k[0]), open: parseFloat(k[1]), high: parseFloat(k[2]),
      low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5])
    }))
  } catch (e) { throw new Error(`All BTC sources failed: ${e}`) }
}

export async function fetchBtcPrice(): Promise<number> {
  try {
    const r = await fetch(`${BINANCE_US_BASE}/api/v3/ticker/price?symbol=BTCUSDT`)
    if (r.ok) return parseFloat((await r.json()).price)
  } catch { /* fall through */ }
  const r = await fetch(`${BYBIT_BASE}/v5/market/tickers?category=spot&symbol=BTCUSDT`)
  if (!r.ok) throw new Error(`Bybit price: ${r.status}`)
  return parseFloat((await r.json()).result.list[0].lastPrice)
}
