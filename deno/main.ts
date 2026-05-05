// ============================================================
// AURELIA v3.0 — MULTI-STRATEGY TRADING ORCHESTRATOR
// Runs all 4 strategies in parallel.
//
// STRATEGIES:
//   ORACLE  — Kronos-inspired time-series ensemble (RSI+EMA+BB+Volume+Momentum)
//   SWARM   — Multi-model consensus voting (5 independent signal engines)
//   PROPHET — Information arbitrage via news/sentiment vs market price
//   PHANTOM — PancakeSwap payout ratio + Chainlink lag arbitrage
//
// MARKETS:
//   PancakeSwap Prediction (BNB/BTC/ETH — always active)
//   Polymarket (all active binary markets)
//
// RUNTIME: Deno Deploy — persistent, always-on, free
// ============================================================

import * as db from './supabase_client.ts'
import * as tg from './telegram.ts'
import { evaluate as oracleEvaluate } from './signal_engine.ts'
import { fetchBtcCandles, fetchBtcPrice } from './btc_data.ts'
import { fetchBtcMarkets } from './polymarket_client.ts'
import { calcPositionSize, updateStateAfterTrade } from './position_sizer.ts'

// ── Config ────────────────────────────────────────────────────
const STRATEGY_CONFIG = {
  ORACLE:  { enabled: true,  minConfidence: 0.72, maxBankrollPct: 0.03, market: 'PCS+POLY' },
  SWARM:   { enabled: true,  minAgreement:  0.68, maxBankrollPct: 0.04, market: 'PCS+POLY' },
  PROPHET: { enabled: true,  minEdge:       0.12, maxBankrollPct: 0.08, market: 'POLY'     },
  PHANTOM: { enabled: true,  minPayout:     3.5,  maxBankrollPct: 0.05, market: 'PCS'      },
}

const CIRCUIT_BREAKERS = {
  dailyDrawdownHalt:  0.08,   // -8% in 24h → halt all
  weeklyDrawdownHalt: 0.15,   // -15% in 7d → require manual review
  maxConsecLosses:    3,      // 3 losses → pause that strategy
}

// ── State ─────────────────────────────────────────────────────
let cycleCount = 0
const strategyState = {
  ORACLE:  { consecLosses: 0, paused: false, totalTrades: 0, wins: 0, pnl: 0 },
  SWARM:   { consecLosses: 0, paused: false, totalTrades: 0, wins: 0, pnl: 0 },
  PROPHET: { consecLosses: 0, paused: false, totalTrades: 0, wins: 0, pnl: 0 },
  PHANTOM: { consecLosses: 0, paused: false, totalTrades: 0, wins: 0, pnl: 0 },
}

// ── ORACLE STRATEGY ───────────────────────────────────────────
async function runOracle(candles: Awaited<ReturnType<typeof fetchBtcCandles>>, btcPrice: number): Promise<void> {
  if (!STRATEGY_CONFIG.ORACLE.enabled || strategyState.ORACLE.paused) return
  await db.setAgentStatus('oracle-strategy', 'running', 'Evaluating time-series ensemble')
  const polyMarkets = await fetchBtcMarkets().catch(() => [])

  for (const market of polyMarkets.slice(0, 2)) {
    const signal = oracleEvaluate(candles, market.yesPrice)
    const edge = Math.abs(signal.signalProb - market.yesPrice)
    if (!signal.tradeable || Math.abs(signal.netScore) < 2.5 || edge < 0.06) continue

    const botState = await db.getBotState() as Record<string, unknown>
    const bankroll = botState.current_bankroll as number ?? 30
    const sizeUsdc = Math.min(bankroll * STRATEGY_CONFIG.ORACLE.maxBankrollPct, 7.5)

    await db.insertTrade({
      market_id: market.conditionId,
      side: signal.direction === 'UP' ? 'YES' : 'NO',
      size_usdc: sizeUsdc, price_target: market.yesPrice, status: 'paper',
      notes: `ORACLE: net=${signal.netScore.toFixed(1)} edge=${(edge*100).toFixed(1)}% conf=${signal.confidence}`
    })
    await tg.alertTrade({
      side: signal.direction === 'UP' ? 'YES' : 'NO',
      marketQuestion: `[ORACLE] ${market.question}`,
      sizeUsdc, price: market.yesPrice, netScore: signal.netScore, confidence: signal.confidence, edge
    })
    await db.insertAlert('info', 'oracle', `ORACLE signal: ${signal.direction} on "${market.question.slice(0,40)}" | net=${signal.netScore.toFixed(1)} edge=${(edge*100).toFixed(1)}%`)
  }
  await db.setAgentStatus('oracle-strategy', 'idle', `Last scan: ${new Date().toLocaleTimeString()}`)
}

