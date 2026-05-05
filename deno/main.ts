// ============================================================
// POLYMARKET TRADING BOT — MAIN ENTRY POINT
// Runs on Deno Deploy as a persistent HTTP server
// Connects to Polymarket WebSocket for live price data
// Evaluates signals every 5-min candle close
// ============================================================

import { evaluate } from './signal_engine.ts'
import { evaluateEnsemble } from './strategy_ensemble.ts'
import { calcPositionSize, updateStateAfterTrade } from './position_sizer.ts'
import { fetchBtcMarkets, placeOrder, fetchOrderStatus } from './polymarket_client.ts'
import { fetchBtcCandles } from './btc_data.ts'
import * as db from './supabase_client.ts'
import * as tg from './telegram.ts'

// ── State ────────────────────────────────────────────────────

let lastCandleTs = 0           // timestamp of last processed candle
const pendingOrders = new Map<string, {
  tradeId: number
  marketId: string
  marketQuestion: string
  side: 'YES' | 'NO'
  sizeUsdc: number
}>()

// ── Core trading loop ─────────────────────────────────────────

async function runTradingCycle(): Promise<void> {
  console.log('[Bot] Running trading cycle...')

  try {
    await db.setAgentStatus('trading-bot', 'running', 'Fetching market data')

    // 1. Get BTC candles (30 × 5-min)
    const candles = await fetchBtcCandles(30)
    if (candles.length < 25) {
      console.warn('[Bot] Not enough candles, skipping cycle')
      return
    }

    // 2. Check if we have a new candle close (avoid re-processing same candle)
    const latestTs = candles[candles.length - 1].ts
    if (latestTs <= lastCandleTs) {
      console.log('[Bot] No new candle, waiting...')
      return
    }
    lastCandleTs = latestTs

    // 3. Get active BTC markets from Polymarket
    const markets = await fetchBtcMarkets()
    if (markets.length === 0) {
      console.warn('[Bot] No active BTC markets found')
      await db.setAgentStatus('trading-bot', 'idle', 'No active markets')
      return
    }

    // 4. Get bot state from DB
    const rawState = await db.getBotState()
    const state = {
      running: rawState.running as boolean ?? true,
      consecutiveLosses: rawState.consecutive_losses as number ?? 0,
      consecutiveWins: rawState.consecutive_wins as number ?? 0,
      pausedUntil: rawState.paused_until as string | null,
      currentBankroll: rawState.current_bankroll as number ?? 30,
      totalTrades: rawState.total_trades as number ?? 0,
      totalWins: rawState.total_wins as number ?? 0,
      totalPnl: rawState.total_pnl as number ?? 0
    }

    // 5. Update heartbeat
    await db.updateBotState({ status_message: 'Evaluating signals' })

    // 6. For each market, run signal engine (pick first active one for now)
    // BTC 5-min markets expire quickly — focus on the one expiring soonest
    const targetMarket = markets
      .filter(m => m.active && m.volume > 10)
      .sort((a, b) => new Date(a.endDateIso).getTime() - new Date(b.endDateIso).getTime())[0]

    if (!targetMarket) {
      await db.setAgentStatus('trading-bot', 'idle', 'No liquid markets')
      return
    }

    // Upsert market to DB
    await db.upsertMarket({
      id: targetMarket.conditionId,
      question: targetMarket.question,
      end_date_iso: targetMarket.endDateIso,
      yes_price: targetMarket.yesPrice,
      no_price: targetMarket.noPrice,
      volume: targetMarket.volume,
      active: true
    })

    // 7. Run ensemble (multi-strategy) + original quant (detailed data)
    const quant = evaluate(candles, targetMarket.yesPrice)
    const ensemble = evaluateEnsemble(candles, targetMarket.yesPrice)

    console.log(`[Ensemble] ${ensemble.votes.map(v => v.name + '=' + v.direction + '(' + v.confidence + ')').join(' | ')}`)
    console.log(`[Signal] consensus=${ensemble.consensus} net=${ensemble.netScore.toFixed(2)} tradeable=${ensemble.tradeable} (original quant: ${quant.direction} net=${quant.netScore.toFixed(1)})`)

    // 8. Save signal to DB (use quant data for raw indicators, ensemble for decision)
    const signalId = await db.insertSignal({
      market_id: targetMarket.conditionId,
      rsi: quant.rsi,
      ema9: quant.ema9,
      ema21: quant.ema21,
      bb_upper: quant.bbUpper,
      bb_lower: quant.bbLower,
      bb_mid: quant.bbMid,
      btc_price: quant.btcPrice,
      volume_spike: quant.volumeSpike,
      candle_pattern: quant.candlePattern,
      momentum: quant.momentum,
      vote_rsi: quant.voteRsi,
      vote_ema: quant.voteEma,
      vote_bb: quant.voteBb,
      vote_candle: quant.voteCandle,
      vote_volume: quant.voteVolume,
      vote_momentum: quant.voteMomentum,
      net_score: ensemble.netScore,  // use ensemble net score
      direction: ensemble.consensus,  // use ensemble consensus
      confidence: ensemble.confidence,
      edge: ensemble.edge,
      signal_prob: ensemble.signalProb,
      market_price: targetMarket.yesPrice,
      tradeable: ensemble.tradeable
    })

    // 9. If not tradeable, update status and return
    if (!ensemble.tradeable) {
      const voteInfo = ensemble.votes.map(v => `${v.name}:${v.direction}`).join(' ')
      await db.setAgentStatus('trading-bot', 'running', `Ensemble: ${ensemble.consensus} (${ensemble.confidence}) — waiting for edge`)
      await db.updateBotState({ status_message: `Signal ${ensemble.consensus} net=${ensemble.netScore.toFixed(1)} | ${voteInfo}` })
      return
    }

    // 10. Calculate position size
    const tradeSide: 'YES' | 'NO' = ensemble.consensus === 'UP' ? 'YES' : 'NO'
    const marketOdds = tradeSide === 'YES' ? targetMarket.yesPrice : targetMarket.noPrice
    const edge = ensemble.edge

    const sizing = calcPositionSize(state, ensemble.signalProb, marketOdds, edge)

    if (!sizing.allowed) {
      console.log(`[Bot] Trade blocked: ${sizing.reason}`)
      await db.setAgentStatus('trading-bot', 'paused', sizing.reason)
      await db.updateBotState({ status_message: sizing.reason })
      return
    }

    console.log(`[Bot] Placing ${tradeSide} $${sizing.sizeUsdc} on ${targetMarket.question}`)

    // 11. Place order
    const orderResult = await placeOrder({
      marketId: targetMarket.conditionId,
      side: tradeSide,
      price: marketOdds,
      sizeUsdc: sizing.sizeUsdc
    })

    // 12. Save trade to DB
    const tradeId = await db.insertTrade({
      signal_id: signalId,
      market_id: targetMarket.conditionId,
      side: tradeSide,
      size_usdc: sizing.sizeUsdc,
      price_target: marketOdds,
      order_id: orderResult.orderId ?? null,
      status: orderResult.success ? 'pending' : 'failed',
      notes: orderResult.success ? sizing.reason : orderResult.error
    })

    if (orderResult.success) {
      // Track this order for resolution monitoring
      pendingOrders.set(orderResult.orderId!, {
        tradeId,
        marketId: targetMarket.conditionId,
        marketQuestion: targetMarket.question,
        side: tradeSide,
        sizeUsdc: sizing.sizeUsdc
      })

      // Send Telegram alert
      await tg.alertTrade({
        side: tradeSide,
        marketQuestion: targetMarket.question,
        sizeUsdc: sizing.sizeUsdc,
        price: marketOdds,
        netScore: signal.netScore,
        confidence: signal.confidence,
        edge
      })

      await db.insertAlert('info', 'bot',
        `Trade placed: ${tradeSide} $${sizing.sizeUsdc.toFixed(2)} on "${targetMarket.question}"`)

      await db.updateBotState({
        last_trade_at: new Date().toISOString(),
        total_trades: state.totalTrades + 1,
        status_message: `Active trade: ${tradeSide} $${sizing.sizeUsdc.toFixed(2)}`
      })

      await db.setAgentStatus('trading-bot', 'running',
        `Order placed: ${tradeSide} $${sizing.sizeUsdc.toFixed(2)}`)
    } else {
      console.error('[Bot] Order failed:', orderResult.error)
      await db.insertAlert('warning', 'bot', `Order failed: ${orderResult.error}`)
      await tg.alertError(`Order failed: ${orderResult.error}`)
    }

  } catch (err) {
    const msg = String(err)
    console.error('[Bot] Cycle error:', msg)
    await db.insertAlert('critical', 'bot', `Cycle error: ${msg}`)
    await tg.alertError(msg)
    await db.setAgentStatus('trading-bot', 'error', msg)
  }
}

