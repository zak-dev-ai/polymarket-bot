// ============================================================
// BTC DATA FETCHER — Multi-source with automatic fallback
// Tries exchanges in order until one works.
// Order: OKX → Kraken → KuCoin → MEXC → Coinbase
// ============================================================

import type { Candle } from './signal_engine.ts'

interface PriceSource {
  name: string
  fetchCandles(limit: number): Promise<Candle[]>
  fetchPrice(): Promise<number>
}

// ── OKX ───────────────────────────────────────────────────────

async function okxCandles(limit: number): Promise<Candle[]> {
  const url = `https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=5m&limit=${limit}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`OKX ${res.status}`)
  const json = await res.json() as { code: string; data?: string[][] }
  if (json.code !== '0' || !json.data) throw new Error(`OKX api: ${json.code}`)
  return json.data.reverse().map(k => ({
    ts: parseInt(k[0]), open: parseFloat(k[1]), high: parseFloat(k[2]),
    low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5])
  }))
}
async function okxPrice(): Promise<number> {
  const res = await fetch('https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT')
  const json = await res.json() as { code: string; data?: Array<{ last: string }> }
  if (json.code !== '0' || !json.data?.length) throw new Error(`OKX price: ${json.code}`)
  return parseFloat(json.data[0].last)
}

// ── Kraken ─────────────────────────────────────────────────────

async function krakenCandles(limit: number): Promise<Candle[]> {
  const url = `https://api.kraken.com/0/public/OHLC?pair=XBTUSDT&interval=5&count=${limit}`
  const res = await fetch(url)
  const json = await res.json() as { error: string[]; result?: Record<string, unknown[]> }
  if (json.error?.length) throw new Error(`Kraken: ${json.error.join(',')}`)
  const key = Object.keys(json.result || {}).find(k => k.startsWith('XBT')) || 'XXBTZUSD'
  const data = json.result![key] as Array<[number, string, string, string, string, string, number]>
  return data.map(k => ({
    ts: k[0] * 1000, open: parseFloat(k[1]), high: parseFloat(k[2]),
    low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[6])
  }))
}
async function krakenPrice(): Promise<number> {
  const res = await fetch('https://api.kraken.com/0/public/Ticker?pair=XBTUSDT')
  const json = await res.json() as { result?: Record<string, { c: string[] }> }
  const key = Object.keys(json.result || {}).find(k => k.startsWith('XBT')) || 'XXBTZUSD'
  return parseFloat(json.result![key].c[0])
}

// ── KuCoin ─────────────────────────────────────────────────────

async function kucoinCandles(limit: number): Promise<Candle[]> {
  const url = `https://api.kucoin.com/api/v1/market/candles?type=5min&symbol=BTC-USDT&limit=${limit}`
  const res = await fetch(url)
  const json = await res.json() as { code: string; data?: string[][] }
  if (json.code !== '200000' || !json.data) throw new Error(`KuCoin: ${json.code}`)
  return json.data.reverse().map(k => ({
    ts: parseInt(k[0]), open: parseFloat(k[1]), close: parseFloat(k[2]),
    high: parseFloat(k[3]), low: parseFloat(k[4]), volume: parseFloat(k[5])
  }))
}
async function kucoinPrice(): Promise<number> {
  const res = await fetch('https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=BTC-USDT')
  const json = await res.json() as { code: string; data?: { price: string } }
  if (json.code !== '200000') throw new Error(`KuCoin price: ${json.code}`)
  return parseFloat(json.data!.price)
}

// ── MEXC ──────────────────────────────────────────────────────

async function mexcCandles(limit: number): Promise<Candle[]> {
  const url = `https://api.mexc.com/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=${limit}`
  const res = await fetch(url)
  const data = await res.json() as Array<[number, string, string, string, string, string]>
  if (!Array.isArray(data)) throw new Error(`MEXC: invalid response`)
  return data.map(k => ({
    ts: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
    low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5])
  }))
}
async function mexcPrice(): Promise<number> {
  const res = await fetch('https://api.mexc.com/api/v3/ticker/price?symbol=BTCUSDT')
  const json = await res.json() as { price: string }
  return parseFloat(json.price)
}

// ── Source registry ───────────────────────────────────────────

const sources: PriceSource[] = [
  { name: 'OKX',     fetchCandles: okxCandles,     fetchPrice: okxPrice },
  { name: 'Kraken',  fetchCandles: krakenCandles,  fetchPrice: krakenPrice },
  { name: 'KuCoin',  fetchCandles: kucoinCandles,  fetchPrice: kucoinPrice },
  { name: 'MEXC',    fetchCandles: mexcCandles,    fetchPrice: mexcPrice },
]

let activeSource = 0 // index of last successful source

/**
 * Fetch the last N 5-minute BTC/USDT candles.
 * Tries sources in round-robin, falls back on failure.
 * Returns candles oldest-first.
 */
export async function fetchBtcCandles(limit = 35): Promise<Candle[]> {
  const errors: string[] = []
  // Try current source first, then all others
  for (let i = 0; i < sources.length; i++) {
    const idx = (activeSource + i) % sources.length
    try {
      const candles = await sources[idx].fetchCandles(limit)
      activeSource = idx
      console.log(`[Data] Using ${sources[idx].name} (${candles.length} candles)`)
      return candles
    } catch (e) {
      errors.push(`${sources[idx].name}: ${e}`)
      console.warn(`[Data] ${sources[idx].name} failed: ${e}`)
    }
  }
  throw new Error(`All data sources failed: ${errors.join(' | ')}`)
}

/** Get current BTC price with fallback */
export async function fetchBtcPrice(): Promise<number> {
  const errors: string[] = []
  for (let i = 0; i < sources.length; i++) {
    const idx = (activeSource + i) % sources.length
    try {
      const price = await sources[idx].fetchPrice()
      activeSource = idx
      return price
    } catch (e) {
      errors.push(`${sources[idx].name}: ${e}`)
    }
  }
  throw new Error(`All price sources failed: ${errors.join(' | ')}`)
}