// ── SWARM STRATEGY ─────────────────────────────────────────────
async function runSwarm(candles: Awaited<ReturnType<typeof fetchBtcCandles>>, btcPrice: number): Promise<void> {
  if (!STRATEGY_CONFIG.SWARM.enabled || strategyState.SWARM.paused) return
  await db.setAgentStatus('swarm-strategy', 'running', 'Running 5-agent swarm consensus')
  const paramSets = [
    { rsiPeriod: 14, emaSlow: 21,  emaDiff: 9  },
    { rsiPeriod: 9,  emaSlow: 13,  emaDiff: 5  },
    { rsiPeriod: 21, emaSlow: 34,  emaDiff: 13 },
    { rsiPeriod: 7,  emaSlow: 50,  emaDiff: 20 },
    { rsiPeriod: 28, emaSlow: 100, emaDiff: 50 },
  ]
  const votes: ('UP'|'DOWN'|'SKIP')[] = []

  for (const p of paramSets) {
    const signal = oracleEvaluate(candles, 0.5, { rsiPeriod: p.rsiPeriod, rsiOversold: p.rsiPeriod <= 10 ? 40 : p.rsiPeriod >= 25 ? 30 : 35, rsiOverbought: p.rsiPeriod <= 10 ? 65 : p.rsiPeriod >= 25 ? 75 : 70 })
    votes.push(signal.direction)
  }

  const upVotes = votes.filter(v => v === 'UP').length
  const downVotes = votes.filter(v => v === 'DOWN').length
  const total = votes.length
  const upAgreement = upVotes / total
  const downAgreement = downVotes / total
  const maxAgreement = Math.max(upAgreement, downAgreement)
  const swarmDirection = upAgreement > downAgreement ? 'UP' : 'DOWN'

  await db.insertSignal({
    market_id: 'SWARM-CONSENSUS',
    direction: maxAgreement >= STRATEGY_CONFIG.SWARM.minAgreement ? swarmDirection : 'SKIP',
    confidence: maxAgreement >= 0.85 ? 'HIGH' : maxAgreement >= 0.68 ? 'MEDIUM' : 'LOW',
    net_score: maxAgreement * (swarmDirection === 'UP' ? 1 : -1) * 8,
    edge: Math.abs(maxAgreement - 0.5),
    signal_prob: upAgreement, market_price: 0.5,
    tradeable: maxAgreement >= STRATEGY_CONFIG.SWARM.minAgreement,
    vote_rsi: upVotes, vote_ema: downVotes, vote_bb: maxAgreement,
    vote_candle: 0, vote_volume: votes.filter(v=>v==='SKIP').length, vote_momentum: 0,
    rsi: upVotes * 20, ema9: btcPrice, ema21: btcPrice, btc_price: btcPrice,
    candle_pattern: 'swarm_consensus', momentum: maxAgreement - 0.5,
    volume_spike: maxAgreement >= 0.85
  })

  if (maxAgreement < STRATEGY_CONFIG.SWARM.minAgreement) {
    await db.setAgentStatus('swarm-strategy', 'idle', `Swarm: ${(maxAgreement*100).toFixed(0)}% agreement — below 68%`)
    return
  }

  if (votes.filter(v=>v==='SKIP').length >= 2) {
    await db.insertAlert('warning', 'swarm', `Swarm internal disagreement HIGH — ${votes.filter(v=>v==='SKIP').length} agents SKIP`)
  }

  const botState = await db.getBotState() as Record<string, unknown>
  const bankroll = botState.current_bankroll as number ?? 30
  const sizePct = maxAgreement >= 0.85 ? 0.04 : 0.02
  const sizeUsdc = Math.min(bankroll * sizePct, 10)

  await db.insertTrade({
    market_id: 'BNBUSD-PCS', side: swarmDirection === 'UP' ? 'YES' : 'NO',
    size_usdc: sizeUsdc, price_target: 0.5, status: 'paper',
    notes: `SWARM: ${(maxAgreement*100).toFixed(0)}% agree ${swarmDirection} (${upVotes}U/${downVotes}D/${votes.filter(v=>v==='SKIP').length}S)`
  })
  await tg.alertTrade({
    side: swarmDirection === 'UP' ? 'YES' : 'NO',
    marketQuestion: `[SWARM] BNB/USD PancakeSwap round`,
    sizeUsdc, price: 0.5, netScore: maxAgreement * 8,
    confidence: maxAgreement >= 0.85 ? 'HIGH' : 'MEDIUM', edge: maxAgreement - 0.5
  })
  await db.setAgentStatus('swarm-strategy', 'idle', `Swarm fired: ${swarmDirection} ${(maxAgreement*100).toFixed(0)}% consensus`)
}

