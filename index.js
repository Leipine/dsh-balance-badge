// Host half of the balance / billing-window plugin.
//
// One job: answer `GET /deepseek-balance/summary` with the account balance and
// the billing window that is in force right now. The browser half is a
// decoration and cannot hold the API key, so the key never leaves this process:
// it is resolved per request through the credentials service (the same seam
// `dsh-llm-deepseek-api-key` uses), then from the launching environment, then
// from the credentials file as a last resort.
//
// The billing window itself lives in ./lib/pricing.js and is loaded lazily: a
// missing or broken schedule module degrades to `scheduleKnown: false` instead
// of taking the whole route — and with it the balance read — down.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'deepseek-balance'

/** Route path. Mirrored verbatim in client.js; change both together. */
const DEFAULT_PATH = '/deepseek-balance/summary'
const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const BALANCE_TIMEOUT_MS = 15_000
/** The balance moves on the scale of hours; one upstream read a minute is plenty. */
const BALANCE_CACHE_MS = 60_000
/** Credential reference this account stores its platform key under. */
const API_KEY_REF = 'DEEPSEEK_API_KEY'

function homeDir() {
  const configured = process.env.DSH_HOME
  return configured !== undefined && configured.trim() !== '' ? configured : join(homedir(), '.dsh')
}

/**
 * Last-resort key lookup: the on-machine credentials file.
 *
 * `refs:` is a flat map of reference name to secret, so one anchored regex over
 * the whole document is enough and a full YAML parser is not worth the
 * dependency. Only ever called when the service and the environment both came
 * up empty.
 */
function apiKeyFromCredentialsFile() {
  const candidates = [join(homeDir(), '.credentials.yaml'), join(homeDir(), 'credentials.yaml')]
  for (const file of candidates) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const match = /^[ \t]*DEEPSEEK_API_KEY:[ \t]*["']?([^"'\s#]+)["']?[ \t]*$/m.exec(text)
    if (match !== null) return match[1]
  }
  return ''
}

/** Resolve the platform key for this request, or '' when nothing has one. */
async function resolveApiKey(ctx) {
  try {
    const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
    if (credentials !== undefined && typeof credentials.resolve === 'function') {
      // credentialRef() is a compile-time brand; the service accepts the name.
      const hit = await credentials.resolve(API_KEY_REF)
      const value = hit !== undefined && hit !== null && typeof hit.value === 'string' ? hit.value : ''
      if (value !== '') return value
    }
  } catch {
    // A credentials seam that throws is not a reason to stop looking.
  }
  const ambient = process.env[API_KEY_REF]
  if (typeof ambient === 'string' && ambient !== '') return ambient
  return apiKeyFromCredentialsFile()
}

/**
 * Shape the upstream payload for the browser: the raw `balance_infos` array
 * plus one primary entry. CNY wins when present because this account is billed
 * in CNY and a USD row of 0.00 would otherwise be the headline number.
 */
function normalizeBalance(body) {
  const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : []
  const entries = infos.map((info) => ({
    currency: String(info?.currency ?? ''),
    total: String(info?.total_balance ?? '0'),
    granted: String(info?.granted_balance ?? '0'),
    toppedUp: String(info?.topped_up_balance ?? '0'),
  }))
  const primary = entries.find((entry) => entry.currency === 'CNY') ?? entries[0] ?? null
  return { available: body?.is_available === true, entries, primary }
}

let pricingModule
let pricingModulePromise
/** Last failure from the schedule import, surfaced on the route for diagnosis. */
let pricingLoadError = null
/**
 * Build marker, visible on the route.
 *
 * Node caches an ESM module by URL for the whole process, so removing and
 * re-adding this bundle re-runs apply() without re-evaluating this file. The
 * marker is how a stale module instance is told apart from a genuine import
 * failure: if the route still reports an older marker, the code that is running
 * is not the code on disk.
 */
const IMPL = 'r2'

/**
 * Import the schedule module once, and only remember success.
 *
 * A cached failure would be worse than no cache: the plugin is installed by
 * dropping a directory into the profile, so the schedule file can legitimately
 * appear *after* the first request (or be fixed in place). Resetting the
 * promise on rejection lets the next poll recover on its own instead of
 * pinning `scheduleKnown: false` until the plugin is reloaded.
 */
function loadPricing() {
  if (pricingModule !== undefined) return Promise.resolve(pricingModule)
  if (pricingModulePromise === undefined) {
    pricingModulePromise = import('./lib/pricing.js').then(
      (module) => {
        pricingModule = module
        pricingLoadError = null
        return module
      },
      (cause) => {
        pricingModulePromise = undefined
        pricingLoadError = cause instanceof Error ? cause.message : String(cause)
        return null
      },
    )
  }
  return pricingModulePromise
}

