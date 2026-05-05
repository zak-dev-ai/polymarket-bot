// ============================================================
// BTC DATA FETCHER
// Uses OKX public REST API — free, no auth, no geo-blocks
// Fetches 5-min OHLCV candles for BTC/USDT
// ============================================================

import type { Candle } from './signal_engine.ts'

const OKX_BASE = 'https://www.okx.com'

/**
 * Fetch the last N 5-minute BTC/USDT candles from OKX.
 * Returns candles oldest-first (index 0 = oldest, last = current).
 * We need at least 25 for reliable indicator calculation.
 */
export async function fetchBtcCandles(limit = 35): Promise<Candle[]> {
  const url = `${OKX_BASE}/api/v5/market/candles?instId=BTC-USDT&bar=5m&limit=${limit}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`OKX candles: ${res.status}`)

  const json = await res.json() as {
    code: string
    msg?: string
    data?: string[][]
  }

  if (json.code !== '0' || !json.data) {
    throw new Error(`OKX candles error: ${json.msg || json.code}`)
  }

  // OKX returns newest-first, we reverse to oldest-first
  const raw = json.data.reverse()

  return raw.map(k => ({
    ts: parseInt(k[0]),       // open time (ms)
    open: parseFloat(k[1]),   // open
    high: parseFloat(k[2]),   // high
    low: parseFloat(k[3]),    // low
    close: parseFloat(k[4]),  // close
    volume: parseFloat(k[5])  // volume
  }))
}

/** Get just the current BTC price from OKX */
export async function fetchBtcPrice(): Promise<number> {
  const url = `${OKX_BASE}/api/v5/market/ticker?instId=BTC-USDT`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`OKX price: ${res.status}`)

  const json = await res.json() as {
    code: string
    data?: Array<{ last: string }>
  }

  if (json.code !== '0' || !json.data?.length) {
    throw new Error(`OKX price error: ${json.code}`)
  }

  return parseFloat(json.data[0].last)
}