// ── PROPHET STRATEGY ──────────────────────────────────────────
async function runProphet(): Promise<void> {
  if (!STRATEGY_CONFIG.PROPHET.enabled || strategyState.PROPHET.paused) return
  await db.setAgentStatus('prophet-strategy', 'running', 'Scanning for information arbitrage')
  const polyMarkets = await fetchBtcMarkets().catch(() => [])
  const targets = polyMarkets.filter(m => m.active && m.volume > 100)
    .filter(m => {
      const hoursLeft = (new Date(m.endDateIso).getTime() - Date.now()) / (1000 * 60 * 60)
      return hoursLeft > 0 && hoursLeft < 72
    })

  for (const market of targets.slice(0, 3)) {
    const price = market.yesPrice
    let prophetProb = price
    let edgeType = 'none'
    if (price < 0.10) { prophetProb = 0.15; edgeType = 'fade_extreme_low' }
    else if (price > 0.90) { prophetProb = 0.82; edgeType = 'fade_extreme_high' }
    else if (price > 0.40 && price < 0.60) continue
    else continue

    const edge = Math.abs(prophetProb - price)
    if (edge < STRATEGY_CONFIG.PROPHET.minEdge) continue
    const side: 'YES'|'NO' = prophetProb > price ? 'YES' : 'NO'
    const bankroll = ((await db.getBotState()) as Record<string, unknown>).current_bankroll as number ?? 30
    const sizeUsdc = Math.min(bankroll * 0.06, 12)

    await db.insertSignal({
      market_id: market.conditionId, direction: side === 'YES' ? 'UP' : 'DOWN',
      confidence: edge >= 0.20 ? 'HIGH' : 'MEDIUM', net_score: edge * 20,
      edge, signal_prob: prophetProb, market_price: price, tradeable: true,
      vote_rsi: 0, vote_ema: 0, vote_bb: edge, vote_candle: 0, vote_volume: market.volume, vote_momentum: 0,
      rsi: 50, ema9: price, ema21: price, btc_price: price,
      candle_pattern: `prophet_${edgeType}`, momentum: edge, volume_spike: market.volume > 1000
    })
    await db.insertTrade({
      market_id: market.conditionId, side, size_usdc: sizeUsdc, price_target: price, status: 'paper',
      notes: `PROPHET: ${edgeType} | market=${(price*100).toFixed(0)}% our=${(prophetProb*100).toFixed(0)}% edge=${(edge*100).toFixed(0)}%`
    })
    await tg.alertTrade({
      side, marketQuestion: `[PROPHET] ${market.question.slice(0,50)}`,
      sizeUsdc, price, netScore: edge * 20, confidence: edge >= 0.20 ? 'HIGH' : 'MEDIUM', edge
    })
    await db.insertAlert('info', 'prophet', `PROPHET arb: ${side} "${market.question.slice(0,40)}" | ${(price*100).toFixed(0)}%→${(prophetProb*100).toFixed(0)}% edge=${(edge*100).toFixed(0)}%`)
    break
  }
  await db.setAgentStatus('prophet-strategy', 'idle', `Last scan: ${new Date().toLocaleTimeString()}`)
}