function unknownWindow() {
  return {
    state: 'standard',
    discountPercent: 0,
    nextChangeAt: null,
    remainMs: null,
    scheduleKnown: false,
    note:
      `计费时段规则未加载 [${IMPL}]` +
      (pricingLoadError === null ? '' : `: ${pricingLoadError}`),
  }
}

/** Accept the schedule module's verdict, but never trust its types blindly. */
function normalizeWindow(value) {
  if (value === null || typeof value !== 'object') return unknownWindow()
  const finite = (candidate) => (Number.isFinite(candidate) ? candidate : null)
  return {
    state: value.state === 'offpeak' ? 'offpeak' : 'standard',
    discountPercent: Number.isFinite(value.discountPercent) ? value.discountPercent : 0,
    nextChangeAt: finite(value.nextChangeAt),
    remainMs: finite(value.remainMs),
    scheduleKnown: value.scheduleKnown !== false,
    note: typeof value.note === 'string' ? value.note : '',
  }
}

async function currentWindow(at) {
  const module = await loadPricing()
  const describe = module?.describeWindow
  if (typeof describe !== 'function') return unknownWindow()
  try {
    return normalizeWindow(describe(at))
  } catch {
    return unknownWindow()
  }
}

/**
 * The per-million-token price table for the configured model, or null when the
 * schedule module (which owns the table) is unavailable or the model is not in
 * it. The browser renders prices only when this is non-null, so an unknown
 * model degrades to the window name alone rather than to invented numbers.
 */
async function loadPriceTable(model) {
  const module = await loadPricing()
  const priceTableFor = module?.priceTableFor
  if (typeof priceTableFor !== 'function') return null
  try {
    return priceTableFor(model)
  } catch {
    return null
  }
}

/**
 * Whether this request comes from the machine itself. The route exposes a
 * private balance figure and nothing else, but there is no reason to serve it
 * to a LAN peer that happens to reach the port.
 */
function isLocalRequest(req) {
  const address = req.socket?.remoteAddress
  if (address === undefined || address === null) return true
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

export function apply(ctx, config = {}) {
  const path =
    typeof config.path === 'string' && config.path.startsWith('/') ? config.path : DEFAULT_PATH

  // One cached upstream read, shared by every poll from every open page. The
  // window half is recomputed per request because it is time-dependent.
  let balanceAt = 0
  let balanceValue = null

  const readBalance = async (at) => {
    if (balanceValue !== null && at - balanceAt < BALANCE_CACHE_MS) return balanceValue
    const key = await resolveApiKey(ctx)
    if (key === '') {
      throw new Error(`未找到 API Key（${API_KEY_REF}）：请在设置的模型页保存，或设置同名环境变量`)
    }
    const response = await fetch(BALANCE_URL, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error(`余额接口返回 HTTP ${response.status}`)
    }
    const parsed = normalizeBalance(await response.json())
    balanceValue = parsed
    balanceAt = at
    return parsed
  }

  const collect = async () => {
    const at = Date.now()
    const window = await currentWindow(at)
    const pricing = await loadPriceTable(config?.model)
    let balance = null
    let error = null
    try {
      balance = await readBalance(at)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    }
    return { ok: error === null, balance, window, pricing, fetchedAt: at, error }
  }

  const handle = async (req, res) => {
    if (!isLocalRequest(req)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'forbidden' }))
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    let payload
    try {
      payload = await collect()
    } catch (cause) {
      payload = {
        ok: false,
        balance: null,
        window: unknownWindow(),
        fetchedAt: Date.now(),
        error: cause instanceof Error ? cause.message : String(cause),
      }
    }
    const text = JSON.stringify(payload)
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(req.method === 'HEAD' ? undefined : text)
  }

  const registerRoute = (scope) => {
    scope.effect(
      () =>
        scope.webServer.register({
          kind: 'exact',
          path,
          handler: (req, res) => {
            // A handler rejection must not become an unhandled rejection on the
            // server: answer with the failure the browser can render.
            void handle(req, res).catch((cause) => {
              try {
                res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ error: cause instanceof Error ? cause.message : String(cause) }))
              } catch {
                // The socket is already gone; nothing left to say.
              }
            })
          },
        }),
      'deepseek-balance: summary route',
    )
  }

  // webServer exists only where a web surface is served. The plugin must not
  // wait on it, so the route rides a scoped inject and the plugin stays
  // loadable in a headless composition.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], registerRoute)
  }
}
