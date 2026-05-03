// ============================================================
// TELEGRAM ALERTS
// Sends rich trade notifications to your Telegram
// No library needed — direct Bot API calls
// ============================================================

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID') ?? ''

async function send(text: string): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn('[Telegram] Not configured, skipping alert')
    return
  }
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: 'HTML'
    })
  })
}

export async function alertTrade(params: {
  side: 'YES' | 'NO'
  marketQuestion: string
  sizeUsdc: number
  price: number
  netScore: number
  confidence: string
  edge: number
}): Promise<void> {
  const emoji = params.side === 'YES' ? '🟢' : '🔴'
  const text = `
${emoji} <b>TRADE PLACED</b>
📋 <b>Market:</b> ${params.marketQuestion}
📊 <b>Side:</b> ${params.side} @ $${params.price.toFixed(3)}
💵 <b>Size:</b> $${params.sizeUsdc.toFixed(2)} USDC
⚡ <b>Signal:</b> ${params.netScore > 0 ? '+' : ''}${params.netScore.toFixed(1)} (${params.confidence})
🎯 <b>Edge:</b> ${(params.edge * 100).toFixed(1)}%
`.trim()
  await send(text)
}

export async function alertResolve(params: {
  marketQuestion: string
  won: boolean
  pnl: number
  totalPnl: number
  bankroll: number
}): Promise<void> {
  const emoji = params.won ? '✅' : '❌'
  const pnlStr = params.pnl >= 0 ? `+$${params.pnl.toFixed(2)}` : `-$${Math.abs(params.pnl).toFixed(2)}`
  const text = `
${emoji} <b>TRADE ${params.won ? 'WON' : 'LOST'}</b>
📋 ${params.marketQuestion}
💰 <b>P&L:</b> ${pnlStr}
📈 <b>Total P&L:</b> ${params.totalPnl >= 0 ? '+' : ''}$${params.totalPnl.toFixed(2)}
🏦 <b>Bankroll:</b> $${params.bankroll.toFixed(2)}
`.trim()
  await send(text)
}

export async function alertPause(reason: string): Promise<void> {
  await send(`⏸️ <b>BOT PAUSED</b>\n${reason}`)
}

export async function alertResume(): Promise<void> {
  await send(`▶️ <b>BOT RESUMED</b>\nReady to trade again.`)
}

export async function alertError(error: string): Promise<void> {
  await send(`🚨 <b>BOT ERROR</b>\n<code>${error}</code>`)
}

export async function alertHeartbeat(params: {
  bankroll: number
  totalPnl: number
  totalTrades: number
  wins: number
  status: string
}): Promise<void> {
  const winRate = params.totalTrades > 0
    ? ((params.wins / params.totalTrades) * 100).toFixed(0)
    : '—'
  const text = `
🤖 <b>BOT STATUS</b>
💼 Status: ${params.status}
🏦 Bankroll: $${params.bankroll.toFixed(2)}
📈 Total P&L: ${params.totalPnl >= 0 ? '+' : ''}$${params.totalPnl.toFixed(2)}
🎯 Win rate: ${winRate}% (${params.wins}/${params.totalTrades})
`.trim()
  await send(text)
}