// ── Order resolution monitor ──────────────────────────────────

async function checkPendingOrders(): Promise<void> {
  for (const [orderId, order] of pendingOrders.entries()) {
    try {
      const status = await fetchOrderStatus(orderId)
      if (status.status === 'MATCHED' || status.status === 'FILLED') {
        const filledPrice = status.filledPrice ?? order.sizeUsdc
        const filledSize = status.filledSize ?? order.sizeUsdc

        // Simple P&L: if YES and market resolves YES → payout is 1 USDC per YES token
        // Full resolution tracking requires polling market resolution — simplified here
        await db.updateTrade(order.tradeId, {
          status: 'filled',
          filled_price: filledPrice,
          filled_size: filledSize
        })
        pendingOrders.delete(orderId)
      } else if (status.status === 'CANCELLED' || status.status === 'EXPIRED') {
        await db.updateTrade(order.tradeId, { status: 'cancelled' })
        pendingOrders.delete(orderId)
      }
    } catch (err) {
      console.warn(`[Bot] Could not check order ${orderId}:`, err)
    }
  }
}

// ── Hourly summary ────────────────────────────────────────────

async function sendHourlySummary(): Promise<void> {
  const state = await db.getBotState()
  await tg.alertHeartbeat({
    bankroll: state.current_bankroll as number ?? 30,
    totalPnl: state.total_pnl as number ?? 0,
    totalTrades: state.total_trades as number ?? 0,
    wins: state.total_wins as number ?? 0,
    status: state.status_message as string ?? 'Running'
  })
}

