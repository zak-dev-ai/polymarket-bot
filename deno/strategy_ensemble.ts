// ============================================================
// STRATEGY ENSEMBLE — Multi-strategy voting system
// Runs 3 parallel strategies and trades on consensus (2+ agree)
// Separate from the original signal_engine.ts to avoid breaking it
// ============================================================

import type { Candle } from './signal_engine.ts'

// ── Results ───────────────────────────────────────────────────

export interface StrategyVote {
  name: string
  direction: 'UP' | 'DOWN' | 'SKIP'
  netScore: number
  confidence: 'LOW' | 'MEDIUM' | 'HIGH' | 'SKIP'
  conviction: number  // 0-1 how strongly the strategy feels
}

export interface EnsembleResult {
  timestamp: number
  price: number
  votes: StrategyVote[]
  consensus: 'UP' | 'DOWN' | 'SKIP'
  agreementLevel: number  // 0-1, how many strategies agreed
  netScore: number
  confidence: 'LOW' | 'MEDIUM' | 'HIGH' | 'SKIP'
  signalProb: number
  edge: number
  tradeable: boolean
}

// ── Shared helpers ────────────────────────────────────────────

function calcRsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50
  const changes = []
  for (let i = 1; i < closes.length; i++) changes.push(closes[i] - closes[i - 1])
  const recent = changes.slice(-period)
  const gains = recent.filter(c => c > 0).reduce((a, b) => a + b, 0) / period
  const losses = recent.filter(c => c < 0).reduce((a, b) => a - b, 0) / period
  if (losses === 0) return gains > 0 ? 100 : 50
  const rs = gains / losses
  return 100 - 100 / (1 + rs)
}

function calcEma(values: number[], period: number): number[] {
  const result: number[] = []
  const k = 2 / (period + 1)
  result.push(values[0])
  for (let i = 1; i < values.length; i++) {
    result.push(values[i] * k + result[i - 1] * (1 - k))
  }
  return result
}

function calcSma(values: number[], period: number): number[] {
  const result: number[] = []
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { result.push(values[i]); continue }
    let sum = 0
    for (let j = i - period + 1; j <= i; j++) sum += values[j]
    result.push(sum / period)
  }
  return result
}

function calcStdDev(values: number[], period: number, sma: number[]): number[] {
  const result: number[] = []
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { result.push(0); continue }
    let sumSq = 0
    for (let j = i - period + 1; j <= i; j++) sumSq += Math.pow(values[j] - sma[i], 2)
    result.push(Math.sqrt(sumSq / period))
  }
  return result
}

// ── Strategy 1: 6-Factor Quant (existing, ported cleanly) ─────

function strategyQuant(candles: Candle[]): StrategyVote {
  const closes = candles.map(c => c.close)
  const volumes = candles.map(c => c.volume)
  const price = closes[closes.length - 1]
  const rsi = calcRsi(closes)
  const ema9 = calcEma(closes, 9)
  const ema21 = calcEma(closes, 21)
  const e9 = ema9[ema9.length - 1]
  const e21 = ema21[ema21.length - 1]
  const sma20 = calcSma(closes, 20)
  const std20 = calcStdDev(closes, 20, sma20)
  const bbUpper = sma20[sma20.length - 1] + 2 * std20[std20.length - 1]
  const bbLower = sma20[sma20.length - 1] - 2 * std20[std20.length - 1]

  // Vote helpers
  const vRsi = rsi < 30 ? 1 : rsi > 70 ? -1 : (rsi - 50) / 20
  const vEma = e9 > e21 ? 1 : -1
  const vBb = price < bbLower ? 1 : price > bbUpper ? -1 : 0
  const vMomentum = (closes[closes.length - 1] - closes[closes.length - 3]) / closes[closes.length - 3] * 100
  
  const net = vRsi + vEma + vBb + (vMomentum > 0.3 ? 1 : vMomentum < -0.3 ? -1 : 0)
  const direction = net > 0.5 ? 'UP' : net < -0.5 ? 'DOWN' : 'SKIP'
  const abs = Math.abs(net)
  const confidence = abs >= 3 ? 'HIGH' : abs >= 1.5 ? 'MEDIUM' : abs >= 0.5 ? 'LOW' : 'SKIP' as any
  
  return { name: 'Quant 6-Factor', direction, netScore: net, confidence, conviction: Math.min(1, abs / 4) }
}

// ── Strategy 2: MACD + ADX Trend Following ────────────────────

