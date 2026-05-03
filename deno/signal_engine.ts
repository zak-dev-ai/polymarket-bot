// ============================================================
// SIGNAL ENGINE — 6-Factor Voting System
// Each factor votes UP (positive) or DOWN (negative)
// Weight range: 0.5 to 3.0 points per factor
// ============================================================

export interface Candle {
  open: number
  high: number
  low: number
  close: number
  volume: number
  ts: number
}

export interface SignalResult {
  // Raw indicators
  rsi: number
  ema9: number
  ema21: number
  bbUpper: number
  bbLower: number
  bbMid: number
  btcPrice: number
  volumeSpike: boolean
  candlePattern: 'hammer' | 'shooting_star' | 'doji' | 'none'
  momentum: number

  // Vote breakdown (signed: positive=UP, negative=DOWN)
  voteRsi: number
  voteEma: number
  voteBb: number
  voteCandle: number
  voteVolume: number
  voteMomentum: number

  // Aggregated
  netScore: number
  direction: 'UP' | 'DOWN' | 'SKIP'
  confidence: 'LOW' | 'MEDIUM' | 'HIGH' | 'SKIP'
  signalProb: number        // our estimated true probability of UP
  tradeable: boolean        // net >= 2 AND edge >= 0.05
}

// ── Indicator calculations ───────────────────────────────────

export function calcRsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50
  let gains = 0, losses = 0
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff > 0) gains += diff
    else losses += Math.abs(diff)
  }
  const avgGain = gains / period
  const avgLoss = losses / period
  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

export function calcEma(values: number[], period: number): number[] {
  const k = 2 / (period + 1)
  const result: number[] = []
  let ema = values[0]
  result.push(ema)
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k)
    result.push(ema)
  }
  return result
}

export function calcBollingerBands(
  closes: number[],
  period = 20,
  stdDev = 2
): { upper: number; mid: number; lower: number } {
  const slice = closes.slice(-period)
  if (slice.length < period) {
    const mid = closes[closes.length - 1]
    return { upper: mid, mid, lower: mid }
  }
  const mid = slice.reduce((a, b) => a + b, 0) / period
  const variance = slice.reduce((sum, v) => sum + Math.pow(v - mid, 2), 0) / period
  const sd = Math.sqrt(variance)
  return { upper: mid + stdDev * sd, mid, lower: mid - stdDev * sd }
}

export function detectCandlePattern(
  candle: Candle
): 'hammer' | 'shooting_star' | 'doji' | 'none' {
  const body = Math.abs(candle.close - candle.open)
  const range = candle.high - candle.low
  if (range === 0) return 'none'

  const bodyRatio = body / range
  const upperWick = candle.high - Math.max(candle.open, candle.close)
  const lowerWick = Math.min(candle.open, candle.close) - candle.low

  // Doji — very small body
  if (bodyRatio < 0.1) return 'doji'

  // Hammer — small body at top, long lower wick, bullish reversal
  if (lowerWick > body * 2 && upperWick < body * 0.5 && bodyRatio < 0.4) {
    return 'hammer'
  }

  // Shooting star — small body at bottom, long upper wick, bearish reversal
  if (upperWick > body * 2 && lowerWick < body * 0.5 && bodyRatio < 0.4) {
    return 'shooting_star'
  }

  return 'none'
}

export function calcMomentum(closes: number[], lookback = 2): number {
  if (closes.length < lookback + 1) return 0
  const current = closes[closes.length - 1]
  const prev = closes[closes.length - 1 - lookback]
  return (current - prev) / prev // % change
}

export function calcVolumeSpike(volumes: number[], threshold = 1.8): boolean {
  if (volumes.length < 10) return false
  const recent = volumes[volumes.length - 1]
  const avg = volumes.slice(-11, -1).reduce((a, b) => a + b, 0) / 10
  return avg > 0 && recent > avg * threshold
}

// ── Voting logic ─────────────────────────────────────────────

function voteRsi(rsi: number, ema9: number, ema21: number): number {
  const emasBullish = ema9 > ema21
  const emasBearish = ema9 < ema21

  // Ignore RSI when it's just trend momentum
  if (rsi >= 80 && emasBullish) return 0   // strong uptrend — not a reversal signal
  if (rsi <= 20 && emasBearish) return 0   // strong downtrend — not a reversal signal

  if (rsi < 35 && emasBullish) return 2.5  // oversold bounce UP — strong signal
  if (rsi < 40 && emasBullish) return 1.5  // mildly oversold + bullish EMA
  if (rsi > 70 && emasBearish) return -2.5 // overbought rejection DOWN
  if (rsi > 65 && emasBearish) return -1.5
  if (rsi < 45) return 0.5                 // weak bullish lean
  if (rsi > 55) return -0.5                // weak bearish lean
  return 0
}

function voteEma(price: number, ema9: number, ema21: number): number {
  const fastAboveSlow = ema9 > ema21
  const bothAbovePrice = ema9 > price && ema21 > price
  const bothBelowPrice = ema9 < price && ema21 < price

  if (fastAboveSlow && bothBelowPrice) return 2.0  // confirmed uptrend
  if (fastAboveSlow && !bothBelowPrice) return 1.0 // uptrend but price extended
  if (!fastAboveSlow && bothAbovePrice) return -2.0 // confirmed downtrend
  if (!fastAboveSlow && !bothAbovePrice) return -1.0
  return 0
}

