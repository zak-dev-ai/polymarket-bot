// ============================================================
// PANCAKESWAP PREDICTION — Data fetcher + Payout Ratio Strategy
// Uses direct BSC RPC calls to the Prediction v2 contracts
// Watches BNB/USD, BTC/USD, ETH/USD rounds
// ============================================================

// ── Contract addresses (BNB Chain) ────────────────────────────
const CONTRACTS = {
  BNBUSD: { address: '0x18b2a687610328590bc8f2e5fedde3b582a49cda', asset: 'BNB/USD' },
  BTCUSD: { address: '0x48781a7d35f6137a9135Bbb984AF65fd6AB25618', asset: 'BTC/USD' },
  ETHUSD: { address: '0x7451F994A8D510CBCB46cF57D50F31F188Ff58F5', asset: 'ETH/USD' },
} as const

const RPC = 'https://bsc-dataseed1.binance.org'
const ROUNDS_SIG = '0x8c65c81f'  // rounds(uint256)
const EPOCH_SIG = '0x76671808'   // currentEpoch()

// ── Types ─────────────────────────────────────────────────────

export interface PredictionRound {
  epoch: number
  asset: string
  lockTimestamp: number
  closeTimestamp: number
  lockPrice: number | null
  closePrice: number | null
  totalAmount: number
  bullAmount: number
  bearAmount: number
  rewardBaseCalAmount: number
  rewardAmount: number
  oracleCalled: boolean
  payoutBull: number
  payoutBear: number
}

export interface PayoutSignal {
  asset: string
  epoch: number
  side: 'Bull' | 'Bear'
  payoutMultiplier: number
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
}

// ── RPC helpers ───────────────────────────────────────────────

async function rpcCall(to: string, data: string): Promise<string> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to, data }, 'latest']
    })
  })
  if (!res.ok) throw new Error(`RPC: ${res.status}`)
  const json = await res.json()
  if (json.error) throw new Error(`RPC error: ${json.error.message}`)
  return json.result
}

function padHex(n: number): string {
  return '0x' + n.toString(16).padStart(64, '0')
}

function hexToNumber(hex: string): number {
  return parseInt(hex, 16)
}

function hexToSignedNumber(hex: string): number {
  const val = BigInt(hex)
  // If > 2^255, it's negative in int256
  if (val >= BigInt('0x8000000000000000000000000000000000000000000000000000000000000000')) {
    return Number(val - BigInt('0x10000000000000000000000000000000000000000000000000000000000000000'))
  }
  return Number(val)
}

// ── Fetch current epoch ───────────────────────────────────────

async function fetchCurrentEpoch(contract: string): Promise<number> {
  const result = await rpcCall(contract, EPOCH_SIG)
  return hexToNumber(result)
}

// ── Fetch round data ─────────────────────────────────────────

async function fetchRound(contract: string, epoch: number): Promise<any> {
  const data = ROUNDS_SIG + padHex(epoch).slice(2)
  const result = await rpcCall(contract, data)

  // Remove 0x prefix, each value is 32 bytes (64 hex chars)
  const hex = result.slice(2)
  const values: string[] = []
  for (let i = 0; i < 14; i++) {
    values.push('0x' + hex.slice(i * 64, (i + 1) * 64))
  }

  return {
    epoch: hexToNumber(values[0]),
    startTimestamp: hexToNumber(values[1]),
    lockTimestamp: hexToNumber(values[2]),
    closeTimestamp: hexToNumber(values[3]),
    lockPrice: hexToSignedNumber(values[4]),
    closePrice: hexToSignedNumber(values[5]),
    lockOracleId: values[6],
    closeOracleId: values[7],
    totalAmount: hexToNumber(values[8]),
    bullAmount: hexToNumber(values[9]),
    bearAmount: hexToNumber(values[10]),
    rewardBaseCalAmount: hexToNumber(values[11]),
    rewardAmount: hexToNumber(values[12]),
    oracleCalled: values[13] !== '0x0000000000000000000000000000000000000000000000000000000000000000'
  }
}

// ── Price formatting ──────────────────────────────────────────