function strategyTrend(candles: Candle[]): StrategyVote {
  const closes = candles.map(c => c.close)
  const highs = candles.map(c => c.high)
  const lows = candles.map(c => c.low)
  const price = closes[closes.length - 1]

  // MACD
  const ema12 = calcEma(closes, 12)
  const ema26 = calcEma(closes, 26)
  const macdLine = ema12.map((v, i) => v - ema26[i])
  const signalLine = calcEma(macdLine, 9)
  const macd = macdLine[macdLine.length - 1]
  const signal = signalLine[signalLine.length - 1]
  const histogram = macd - signal

  // ADX
  const period = 14
  const tr: number[] = []
  const plusDM: number[] = []
  const minusDM: number[] = []
  for (let i = 1; i < closes.length; i++) {
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])))
    plusDM.push(highs[i] - highs[i - 1] > lows[i - 1] - lows[i] ? Math.max(0, highs[i] - highs[i - 1]) : 0)
    minusDM.push(lows[i - 1] - lows[i] > highs[i] - highs[i - 1] ? Math.max(0, lows[i - 1] - lows[i]) : 0)
  }
  const atr = calcEma(tr, period)
  const plus = calcEma(plusDM, period)
  const minus = calcEma(minusDM, period)
  const adx = plus[plus.length - 1] > 0 && minus[minus.length - 1] > 0
    ? Math.abs(plus[plus.length - 1] - minus[minus.length - 1]) / (plus[plus.length - 1] + minus[minus.length - 1]) * 100
    : 0

  // Direction: MACD histogram sign + ADX strength
  const macdSignal = histogram > 0 ? 1 : -1
  const trendStrength = adx / 100  // 0-1
  
  const net = macdSignal * trendStrength * 3
  const direction = net > 0.5 ? 'UP' : net < -0.5 ? 'DOWN' : 'SKIP'
  const abs = Math.abs(net)
  const confidence = abs >= 2 ? 'HIGH' : abs >= 1 ? 'MEDIUM' : abs >= 0.5 ? 'LOW' : 'SKIP' as any

  return { name: 'Trend (MACD+ADX)', direction, netScore: net, confidence, conviction: trendStrength }
}

// ── Strategy 3: Mean Reversion ────────────────────────────────

function strategyMeanReversion(candles: Candle[]): StrategyVote {
  const closes = candles.map(c => c.close)
  const price = closes[closes.length - 1]
  const rsi = calcRsi(closes)
  const sma20 = calcSma(closes, 20)
  const std20 = calcStdDev(closes, 20, sma20)
  const bbUpper = sma20[sma20.length - 1] + 2 * std20[std20.length - 1]
  const bbLower = sma20[sma20.length - 1] - 2 * std20[std20.length - 1]
  const bbMid = sma20[sma20.length - 1]

  // %B = (price - lower) / (upper - lower)
  const bbPctB = (price - bbLower) / (bbUpper - bbLower)

  // Signal strength: how far from mean
  // RSI < 30 or > 70 → strong reversion signal
  // %B < 0.2 or > 0.8 → strong reversion signal
  let net = 0

  if (rsi < 30 && bbPctB < 0.2) net = 3      // Strong oversold bounce
  else if (rsi < 35 && bbPctB < 0.3) net = 2   // Mild oversold
  else if (rsi > 70 && bbPctB > 0.8) net = -3  // Strong overbought
  else if (rsi > 65 && bbPctB > 0.7) net = -2  // Mild overbought
  else if (rsi < 40 && bbPctB < 0.4) net = 1   // Weak oversold
  else if (rsi > 60 && bbPctB > 0.6) net = -1  // Weak overbought

  const direction = net > 0 ? 'UP' : net < 0 ? 'DOWN' : 'SKIP'
  const abs = Math.abs(net)
  const confidence = abs >= 2.5 ? 'HIGH' : abs >= 1.5 ? 'MEDIUM' : abs >= 0.5 ? 'LOW' : 'SKIP' as any

  return { name: 'Mean Reversion', direction, netScore: net, confidence, conviction: Math.min(1, abs / 3) }
}

// ── Ensemble ──────────────────────────────────────────────────

const strategies = [strategyQuant, strategyTrend, strategyMeanReversion]

export function evaluateEnsemble(
  candles: Candle[],
  marketYesPrice: number
): EnsembleResult {
  if (candles.length < 22) {
    const price = candles[candles.length - 1]?.close ?? 0
    return {
      timestamp: Date.now(), price,
      votes: [], consensus: 'SKIP', agreementLevel: 0,
      netScore: 0, confidence: 'SKIP', signalProb: 0.5, edge: 0, tradeable: false
    }
  }

  // Run all strategies
  const votes = strategies.map(fn => fn(candles))

  // Consensus: count UP vs DOWN vs SKIP
  const up = votes.filter(v => v.direction === 'UP').length
  const down = votes.filter(v => v.direction === 'DOWN').length
  const skip = votes.filter(v => v.direction === 'SKIP').length

  let consensus: 'UP' | 'DOWN' | 'SKIP'
  let agreementLevel: number

  if (up >= 2) {
    consensus = 'UP'
    agreementLevel = up / votes.length
  } else if (down >= 2) {
    consensus = 'DOWN'
    agreementLevel = down / votes.length
  } else {
    consensus = 'SKIP'
    agreementLevel = Math.max(up, down, skip) / votes.length
  }

  // Net score = weighted average of all votes
  const netScore = votes.reduce((sum, v) => {
    const val = v.direction === 'UP' ? 1 : v.direction === 'DOWN' ? -1 : 0
    return sum + val * v.conviction
  }, 0)

  // Confidence level
  const absNet = Math.abs(netScore)
  const confidence = absNet >= 1.5 ? 'HIGH' : absNet >= 0.8 ? 'MEDIUM' : absNet >= 0.3 ? 'LOW' : 'SKIP' as any

  // Signal probability and edge
  const signalProb = 0.5 + (netScore / 3) * 0.35  // map netScore to ~0.15-0.85
  const edge = Math.abs(signalProb - marketYesPrice)
  const tradeable = consensus !== 'SKIP' && agreementLevel >= 0.5 && edge >= 0.05

  return {
    timestamp: Date.now(),
    price: candles[candles.length - 1]?.close ?? 0,
    votes,
    consensus,
    agreementLevel,
    netScore,
    confidence,
    signalProb: Math.max(0.01, Math.min(0.99, signalProb)),
    edge,
    tradeable
  }
}