function voteBb(
  price: number,
  bb: { upper: number; mid: number; lower: number }
): number {
  const range = bb.upper - bb.lower
  if (range === 0) return 0

  const pos = (price - bb.lower) / range // 0 = at lower, 1 = at upper

  if (pos <= 0.05) return 2.0   // touching/below lower band — strong bounce zone
  if (pos <= 0.15) return 1.0   // near lower band
  if (pos >= 0.95) return -2.0  // touching/above upper band — strong rejection
  if (pos >= 0.85) return -1.0  // near upper band
  return 0
}

function voteCandlePattern(
  pattern: 'hammer' | 'shooting_star' | 'doji' | 'none'
): number {
  if (pattern === 'hammer') return 1.5
  if (pattern === 'shooting_star') return -1.5
  if (pattern === 'doji') return 0   // skip — indecision
  return 0
}

function voteVolume(spike: boolean, ema9: number, ema21: number): number {
  if (!spike) return 0
  // Volume spike in direction of trend = conviction
  if (ema9 > ema21) return 1.0   // bullish trend + spike = conviction UP
  if (ema9 < ema21) return -1.0  // bearish trend + spike = conviction DOWN
  return 0
}

function voteMomentum(momentum: number): number {
  if (momentum > 0.003) return 1.5   // >0.3% move up in last 2 candles
  if (momentum > 0.001) return 0.5
  if (momentum < -0.003) return -1.5
  if (momentum < -0.001) return -0.5
  return 0
}

// ── Confidence & probability mapping ────────────────────────

function netScoreToProb(netScore: number): number {
  // Map net score to a probability (0.5 = no edge, 1.0 = certain UP)
  // Sigmoid-like mapping capped at reasonable bounds
  const clamped = Math.max(-8, Math.min(8, netScore))
  const prob = 0.5 + clamped * 0.045
  return Math.max(0.05, Math.min(0.95, prob))
}

function getConfidence(netScore: number): 'LOW' | 'MEDIUM' | 'HIGH' | 'SKIP' {
  const abs = Math.abs(netScore)
  if (abs < 1) return 'SKIP'
  if (abs < 2) return 'LOW'
  if (abs < 4) return 'MEDIUM'
  return 'HIGH'
}

// ── Main evaluate function ───────────────────────────────────

export function evaluate(
  candles: Candle[],         // at least 25 candles, most recent last
  marketYesPrice: number     // current Polymarket YES price (0–1)
): SignalResult {
  if (candles.length < 22) {
    return emptySignal(candles[candles.length - 1]?.close ?? 0, marketYesPrice)
  }

  const closes = candles.map(c => c.close)
  const volumes = candles.map(c => c.volume)
  const latestCandle = candles[candles.length - 1]
  const price = latestCandle.close

  // Calculate indicators
  const rsi = calcRsi(closes)
  const ema9arr = calcEma(closes, 9)
  const ema21arr = calcEma(closes, 21)
  const ema9 = ema9arr[ema9arr.length - 1]
  const ema21 = ema21arr[ema21arr.length - 1]
  const bb = calcBollingerBands(closes)
  const candlePattern = detectCandlePattern(latestCandle)
  const momentum = calcMomentum(closes)
  const volumeSpike = calcVolumeSpike(volumes)

  // Cast votes (signed)
  const vRsi = voteRsi(rsi, ema9, ema21)
  const vEma = voteEma(price, ema9, ema21)
  const vBb = voteBb(price, bb)
  const vCandle = voteCandlePattern(candlePattern)
  const vVolume = voteVolume(volumeSpike, ema9, ema21)
  const vMomentum = voteMomentum(momentum)

  const netScore = vRsi + vEma + vBb + vCandle + vVolume + vMomentum
  const direction: 'UP' | 'DOWN' | 'SKIP' =
    netScore > 0 ? 'UP' : netScore < 0 ? 'DOWN' : 'SKIP'
  const confidence = getConfidence(netScore)
  const signalProb = netScoreToProb(netScore)
  const edge = Math.abs(signalProb - marketYesPrice)

  // Tradeable: net >= 2 AND edge >= 5% AND not SKIP
  const tradeable = Math.abs(netScore) >= 2 && edge >= 0.05 && direction !== 'SKIP'

  return {
    rsi, ema9, ema21,
    bbUpper: bb.upper, bbLower: bb.lower, bbMid: bb.mid,
    btcPrice: price,
    volumeSpike,
    candlePattern,
    momentum,
    voteRsi: vRsi,
    voteEma: vEma,
    voteBb: vBb,
    voteCandle: vCandle,
    voteVolume: vVolume,
    voteMomentum: vMomentum,
    netScore,
    direction,
    confidence,
    signalProb,
    tradeable
  }
}

function emptySignal(price: number, marketYesPrice: number): SignalResult {
  return {
    rsi: 50, ema9: price, ema21: price,
    bbUpper: price, bbLower: price, bbMid: price,
    btcPrice: price, volumeSpike: false,
    candlePattern: 'none', momentum: 0,
    voteRsi: 0, voteEma: 0, voteBb: 0,
    voteCandle: 0, voteVolume: 0, voteMomentum: 0,
    netScore: 0, direction: 'SKIP', confidence: 'SKIP',
    signalProb: marketYesPrice,
    tradeable: false
  }
}
