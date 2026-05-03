// ============================================================
// BTC DATA FETCHER
// Uses Binance public REST API — free, no auth needed
// Fetches 5-min OHLCV candles for BTC/USDT
// ============================================================

import type { Candle } from './signal_engine.ts'

const BINANCE_BASE = 'https://api.binance.com'

/**
 * Fetch the last N 5-minute BTC/USDT candles from Binance.
 * Returns candles oldest-first (index 0 = oldest, last = current).
 * We need at least 25 for reliable indicator calculation.
 */
export async function fetchBtcCandles(limit = 30): Promise<Candle[]> {
  const url = `${BINANCE_BASE}/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=${limit}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Binance candles: ${res.status}`)

  const raw = await res.json() as Array<[
    number,   // 0: open time
    string,   // 1: open
    string,   // 2: high
    string,   // 3: low
    string,   // 4: close
    string,   // 5: volume
    number,   // 6: close time
    ...unknown[]
  ]>

  return raw.map(k => ({
    ts: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5])
  }))
}

/** Get just the current BTC price */
export async function fetchBtcPrice(): Promise<number> {
  const url = `${BINANCE_BASE}/api/v3/ticker/price?symbol=BTCUSDT`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Binance price: ${res.status}`)
  const data = await res.json() as { price: string }
  return parseFloat(data.price)
}