const ORACLE_PRICE_DECIMALS = 1_000_000  // price has 6 decimals

function oraclePrice(price: number): number {
  return price / ORACLE_PRICE_DECIMALS
}

// ── Fetch latest rounds for a contract ───────────────────────

async function fetchLatestRoundsForContract(
  address: string,
  asset: string,
  count = 5
): Promise<PredictionRound[]> {
  const currentEpoch = await fetchCurrentEpoch(address)
  const rounds: PredictionRound[] = []

  for (let i = Math.max(currentEpoch - count, 1); i <= currentEpoch; i++) {
    const r = await fetchRound(address, i)
    const bull = r.bullAmount
    const bear = r.bearAmount
    const total = bull + bear

    rounds.push({
      epoch: r.epoch,
      asset,
      lockTimestamp: r.lockTimestamp,
      closeTimestamp: r.closeTimestamp,
      lockPrice: r.lockPrice !== 0 ? oraclePrice(r.lockPrice) : null,
      closePrice: r.closePrice !== 0 ? oraclePrice(r.closePrice) : null,
      totalAmount: total,
      bullAmount: bull,
      bearAmount: bear,
      rewardBaseCalAmount: r.rewardBaseCalAmount,
      rewardAmount: r.rewardAmount,
      oracleCalled: r.oracleCalled,
      payoutBull: bull > 0 ? total / bull : 0,
      payoutBear: bear > 0 ? total / bear : 0
    })
  }

  return rounds
}

// ── Public API ────────────────────────────────────────────────

/**
 * Fetch latest rounds for all tracked assets.
 */
export async function fetchAllLatestRounds(count = 3): Promise<{
  rounds: PredictionRound[]
  signals: PayoutSignal[]
  timestamp: number
}> {
  const allRounds: PredictionRound[] = []
  const allSignals: PayoutSignal[] = []
  const timestamp = Date.now()

  for (const [key, cfg] of Object.entries(CONTRACTS)) {
    try {
      const rounds = await fetchLatestRoundsForContract(cfg.address, cfg.asset, count)
      allRounds.push(...rounds)

      // Check each round for payout opportunity
      for (const round of rounds) {
        const signal = findPayoutOpportunityForRound(round)
        if (signal) allSignals.push(signal)
      }
    } catch (err) {
      console.error(`[Pancake/${key}] Failed:`, err)
    }
  }

  return { rounds: allRounds, signals: allSignals, timestamp }
}

// ── Payout Ratio Strategy ─────────────────────────────────────

const MIN_PAYOUT = 3.5  // only signal when payout >= 3.5x

function findPayoutOpportunityForRound(round: PredictionRound): PayoutSignal | null {
  // Only open rounds (not yet closed)
  const now = Math.floor(Date.now() / 1000)
  const isOpen = round.lockTimestamp > now && !round.oracleCalled

  if (!isOpen) return null
  if (round.totalAmount < 1) return null  // skip rounds with negligible volume

  if (round.payoutBull >= MIN_PAYOUT) {
    return {
      asset: round.asset,
      epoch: round.epoch,
      side: 'Bull',
      payoutMultiplier: round.payoutBull,
      confidence: round.payoutBull >= 5 ? 'HIGH' : 'MEDIUM'
    }
  }

  if (round.payoutBear >= MIN_PAYOUT) {
    return {
      asset: round.asset,
      epoch: round.epoch,
      side: 'Bear',
      payoutMultiplier: round.payoutBear,
      confidence: round.payoutBear >= 5 ? 'HIGH' : 'MEDIUM'
    }
  }

  return null
}

/**
 * Find the best payout opportunity across all assets.
 */
export function findBestOpportunity(signals: PayoutSignal[]): PayoutSignal | null {
  if (signals.length === 0) return null
  return signals.reduce((best, s) =>
    s.payoutMultiplier > best.payoutMultiplier ? s : best
  )
}

// ── PnL Calculator ───────────────────────────────────────────

export function calcPayoutPnl(
  betAmount: number,
  payoutMultiplier: number,
  won: boolean
): number {
  if (!won) return -betAmount
  return betAmount * (payoutMultiplier - 1)
}