// ── Scheduler ────────────────────────────────────────────────

let cycleCount = 0

async function tick(): Promise<void> {
  cycleCount++
  await runTradingCycle()
  await checkPendingOrders()
  // Send hourly summary every 12 cycles (12 × 5min = 60min)
  if (cycleCount % 12 === 0) await sendHourlySummary()
}

// Run immediately, then every 5 minutes
await tick()
setInterval(tick, 5 * 60 * 1000)

// ── HTTP server (required by Deno Deploy) ────────────────────
// Deno Deploy requires an HTTP listener. We use it as a health
// check endpoint and a manual trigger.

Deno.serve({ port: 8000 }, async (req) => {
  const url = new URL(req.url)

  if (url.pathname === '/health') {
    const state = await db.getBotState()
    return Response.json({
      ok: true,
      status: state.status_message,
      bankroll: state.current_bankroll,
      totalTrades: state.total_trades,
      lastHeartbeat: state.last_heartbeat
    })
  }

  if (url.pathname === '/trigger' && req.method === 'POST') {
    // Manual trigger (e.g. from Aurelia or you)
    tick().catch(console.error)
    return Response.json({ ok: true, message: 'Cycle triggered' })
  }

  if (url.pathname === '/pause' && req.method === 'POST') {
    await db.updateBotState({ running: false, status_message: 'Paused by operator' })
    await tg.alertPause('Paused by operator via API')
    return Response.json({ ok: true, message: 'Bot paused' })
  }

  if (url.pathname === '/resume' && req.method === 'POST') {
    await db.updateBotState({
      running: true,
      consecutive_losses: 0,
      paused_until: null,
      status_message: 'Resumed by operator'
    })
    await tg.alertResume()
    return Response.json({ ok: true, message: 'Bot resumed' })
  }

  return Response.json({ ok: true, message: 'Polymarket Bot running' })
})
