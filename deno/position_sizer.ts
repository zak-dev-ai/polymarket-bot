// ============================================================
// POSITION SIZER — Kelly Criterion × 25% (conservative)
// With consecutive loss/win circuit breakers
// ============================================================

export interface BotState {
  running: boolean
  consecutiveLosses: number
  consecutiveWins: number
  pausedUntil: string | null
  currentBankroll: number
  totalTrades: number
  totalWins: number
  totalPnl: number
}

export interface SizeResult {
  allowed: boolean
  sizeUsdc: number
  reason: string
  kellyFull: number
  kellyConservative: number
}

const MAX_POSITION = 7.50   // hard cap in USDC ($7.50 on $30 bankroll)
const KELLY_FRACTION = 0.25 // use 25% of Kelly
const MIN_POSITION = 0.50   // minimum viable bet

export function calcPositionSize(
  state: BotState,
  winProb: number,          // our estimated probability of winning (0–1)
  marketOdds: number,       // what Polymarket pays on win (e.g. YES at 0.4 → pays 1/0.4 = 2.5x)
  edge: number              // our edge over market (abs diff)
): SizeResult {
  const now = new Date()

  // ── Circuit breaker: consecutive losses ──────────────────
  if (state.consecutiveLosses >= 3) {
    const resumeAt = state.pausedUntil ? new Date(state.pausedUntil) : null
    if (!resumeAt || now < resumeAt) {
      return {
        allowed: false,
        sizeUsdc: 0,
        kellyFull: 0,
        kellyConservative: 0,
        reason: `Paused — 3 consecutive losses. Resume after ${resumeAt?.toISOString() ?? 'manual reset'}`
      }
    }
  }

  // ── Circuit breaker: bot paused ─────────────────────────
  if (!state.running) {
    return {
      allowed: false,
      sizeUsdc: 0,
      kellyFull: 0,
      kellyConservative: 0,
      reason: 'Bot is paused by operator'
    }
  }

  // ── Insufficient bankroll ────────────────────────────────
  if (state.currentBankroll < MIN_POSITION) {
    return {
      allowed: false,
      sizeUsdc: 0,
      kellyFull: 0,
      kellyConservative: 0,
      reason: `Bankroll too low: $${state.currentBankroll.toFixed(2)}`
    }
  }

  // ── Kelly Criterion ──────────────────────────────────────
  // Kelly % = (b*p - q) / b
  // b = net odds (payout per $ wagered minus the stake)
  // p = win probability, q = 1-p
  const b = (1 / marketOdds) - 1  // net odds on $1 bet
  const p = winProb
  const q = 1 - p

  // Guard: if b <= 0, market is paying less than even — skip
  if (b <= 0) {
    return {
      allowed: false,
      sizeUsdc: 0,
      kellyFull: 0,
      kellyConservative: 0,
      reason: 'Market odds unfavourable (b <= 0)'
    }
  }

  const kellyPct = (b * p - q) / b
  const kellyFull = Math.max(0, kellyPct) * state.currentBankroll
  const kellyConservative = kellyFull * KELLY_FRACTION

  // Hard cap
  const sizeUsdc = Math.min(
    Math.max(kellyConservative, 0),
    MAX_POSITION,
    state.currentBankroll * 0.25 // never more than 25% of bankroll in one trade
  )

  if (sizeUsdc < MIN_POSITION) {
    return {
      allowed: false,
      sizeUsdc: 0,
      kellyFull,
      kellyConservative,
      reason: `Kelly size too small: $${sizeUsdc.toFixed(2)} < minimum $${MIN_POSITION}`
    }
  }

  // Scale down slightly after consecutive wins (variance management)
  const winScaleFactor = state.consecutiveWins >= 2 ? 0.85 : 1.0
  const finalSize = Math.round(sizeUsdc * winScaleFactor * 100) / 100

  return {
    allowed: true,
    sizeUsdc: finalSize,
    kellyFull,
    kellyConservative,
    reason: `Kelly×25%: $${finalSize.toFixed(2)} | edge: ${(edge * 100).toFixed(1)}% | bankroll: $${state.currentBankroll.toFixed(2)}`
  }
}

// ── After-trade state updater ────────────────────────────────

export function updateStateAfterTrade(
  state: BotState,
  won: boolean,
  pnl: number
): Partial<BotState> {
  const consecutiveLosses = won ? 0 : state.consecutiveLosses + 1
  const consecutiveWins = won ? state.consecutiveWins + 1 : 0
  const pausedUntil = consecutiveLosses >= 3
    ? new Date(Date.now() + 30 * 60 * 1000).toISOString() // 30 min cooldown
    : null

  return {
    consecutiveLosses,
    consecutiveWins,
    pausedUntil,
    currentBankroll: state.currentBankroll + pnl,
    totalTrades: state.totalTrades + 1,
    totalWins: state.totalWins + (won ? 1 : 0),
    totalPnl: state.totalPnl + pnl
  }
}