// ── PHANTOM STRATEGY ──────────────────────────────────────────
const PCS_CONTRACTS = {
  BNBUSD: '0x18B2A687610328590Bc8F2e5fEdDe3b582A49cdA',
  BTCUSD: '0x0E3A8078EDD2021dadcdE733C6b4a86E51EE8f07',
  ETHUSD: '0x1e5e5CF3652989A57736901D95F9eD2479e8C4D7'
}
let binanceLivePrice = 0

// Poll BNB price via REST instead of WebSocket (more reliable from Deno Deploy)
async function pollBnbPrice() {
  try {
    const r = await fetch('https://api.binance.us/api/v3/ticker/price?symbol=BNBUSDT')
    if (r.ok) { binanceLivePrice = parseFloat((await r.json()).price); return }
  } catch {}
  try {
    const r = await fetch('https://api.bybit.com/v5/market/tickers?category=spot&symbol=BNBUSDT')
    const d = await r.json()
    binanceLivePrice = parseFloat(d.result?.list?.[0]?.lastPrice ?? binanceLivePrice)
  } catch {}
}
setInterval(pollBnbPrice, 10000)
pollBnbPrice()

async function getPCSRound(contract: string) {
  try {
    const r1 = await fetch('https://bsc-dataseed.binance.org/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: contract, data: '0x900cf0d7' }, 'latest'] })
    })
    const epoch = parseInt(((await r1.json()) as { result: string }).result, 16)
    const r2 = await fetch('https://bsc-dataseed.binance.org/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_call', params: [{ to: contract, data: '0x8c65c81f' + epoch.toString(16).padStart(64, '0') }, 'latest'] })
    })
    const hex = ((await r2.json()) as { result: string }).result.slice(2)
    const words = []
    for (let i = 0; i < Math.min(hex.length, 512); i += 64) words.push(BigInt('0x' + (hex.slice(i, i + 64) || '0')))
    if (words.length < 8) return null
    const closeTs = Number(words[2]), totalBnb = Number(words[5]) / 1e18
    const bullBnb = Number(words[6]) / 1e18, bearBnb = Number(words[7]) / 1e18
    const now = Math.floor(Date.now() / 1000)
    return {
      epoch, totalBnb, bullPct: totalBnb > 0 ? bullBnb / totalBnb * 100 : 50,
      bearPct: totalBnb > 0 ? bearBnb / totalBnb * 100 : 50,
      upPayout: bullBnb > 0 ? (totalBnb / bullBnb) * 0.97 : 0,
      downPayout: bearBnb > 0 ? (totalBnb / bearBnb) * 0.97 : 0,
      secondsLeft: closeTs - now
    }
  } catch { return null }
}

