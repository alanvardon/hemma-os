// riksbank-proxy — proxies the Riksbank SWEA API for Bolånekoll's policy-rate
// watcher (plan 70). The upstream API isn't browser-callable: when an Origin
// header is present it returns 200 with an EMPTY body and no
// Access-Control-Allow-Origin, so this must run server-side without one.
//
// Also collapses the per-banking-day series into change points so the
// since-2010 payload shrinks from ~4 000 rows to a few dozen. Mirrors
// `collapseChanges` in web/src/lib/riksbank.ts — keep the two in sync by hand,
// this runtime (Deno) can't import from web/src.

const SERIES = 'SECBREPOEFF'
const START = '2010-01-01'
const BASE = 'https://api.riksbank.se/swea/v1'

interface RatePoint { date: string; value: number }

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Module-level cache: the rate changes at most ~8×/year at 09:30 on decision
// days, so an hour of staleness is fine and saves hammering the Riksbank.
let cache: { at: number; body: string } | null = null
const CACHE_MS = 60 * 60 * 1000

function collapseChanges(observations: RatePoint[]): RatePoint[] {
  const out: RatePoint[] = []
  for (const obs of observations || []) {
    const prev = out[out.length - 1]
    if (!prev || prev.value !== obs.value) out.push(obs)
  }
  return out
}

function jsonResponse(body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, { headers: { ...corsHeaders, 'Content-Type': 'application/json', ...extra } })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  if (cache && Date.now() - cache.at < CACHE_MS) {
    return jsonResponse(cache.body, { 'Cache-Control': 'max-age=3600' })
  }

  const today = new Date().toISOString().slice(0, 10)

  try {
    const [latestRes, seriesRes] = await Promise.all([
      fetch(`${BASE}/Observations/Latest/${SERIES}`),
      fetch(`${BASE}/Observations/${SERIES}/${START}/${today}`),
    ])
    if (!latestRes.ok || !seriesRes.ok) {
      return jsonResponse(JSON.stringify({ error: 'riksbank upstream error' }))
    }

    const latest: RatePoint = await latestRes.json()
    const series: RatePoint[] = await seriesRes.json()
    const changes = collapseChanges(series)

    const body = JSON.stringify({ latest, changes })
    cache = { at: Date.now(), body }
    return jsonResponse(body, { 'Cache-Control': 'max-age=3600' })
  } catch (err) {
    return jsonResponse(JSON.stringify({ error: String(err) }))
  }
})
