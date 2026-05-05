// ============================================================
// BTC DATA FETCHER
// Primary:  Binance US (api.binance.us) — works from US servers
// Fallback: Bybit — always works, no auth
// Fetches 5-min OHLCV candles for BTC/USDT
// ============================================================

import type { Candle } from './signal_engine.ts'

const BINANCE_US_BASE = 'https://api.binance.us'
const BYBIT_BASE = 'https://api.bybit.com'

/**
 * Fetch the last N 5-minute BTC/USDT candles.
 * Tries Binance US first, falls back to Bybit if that fails.
 * Both are accessible from Deno Deploy (US servers).
 */
export async function fetchBtcCandles(limit = 30): Promise<Candle[]> {
  // Try Binance US first
  try {
    const url = `${BINANCE_US_BASE}/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=${limit}`
    const res = await fetch(url)
    if (res.ok) {
      const raw = await res.json() as Array<[
        number, string, string, string, string, string, number, ...unknown[]
      ]>
      console.log('[BTC] Using Binance US')
      return raw.map(k => ({
        ts: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5])
      }))
    }
    console.warn(`[BTC] Binance US returned ${res.status}, trying Bybit...`)
  } catch (e) {
    console.warn('[BTC] Binance US failed:', e, '— trying Bybit...')
  }

  // Fallback: Bybit (no geo restrictions, free, no auth)
  try {
    const url = `${BYBIT_BASE}/v5/market/kline?category=spot&symbol=BTCUSDT&interval=5&limit=${limit}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Bybit: ${res.status}`)
    const data = await res.json() as {
      result: { list: Array<[string, string, string, string, string, string, string]> }
    }
    // Bybit returns newest first — reverse to oldest-first
    const list = data.result.list.reverse()
    console.log('[BTC] Using Bybit fallback')
    return list.map(k => ({
      ts: parseInt(k[0]),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5])
    }))
  } catch (e) {
    throw new Error(`All BTC data sources failed. Last error: ${e}`)
  }
}

/** Get just the current BTC price */
export async function fetchBtcPrice(): Promise<number> {
  // Try Binance US first
  try {
    const url = `${BINANCE_US_BASE}/api/v3/ticker/price?symbol=BTCUSDT`
    const res = await fetch(url)
    if (res.ok) {
      const data = await res.json() as { price: string }
      return parseFloat(data.price)
    }
  } catch (_) { /* fall through */ }

  // Fallback: Bybit
  const url = `${BYBIT_BASE}/v5/market/tickers?category=spot&symbol=BTCUSDT`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Bybit price: ${res.status}`)
  const data = await res.json() as {
    result: { list: Array<{ lastPrice: string }> }
  }
  return parseFloat(data.result.list[0].lastPrice)
}