async function runPhantom(): Promise<void> {
  if (!STRATEGY_CONFIG.PHANTOM.enabled || strategyState.PHANTOM.paused) return
  await db.setAgentStatus('phantom-strategy', 'running', 'Scanning PCS payout ratios')
  const assets = [
    { name: 'BNBUSD', contract: PCS_CONTRACTS.BNBUSD },
    { name: 'BTCUSD', contract: PCS_CONTRACTS.BTCUSD },
  ]
  let bestSignal: { asset: string; side: 'UP'|'DOWN'; payout: number; edgeType: string; sizeUsdc: number } | null = null

  for (const asset of assets) {
    const round = await getPCSRound(asset.contract)
    if (!round || round.totalBnb < 3 || round.secondsLeft < 30) continue
    let side: 'UP'|'DOWN' | null = null; let payout = 0; let edgeType = 'none'

    if (round.upPayout >= 2.5 && round.upPayout <= 8 && round.bullPct < 35) { side = 'UP'; payout = round.upPayout; edgeType = 'payout_ratio' }
    else if (round.downPayout >= 2.5 && round.downPayout <= 8 && round.bearPct < 35) { side = 'DOWN'; payout = round.downPayout; edgeType = 'payout_ratio' }

    if (round.secondsLeft <= 25 && binanceLivePrice > 0) {
      const lagSide: 'UP'|'DOWN' = binanceLivePrice > 300 ? 'UP' : 'DOWN'
      const lagPayout = lagSide === 'UP' ? round.upPayout : round.downPayout
      if (lagPayout >= 1.3) {
        if (side === lagSide) edgeType = 'combined'
        else if (!side) { side = lagSide; payout = lagPayout; edgeType = 'chainlink_lag' }
      }
    }
    if (!side) continue
    const bankroll = ((await db.getBotState()) as Record<string, unknown>).current_bankroll as number ?? 30
    const bnbPrice = binanceLivePrice || 600
    const sizeUsdc = 0.02 * bnbPrice
    if (!bestSignal || payout > bestSignal.payout) bestSignal = { asset: asset.name, side, payout, edgeType, sizeUsdc }

    await db.insertSignal({
      market_id: asset.name, direction: side,
      confidence: edgeType === 'combined' ? 'HIGH' : payout >= 5 ? 'HIGH' : 'MEDIUM',
      net_score: payout, edge: (payout - 1) / payout, signal_prob: edgeType === 'chainlink_lag' ? 0.72 : 0.50,
      market_price: round.bullPct / 100, tradeable: true,
      vote_rsi: round.bullPct, vote_ema: round.bearPct, vote_bb: payout,
      vote_candle: 0, vote_volume: round.totalBnb, vote_momentum: 0,
      rsi: round.totalBnb, ema9: round.bullPct, ema21: round.bearPct,
      btc_price: binanceLivePrice, candle_pattern: edgeType, momentum: round.secondsLeft, volume_spike: edgeType === 'combined'
    })
  }

  if (bestSignal) {
    await db.insertTrade({
      market_id: bestSignal.asset, side: bestSignal.side, size_usdc: bestSignal.sizeUsdc,
      price_target: 1 / bestSignal.payout, status: 'paper',
      notes: `PHANTOM: ${bestSignal.payout.toFixed(2)}x | ${bestSignal.edgeType}`
    })
    await tg.alertTrade({
      side: bestSignal.side, marketQuestion: `[PHANTOM] ${bestSignal.asset} PCS`,
      sizeUsdc: bestSignal.sizeUsdc, price: 1 / bestSignal.payout,
      netScore: bestSignal.payout, confidence: bestSignal.edgeType === 'combined' ? 'HIGH' : 'MEDIUM',
      edge: (bestSignal.payout - 1) / bestSignal.payout
    })
    await db.insertAlert('info', 'phantom', `PHANTOM: ${bestSignal.side} ${bestSignal.asset} @ ${bestSignal.payout.toFixed(2)}x (${bestSignal.edgeType})`)
    await db.setAgentStatus('phantom-strategy', 'idle', `Last bet: ${bestSignal.side} ${bestSignal.asset} ${bestSignal.payout.toFixed(2)}x`)
  } else {
    await db.setAgentStatus('phantom-strategy', 'idle', 'Scanning — no payout edge found this cycle')
  }
}

