// ============================================================
// SUPABASE CLIENT (Deno)
// Thin REST wrapper — no npm, works in Deno Deploy
// ============================================================

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_KEY') ?? '' // service role key

async function query(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  table: string,
  body?: unknown,
  prefer?: string
): Promise<unknown> {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`)

  // Default Prefer header
  let preferHeader = prefer ?? (method === 'POST' ? 'return=representation' : 'return=minimal')

  const res = await fetch(url.toString(), {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: preferHeader
    },
    body: body ? JSON.stringify(body) : undefined
  })

  const text = await res.text()
  if (!res.ok) throw new Error(`Supabase ${method} ${table}: ${res.status} — ${text}`)
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
  // Use upsert (POST + resolution=merge-duplicates) so re-seen markets just update
  await query(
    'POST',
    'markets',
    { ...market, last_seen_at: new Date().toISOString() },
    'resolution=merge-duplicates,return=minimal'
  )
}

// ── Signal operations ────────────────────────────────────────

export async function insertSignal(signal: Record<string, unknown>): Promise<number> {
  const rows = await query('POST', 'signals', signal, 'return=representation') as Array<{ id: number }>
  return rows[0]?.id
}

// ── Trade operations ─────────────────────────────────────────

export async function insertTrade(trade: Record<string, unknown>): Promise<number> {
  const rows = await query('POST', 'trades', trade, 'return=representation') as Array<{ id: number }>
  return rows[0]?.id
}

export async function updateTrade(
  id: number,
  updates: Record<string, unknown>
): Promise<void> {
  const url = new URL(`${SUPABASE_URL}/rest/v1/trades`)
  url.searchParams.set('id', `eq.${id}`)
  const res = await fetch(url.toString(), {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    },
    body: JSON.stringify(updates)
  })
  if (!res.ok) throw new Error(`Supabase PATCH trades: ${res.status} — ${await res.text()}`)
}

// ── Bot state ────────────────────────────────────────────────

export async function getBotState(): Promise<Record<string, unknown>> {
  const url = new URL(`${SUPABASE_URL}/rest/v1/bot_state`)
  url.searchParams.set('id', 'eq.1')
  const res = await fetch(url.toString(), {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json'
    }
  })
  if (!res.ok) throw new Error(`Supabase GET bot_state: ${res.status}`)
  const rows = await res.json() as Array<Record<string, unknown>>
  return rows[0] ?? {}
}

export async function updateBotState(updates: Record<string, unknown>): Promise<void> {
  const url = new URL(`${SUPABASE_URL}/rest/v1/bot_state`)
  url.searchParams.set('id', 'eq.1')
  const res = await fetch(url.toString(), {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    },
    body: JSON.stringify({
      ...updates,
      updated_at: new Date().toISOString(),
      last_heartbeat: new Date().toISOString()
    })
  })
  if (!res.ok) throw new Error(`Supabase PATCH bot_state: ${res.status} — ${await res.text()}`)
}

// ── Alerts ───────────────────────────────────────────────────

export async function insertAlert(
  level: 'info' | 'warning' | 'critical',
  source: string,
  message: string
): Promise<void> {
  await query('POST', 'alerts', { level, source, message }, 'return=minimal')
}

// ── Agent status ─────────────────────────────────────────────

export async function setAgentStatus(
  agentName: string,
  status: string,
  currentTask: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  // UPSERT — the schema seeds these rows already, so plain POST 409s every time.
  // resolution=merge-duplicates tells PostgREST to UPDATE on conflict.
  await query(
    'POST',
    'agent_status',
    {
      agent_name: agentName,
      status,
      current_task: currentTask,
      last_active: new Date().toISOString(),
      metadata: metadata ?? {}
    },
    'resolution=merge-duplicates,return=minimal'
  )
}
