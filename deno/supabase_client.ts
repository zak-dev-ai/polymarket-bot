// ============================================================
// SUPABASE CLIENT (Deno) — FIXED v2
// Fixes:
//   1. Added getPendingTrades() — was missing, broke all resolution
//   2. updateTrade() now uses correct URL filter pattern
//   3. upsertMarket() uses upsert (no more 409)
//   4. setAgentStatus() uses upsert (no more 409)
//   5. updateBotState() uses direct URL filter (not query fn)
//   6. getBotState() uses direct URL filter (not query fn)
// ============================================================

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_KEY') ?? ''

// ── Core fetch helper ────────────────────────────────────────

async function rest(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,          // e.g. 'trades?id=eq.5' or 'agent_status'
  body?: unknown,
  preferHeader?: string
): Promise<unknown> {
  const url = `${SUPABASE_URL}/rest/v1/${path}`
  const prefer = preferHeader ?? (method === 'POST' ? 'return=representation' : 'return=minimal')

  const res = await fetch(url, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: prefer,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  const text = await res.text()
  if (!res.ok) throw new Error(`Supabase ${method} ${path}: ${res.status} — ${text}`)
  return text ? JSON.parse(text) : null
}

// ── Market operations ────────────────────────────────────────

export async function upsertMarket(market: {
  id: string
  question: string
  end_date_iso?: string
  yes_price?: number
  no_price?: number
  volume?: number
  active?: boolean
}): Promise<void> {
  // resolution=merge-duplicates = INSERT ... ON CONFLICT DO UPDATE
  await rest(
    'POST',
    'markets',
    { ...market, last_seen_at: new Date().toISOString() },
    'resolution=merge-duplicates,return=minimal'
  )
}

// ── Signal operations ────────────────────────────────────────

export async function insertSignal(signal: Record<string, unknown>): Promise<number> {
  const rows = await rest('POST', 'signals', signal) as Array<{ id: number }>
  return rows[0]?.id
}

// ── Trade operations ─────────────────────────────────────────

export async function insertTrade(trade: Record<string, unknown>): Promise<number> {
  const rows = await rest('POST', 'trades', trade) as Array<{ id: number }>
  return rows[0]?.id
}

/**
 * FIX: old version passed id as path suffix incorrectly.
 * Now uses correct PostgREST filter: trades?id=eq.<id>
 */
export async function updateTrade(
  id: number,
  updates: Record<string, unknown>
): Promise<void> {
  await rest('PATCH', `trades?id=eq.${id}`, updates)
}

/**
 * NEW — was missing entirely. Called by resolvePaperTrades().
 * Returns trades with status = 'paper' OR 'pending' that have no pnl yet.
 * We check both because different strategies use different default status values.
 */
export async function getPendingTrades(): Promise<Array<Record<string, unknown>>> {
  // PostgREST OR filter: status=paper OR status=pending, pnl is null
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/trades?or=(status.eq.paper,status.eq.pending)&pnl=is.null&order=ts.asc&limit=100`,
    {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  )
  const text = await res.text()
  if (!res.ok) throw new Error(`getPendingTrades: ${res.status} — ${text}`)
  return text ? JSON.parse(text) : []
}

// ── Bot state ────────────────────────────────────────────────

export async function getBotState(): Promise<Record<string, unknown>> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/bot_state?id=eq.1`,
    {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
    }
  )
  if (!res.ok) throw new Error(`getBotState: ${res.status}`)
  const rows = await res.json() as Array<Record<string, unknown>>
  return rows[0] ?? {}
}

export async function updateBotState(updates: Record<string, unknown>): Promise<void> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/bot_state?id=eq.1`,
    {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        ...updates,
        updated_at: new Date().toISOString(),
        last_heartbeat: new Date().toISOString(),
      }),
    }
  )
  if (!res.ok) throw new Error(`updateBotState: ${res.status} — ${await res.text()}`)
}

// ── Alerts ───────────────────────────────────────────────────

export async function insertAlert(
  level: 'info' | 'warning' | 'critical',
  source: string,
  message: string
): Promise<void> {
  await rest('POST', 'alerts', { level, source, message }, 'return=minimal')
}

// ── Agent status ─────────────────────────────────────────────

export async function setAgentStatus(
  agentName: string,
  status: string,
  currentTask: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  // UPSERT — schema seeds these rows, so plain POST would 409
  await rest(
    'POST',
    'agent_status',
    {
      agent_name: agentName,
      status,
      current_task: currentTask,
      last_active: new Date().toISOString(),
      metadata: metadata ?? {},
    },
    'resolution=merge-duplicates,return=minimal'
  )
}