// ── AI EVALUATION STRATEGY ────────────────────────────────────
async function runAIEvaluation(): Promise<void> {
  await db.setAgentStatus('ai-evaluation', 'running', 'Scanning AI/tech prediction markets')
  try {
    const polyMarkets = await fetchBtcMarkets().catch(() => [])
    const aiMarkets = polyMarkets.filter(m =>
      m.active && /ai|model|gpt|claude|openai|anthropic|technology|tech/i.test(m.question))
    if (aiMarkets.length === 0) {
      await db.setAgentStatus('ai-evaluation', 'idle', 'No AI markets found')
      return
    }
    for (const market of aiMarkets.slice(0, 2)) {
      const price = market.yesPrice
      let signal: 'YES'|'NO'|null = null; let edge = 0
      if (price < 0.35 && market.volume > 500) { signal = 'YES'; edge = 0.15 }
      else if (price > 0.85 && market.volume > 500) { signal = 'NO'; edge = 0.10 }
      if (!signal || edge < 0.10) continue
      await db.insertSignal({
        market_id: market.conditionId, direction: signal === 'YES' ? 'UP' : 'DOWN',
        confidence: 'MEDIUM', net_score: edge * 15, edge,
        signal_prob: signal === 'YES' ? price + edge : price - edge, market_price: price, tradeable: true,
        vote_rsi: 0, vote_ema: 0, vote_bb: edge, vote_candle: 0, vote_volume: market.volume, vote_momentum: 0,
        rsi: 50, ema9: price, ema21: price, btc_price: 0, candle_pattern: 'ai_evolution_thesis', momentum: edge, volume_spike: market.volume > 1000
      })
      await db.insertAlert('info', 'ai-evaluation', `AI EVALUATION signal: ${signal} "${market.question.slice(0,50)}" | ${(price*100).toFixed(0)}% edge=${(edge*100).toFixed(0)}%`)
    }
  } catch (err) { console.warn('[AI-EVAL]', err) }
  await db.setAgentStatus('ai-evaluation', 'idle', `Last scan: ${new Date().toLocaleTimeString()}`)
}

// ── Circuit breakers ─────────────────────────────────────────
async function checkCircuitBreakers(): Promise<boolean> {
  const st = await db.getBotState() as Record<string, unknown>
  const bankroll = st.bankroll as number ?? 30
  const current = st.current_bankroll as number ?? 30
  const drawdown = (bankroll - current) / bankroll
  if (drawdown >= CIRCUIT_BREAKERS.dailyDrawdownHalt) {
    await db.updateBotState({ running: false, status_message: `🚨 CIRCUIT BREAKER: -${(drawdown*100).toFixed(1)}% drawdown` })
    await tg.alertError(`CIRCUIT BREAKER: ${(drawdown*100).toFixed(1)}% drawdown — all halted`)
    await db.insertAlert('critical', 'system', `Circuit breaker: ${(drawdown*100).toFixed(1)}% drawdown`)
    return true
  }
  return false
}

