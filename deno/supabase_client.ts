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
  params?: Record<string, string>,
  prefer?: string
): Promise<unknown> {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`)
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))

  const preferHeader = prefer ?? (method === 'POST' ? 'return=representation' : 'return=minimal')
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
  await query('POST', 'markets', { ...market, last_seen_at: new Date().toISOString() }, undefined, 'resolution=merge-duplicates,return=minimal')
}

// ── Signal operations ────────────────────────────────────────

export async function insertSignal(signal: Record<string, unknown>): Promise<number> {
  const rows = await query('POST', 'signals', signal) as Array<{ id: number }>
  return rows[0]?.id
}

// ── Trade operations ─────────────────────────────────────────

export async function insertTrade(trade: Record<string, unknown>): Promise<number> {
  const rows = await query('POST', 'trades', trade) as Array<{ id: number }>
  return rows[0]?.id
}

export async function updateTrade(
  id: number,
  updates: Record<string, unknown>
): Promise<void> {
  await query('PATCH', `trades?id=eq.${id}`, updates)
}

// ── Bot state ────────────────────────────────────────────────

export async function getBotState(): Promise<Record<string, unknown>> {
  const rows = await query('GET', 'bot_state?id=eq.1') as Array<Record<string, unknown>>
  return rows[0] ?? {}
}

export async function updateBotState(updates: Record<string, unknown>): Promise<void> {
  await query('PATCH', 'bot_state?id=eq.1', {
    ...updates,
    updated_at: new Date().toISOString(),
    last_heartbeat: new Date().toISOString()
  })
}

// ── Alerts ───────────────────────────────────────────────────

export async function insertAlert(
  level: 'info' | 'warning' | 'critical',
  source: string,
  message: string
): Promise<void> {
  await query('POST', 'alerts', { level, source, message })
}

// ── Agent status ─────────────────────────────────────────────

export async function setAgentStatus(
  agentName: string,
  status: string,
  currentTask: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  await query('POST', 'agent_status', {
    agent_name: agentName,
    status,
    current_task: currentTask,
    last_active: new Date().toISOString(),
    metadata: metadata ?? {}
  }, undefined, 'resolution=merge-duplicates,return=minimal')
}
