// ============================================================
// BTC DATA FETCHER
// Uses Bybit public REST API — free, no auth, no geo-blocks
// Fetches 5-min OHLCV candles for BTC/USDT
// ============================================================

import type { Candle } from './signal_engine.ts'

const BYBIT_BASE = 'https://api.bybit.com'

/**
 * Fetch the last N 5-minute BTC/USDT candles.
 * Returns candles oldest-first (index 0 = oldest, last = current).
 * We need at least 25 for reliable indicator calculation.
 */
export async function fetchBtcCandles(limit = 30): Promise<Candle[]> {
  const url = `${BYBIT_BASE}/v5/market/kline?category=spot&symbol=BTCUSDT&interval=5&limit=${limit}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Bybit candles: ${res.status}`)

  const json = await res.json() as {
    retCode: number
    retMsg: string
    result?: { list: string[][] }
  }

  if (json.retCode !== 0 || !json.result) {
    throw new Error(`Bybit candles error: ${json.retMsg || json.retCode}`)
  }

  // Bybit returns newest-first, we reverse to oldest-first
  const raw = json.result.list.reverse()

  return raw.map(k => ({
    ts: parseInt(k[0]),       // open time (ms)
    open: parseFloat(k[1]),   // open
    high: parseFloat(k[2]),   // high
    low: parseFloat(k[3]),    // low
    close: parseFloat(k[4]),  // close
    volume: parseFloat(k[5])  // volume
  }))
}

/** Get just the current BTC price from Bybit */
export async function fetchBtcPrice(): Promise<number> {
  const url = `${BYBIT_BASE}/v5/market/tickers?category=spot&symbol=BTCUSDT`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Bybit price: ${res.status}`)

  const json = await res.json() as {
    retCode: number
    result?: { list: Array<{ lastPrice: string }> }
  }

  if (json.retCode !== 0 || !json.result?.list?.length) {
    throw new Error(`Bybit price error: ${json.retCode}`)
  }

  return parseFloat(json.result.list[0].lastPrice)
}
