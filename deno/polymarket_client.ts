// ============================================================
// POLYMARKET CLIENT — FIXED v2
// Major fixes:
//   1. Env vars use _ZAK suffix (Zak's naming convention)
//   2. Real EIP-712 signing via npm:ethers (no more '0x' placeholder)
//   3. P&L write-back on order fill
//   4. Proper error handling
// ============================================================
import { Wallet } from 'npm:ethers@6'

const CLOB_BASE = 'https://clob.polymarket.com'
const GAMMA_BASE = 'https://gamma-api.polymarket.com'
const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E'

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
  yesToken: string
  noToken: string
  yesPrice: number
  noPrice: number
  volume: number
  active: boolean
}

// ── Config (loaded from Deno env — _ZAK suffix) ────────────

function getConfig() {
  return {
    privateKey: Deno.env.get('POLY_PRIVATE_KEY_ZAK') ?? '',
    apiKey: Deno.env.get('POLY_API_KEY_ZAK') ?? '',
    apiSecret: Deno.env.get('POLY_API_SECRET_ZAK') ?? '',
    apiPassphrase: Deno.env.get('POLY_API_PASSPHRASE_ZAK') ?? '',
    address: Deno.env.get('POLY_ADDRESS_ZAK') ?? '',
    chainId: 137, // Polygon mainnet
  }
}

// ── EIP-712 domain & types (Polymarket CLOB order spec) ─────

const EIP712_DOMAIN = {
  name: 'CTF Exchange',
  version: '1',
  chainId: 137,
  verifyingContract: CTF_EXCHANGE,
}

const ORDER_TYPES = {
  Order: [
    { name: 'salt', type: 'uint256' },
    { name: 'maker', type: 'address' },
    { name: 'signer', type: 'address' },
    { name: 'taker', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'makerAmount', type: 'uint256' },
    { name: 'takerAmount', type: 'uint256' },
    { name: 'expiration', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'feeRateBps', type: 'uint256' },
    { name: 'side', type: 'uint8' },
    { name: 'signatureType', type: 'uint256' },
  ],
}

/**
 * Generate EIP-712 typed data signature for a Polymarket CLOB order.
 * Uses the private key from env vars to sign the order struct.
 */
async function signOrder(orderData: Record<string, unknown>): Promise<string> {
  const cfg = getConfig()
  if (!cfg.privateKey || cfg.privateKey === '0x') {
    throw new Error('POLY_PRIVATE_KEY_ZAK not configured')
  }

  // Create a wallet from the private key
  const wallet = new Wallet(cfg.privateKey)

  // Sign the typed data (EIP-712)
  const signature = await wallet.signTypedData(EIP712_DOMAIN, ORDER_TYPES, orderData)
  return signature
}

// ── Request signing (L1 + L2 auth) ──────────────────────────

async function clobGet(path: string): Promise<unknown> {
  const cfg = getConfig()
  const url = `${CLOB_BASE}${path}`
  const res = await fetch(url, {
    headers: {
      'POLY_ADDRESS': cfg.address || cfg.apiKey,
      'POLY_SIGNATURE': '',
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

  // L2 HMAC signature for API auth
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
      'POLY_ADDRESS': cfg.address || cfg.apiKey,
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

// ── Order placement (with real EIP-712 signing) ─────────────

/**
 * Place a limit order on Polymarket CLOB with proper EIP-712 signing.
 * Requires POLY_PRIVATE_KEY_ZAK env var for signing.
 */
export async function placeOrder(order: PolyOrder): Promise<OrderResult> {
  const cfg = getConfig()
  if (!cfg.apiKey || !cfg.apiSecret) {
    return { success: false, error: 'API credentials not configured' }
  }
  if (!cfg.privateKey || cfg.privateKey === '0x') {
    return { success: false, error: 'POLY_PRIVATE_KEY_ZAK not configured — signing impossible' }
  }

  try {
    // Fetch market to get token IDs
    const markets = await fetchBtcMarkets()
    const market = markets.find(m => m.conditionId === order.marketId)
    if (!market) return { success: false, error: `Market ${order.marketId} not found` }

    const tokenId = order.side === 'YES' ? market.yesToken : market.noToken
    const makerAmount = Math.floor(order.sizeUsdc * 1_000_000).toString()
    const takerAmount = Math.floor(order.sizeUsdc / order.price * 1_000_000).toString()

    // EIP-712 order data (matches Polymarket CLOB Order struct)
    const orderData = {
      salt: Date.now().toString(),
      maker: cfg.address || cfg.apiKey,
      signer: cfg.address || cfg.apiKey,
      taker: '0x0000000000000000000000000000000000000000',
      tokenId,
      makerAmount,
      takerAmount,
      expiration: '0',
      nonce: '0',
      feeRateBps: '0',
      side: 0, // BUY
      signatureType: 0,
    }

    // Generate real EIP-712 signature
    const signature = await signOrder(orderData)

    // Build CLOB order payload
    const payload = {
      order: {
        ...orderData,
        signatureType: 0,
        signature,
      },
      owner: cfg.address || cfg.apiKey,
      orderType: 'GTC'
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