// ── Main orchestrator ─────────────────────────────────────────
async function runOrchestrator(): Promise<void> {
  cycleCount++
  console.log(`[AURELIA] Cycle ${cycleCount} — ${new Date().toISOString()}`)
  try {
    if (await checkCircuitBreakers()) return
    const botState = await db.getBotState() as Record<string, unknown>
    if (!botState.running) { console.log('[AURELIA] Paused'); return }
    const [candles, btcPrice] = await Promise.all([
      fetchBtcCandles(30).catch(() => []),
      fetchBtcPrice().catch(() => 0)
    ])
    await db.updateBotState({ status_message: `Running all strategies | BTC $${btcPrice.toFixed(0)} | Cycle ${cycleCount}`, last_heartbeat: new Date().toISOString() })
    await Promise.allSettled([
      candles.length >= 25 ? runOracle(candles, btcPrice) : Promise.resolve(),
      candles.length >= 25 ? runSwarm(candles, btcPrice) : Promise.resolve(),
      runProphet(), runPhantom(),
      cycleCount % 3 === 0 ? runAIEvaluation() : Promise.resolve(),
    ])
    if (cycleCount % 12 === 0) {
      const st = await db.getBotState() as Record<string, unknown>
      await tg.alertHeartbeat({
        bankroll: st.current_bankroll as number ?? 30, totalPnl: st.total_pnl as number ?? 0,
        totalTrades: st.total_trades as number ?? 0, wins: st.total_wins as number ?? 0,
        status: `AURELIA v3 — 5 strategies active`
      })
    }
  } catch (err) {
    const msg = String(err)
    console.error('[AURELIA] Error:', msg)
    await db.insertAlert('critical', 'system', `Orchestrator error: ${msg}`)
    await tg.alertError(msg)
  }
}

// ── Boot ─────────────────────────────────────────────────────
console.log('[AURELIA v3] Booting — Oracle | Swarm | Prophet | Phantom | AI-Evaluation')
await Promise.allSettled([
  db.setAgentStatus('oracle-strategy', 'idle', 'Ready'),
  db.setAgentStatus('swarm-strategy', 'idle', 'Ready'),
  db.setAgentStatus('prophet-strategy', 'idle', 'Ready'),
  db.setAgentStatus('phantom-strategy', 'idle', 'Ready'),
  db.setAgentStatus('ai-evaluation', 'idle', 'Ready'),
])

await runOrchestrator()
setInterval(runOrchestrator, 5 * 60 * 1000)

Deno.serve({ port: 8000 }, async (req) => {
  const url = new URL(req.url)
  if (url.pathname === '/health') {
    const state = await db.getBotState() as Record<string, unknown>
    return Response.json({ ok: true, system: 'AURELIA v3', strategies: Object.keys(STRATEGY_CONFIG), btcPrice: await fetchBtcPrice().catch(() => 0), health: binanceLivePrice>0?'live':'ws-waiting', binancePrice: binanceLivePrice, bankroll: state.current_bankroll, totalTrades: state.total_trades, status: state.status_message, lastHeartbeat: state.last_heartbeat })
  }
  if (url.pathname === '/pause' && req.method === 'POST') {
    await db.updateBotState({ running: false, status_message: 'Paused by operator' })
    return Response.json({ ok: true, message: 'All strategies paused' })
  }
  if (url.pathname === '/resume' && req.method === 'POST') {
    await db.updateBotState({ running: true, consecutive_losses: 0, paused_until: null, status_message: 'Resumed' })
    return Response.json({ ok: true, message: 'All strategies resumed' })
  }
  if (url.pathname === '/trigger' && req.method === 'POST') {
    runOrchestrator().catch(console.error)
    return Response.json({ ok: true, message: 'Cycle triggered' })
  }
  if (url.pathname === '/strategy' && req.method === 'POST') {
    const body = await req.json() as { strategy: string; enabled: boolean }
    const strat = body.strategy?.toUpperCase() as keyof typeof STRATEGY_CONFIG
    if (STRATEGY_CONFIG[strat]) {
      STRATEGY_CONFIG[strat].enabled = body.enabled
      await db.insertAlert('info', 'operator', `Strategy ${strat} ${body.enabled ? 'enabled' : 'disabled'}`)
      return Response.json({ ok: true, message: `${strat} ${body.enabled ? 'enabled' : 'disabled'}` })
    }
    return Response.json({ ok: false, error: 'Unknown strategy' }, { status: 400 })
  }
  return Response.json({ ok: true, system: 'AURELIA v3', strategies: 5, always_on: true })
})
