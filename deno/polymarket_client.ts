// ============================================================
// POLYMARKET CLIENT
// Handles: wallet setup, API key generation, market data,
// order placement, order status
// ============================================================
// Uses Polymarket CLOB REST API — no npm needed in Deno

const CLOB_BASE = 'https://clob.polymarket.com'
const GAMMA_BASE = 'https://gamma-api.polymarket.com'

// ── Types ────────────────────────────────────────────────────

export interface PolyOrder {
  marketId: string         // condition_id
  side: 'YES' | 'NO'
  price: number            // limit price (0–1)
  sizeUsdc: number         // dollar amount
}

export interface OrderResult {
  success: boolean
  orderId?: string
  error?: string
  rawResponse?: unknown
}

export interface MarketInfo {
  conditionId: string
  question: string
  endDateIso: string
  yesToken: string         // ERC1155 token ID for YES
  noToken: string
  yesPrice: number
  noPrice: number
  volume: number
  active: boolean
}

// ── Config (loaded from Deno env) ───────────────────────────

function getConfig() {
  return {
    privateKey: Deno.env.get('POLY_PRIVATE_KEY') ?? '',
    apiKey: Deno.env.get('POLY_API_KEY') ?? '',
    apiSecret: Deno.env.get('POLY_API_SECRET') ?? '',
    apiPassphrase: Deno.env.get('POLY_API_PASSPHRASE') ?? '',
    chainId: 137, // Polygon mainnet
  }
}

// ── Request signing (L1 auth for order placement) ───────────
// Polymarket uses EIP-712 signing. For now we use the API key
// (L2 auth) which is simpler and sufficient for CLOB orders.

async function clobGet(path: string): Promise<unknown> {
  const cfg = getConfig()
  const url = `${CLOB_BASE}${path}`
  const res = await fetch(url, {
    headers: {
      'POLY_ADDRESS': cfg.apiKey,     // wallet address used as key
      'POLY_SIGNATURE': '',           // L1 not needed for reads
      'POLY_TIMESTAMP': Date.now().toString(),
      'POLY_NONCE': '0',
      'Content-Type': 'application/json',
    }
  })
  if (!res.ok) throw new Error(`CLOB GET ${path} → ${res.status}: ${await res.text()}`)
  return res.json()
}

async function clobPost(path: string, body: unknown): Promise<unknown> {
  const cfg = getConfig()
  const url = `${CLOB_BASE}${path}`
  const timestamp = Math.floor(Date.now() / 1000).toString()

  // Build the L2 HMAC signature required for order placement
  const message = timestamp + 'POST' + path + JSON.stringify(body)
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(cfg.apiSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'POLY_ADDRESS': cfg.apiKey,
      'POLY_SIGNATURE': sigB64,
      'POLY_TIMESTAMP': timestamp,
      'POLY_NONCE': '0',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error(`CLOB POST ${path} → ${res.status}: ${await res.text()}`)
  return res.json()
}

// ── Market data ──────────────────────────────────────────────

/** Fetch live BTC 5-min up/down markets from Gamma API */
export async function fetchBtcMarkets(): Promise<MarketInfo[]> {
  const url = `${GAMMA_BASE}/markets?tag=BTC&active=true&closed=false&limit=50`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Gamma API: ${res.status}`)
  const data = await res.json() as Array<{
    conditionId: string
    question: string
    endDateIso: string
    outcomePrices: string[]
    clobTokenIds: string[]
    volumeNum: number
    active: boolean
    closed: boolean
  }>

  // Filter for 5-min BTC up/down markets
  return data
    .filter(m =>
      !m.closed &&
      m.active &&
      (m.question.toLowerCase().includes('btc') ||
        m.question.toLowerCase().includes('bitcoin')) &&
      m.outcomePrices?.length >= 2 &&
      m.clobTokenIds?.length >= 2
    )
    .map(m => ({
      conditionId: m.conditionId,
      question: m.question,
      endDateIso: m.endDateIso,
      yesToken: m.clobTokenIds[0],
      noToken: m.clobTokenIds[1],
      yesPrice: parseFloat(m.outcomePrices[0] ?? '0.5'),
      noPrice: parseFloat(m.outcomePrices[1] ?? '0.5'),
      volume: m.volumeNum ?? 0,
      active: m.active
    }))
}

/** Get live order book for a market token */
export async function fetchOrderBook(tokenId: string): Promise<{
  bids: Array<{ price: string; size: string }>
  asks: Array<{ price: string; size: string }>
}> {
  const data = await clobGet(`/book?token_id=${tokenId}`) as {
    bids: Array<{ price: string; size: string }>
    asks: Array<{ price: string; size: string }>
  }
  return data
}

/** Get open orders for our account */
export async function fetchOpenOrders(): Promise<unknown[]> {
  const data = await clobGet('/orders?status=OPEN') as { orders: unknown[] }
  return data.orders ?? []
}

/** Get order status by ID */
export async function fetchOrderStatus(orderId: string): Promise<{
  status: string
  filledSize?: number
  filledPrice?: number
}> {
  const data = await clobGet(`/order/${orderId}`) as {
    status: string
    size_matched?: number
    avg_price?: number
  }
  return {
    status: data.status,
    filledSize: data.size_matched,
    filledPrice: data.avg_price
  }
}

// ── Order placement ──────────────────────────────────────────

/**
 * Place a limit order on Polymarket CLOB.
 *
 * IMPORTANT: Polymarket orders are placed in USDC on Polygon.
 * You must have USDC approved for the CTF Exchange contract.
 * The side maps: YES = buy YES token, NO = buy NO token.
 */
export async function placeOrder(order: PolyOrder): Promise<OrderResult> {
  const cfg = getConfig()
  if (!cfg.apiKey || !cfg.apiSecret) {
    return { success: false, error: 'API credentials not configured' }
  }

  try {
    // Fetch market to get token IDs
    const markets = await fetchBtcMarkets()
    const market = markets.find(m => m.conditionId === order.marketId)
    if (!market) return { success: false, error: `Market ${order.marketId} not found` }

    const tokenId = order.side === 'YES' ? market.yesToken : market.noToken

    // Build CLOB order payload
    const payload = {
      order: {
        salt: Date.now(),
        maker: cfg.apiKey,
        signer: cfg.apiKey,
        taker: '0x0000000000000000000000000000000000000000',
        tokenId,
        makerAmount: Math.floor(order.sizeUsdc * 1_000_000).toString(), // USDC has 6 decimals
        takerAmount: Math.floor(order.sizeUsdc / order.price * 1_000_000).toString(),
        expiration: '0',
        nonce: '0',
        feeRateBps: '0',
        side: 'BUY',
        signatureType: 0,
        signature: '0x' // Will be populated properly after wallet integration
      },
      owner: cfg.apiKey,
      orderType: 'GTC'  // Good Till Cancelled
    }

    const result = await clobPost('/order', payload) as { orderID?: string; errorMsg?: string }

    if (result.orderID) {
      return { success: true, orderId: result.orderID, rawResponse: result }
    } else {
      return { success: false, error: result.errorMsg ?? 'Unknown error', rawResponse: result }
    }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

/** Cancel an open order */
export async function cancelOrder(orderId: string): Promise<boolean> {
  try {
    await clobPost('/cancel', { orderID: orderId })
    return true
  } catch {
    return false
  }
}
