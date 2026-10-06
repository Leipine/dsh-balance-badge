// Host half of the balance / billing-window plugin.
//
// One job: answer `GET /deepseek-balance/summary` with the account balance and
// the billing window that is in force right now. The browser half is a
// decoration and cannot hold the API key, so the key never leaves this process:
// it is resolved per request through the credentials service (the same seam
// `dsh-llm-deepseek-api-key` uses), then from the launching environment, then
// from the credentials file as a last resort.
//
// When the platform key cannot answer, the signed-in DeepSeek account is asked
// next, because it is the seam a user who never stored a key actually has: the
// account grant is a credential *record* the account service owns, not a `refs`
// entry, so the key lookup below is blind to it and would report "no credential"
// on a machine that is signed in and perfectly able to show a balance. The key
// keeps precedence, so a deployment that already works is untouched.
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
/**
 * Version reported to Platform on account reads.
 *
 * Platform serves the account endpoints through the same edge as DSH's own
 * account pages, so the caller has to look like that client; the Host has no
 * browser build of its own to ask. The value only labels the caller, so it
 * tracks the desktop build this ships with and can be overridden from the
 * bundle row with `config.accountClientVersion`.
 */
const ACCOUNT_CLIENT_VERSION = '0.2.0-rc.2'

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

/** One failure message, whatever was thrown. */
function reasonOf(cause) {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * Client identity reported to Platform for one account read.
 *
 * The page that asked is the authority: it knows the language and the zone the
 * user is actually in, which this process cannot. What it cannot know is a build
 * version its own bundle never carried, and a headless caller (a `curl` against
 * the route) reports nothing at all — both fall back to the deployment's
 * defaults, which the bundle row can override.
 */
function accountClient(config, reported) {
  const pick = (value, fallback) =>
    typeof value === 'string' && value.trim() !== '' ? value : fallback
  const offset = Number.isFinite(reported?.timezoneOffsetSeconds)
    ? reported.timezoneOffsetSeconds
    : -new Date().getTimezoneOffset() * 60
  return {
    version: pick(reported?.version, pick(config?.accountClientVersion, ACCOUNT_CLIENT_VERSION)),
    locale: pick(reported?.locale, pick(config?.locale, 'zh-CN')),
    timezoneOffsetSeconds: offset,
  }
}

/**
 * The identity the browser half sends with every poll, or null when this caller
 * sent none (a `curl`, a headless composition).
 *
 * Node lowercases header names, and a missing or malformed field stays null so
 * the default stands rather than a broken value reaching Platform.
 */
function reportedIdentity(req) {
  const headers = req?.headers
  if (headers === undefined || headers === null) return null
  const read = (name) => {
    const value = headers[name]
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : ''
  }
  const offset = Number(read('x-dsh-client-timezone-offset'))
  const identity = {
    version: read('x-dsh-client-version'),
    locale: read('x-dsh-client-locale'),
    timezoneOffsetSeconds: Number.isFinite(offset) ? offset : null,
  }
  // A caller that sent nothing gets defaults, and the route says so: on this
  // deployment the page's values and the process defaults can coincide, so the
  // numbers alone would not tell the two apart.
  const sent = identity.version !== '' || identity.locale !== '' || identity.timezoneOffsetSeconds !== null
  return sent ? identity : null
}

/**
 * Shape the account service's wallet lists for the browser.
 *
 * The account route reports two lists per currency — recharge wallets and
 * granted bonuses — while the badge shows one total with its two parts, so the
 * lists are merged by currency. A currency that appears in neither list is not
 * invented: with no wallet at all there is no balance to show.
 */
function normalizeAccountBalance(detail) {
  const byCurrency = new Map()
  const merge = (list, field) => {
    if (!Array.isArray(list)) return
    for (const wallet of list) {
      const currency = String(wallet?.currency ?? '')
      const amount = Number(wallet?.balance)
      if (currency === '' || !Number.isFinite(amount)) continue
      const entry = byCurrency.get(currency) ?? { currency, toppedUp: 0, granted: 0 }
      entry[field] += amount
      byCurrency.set(currency, entry)
    }
  }
  // `value` is the recharge list; granted credit arrives beside it.
  merge(detail.value, 'toppedUp')
  merge(detail.bonusWallets, 'granted')
  const fixed = (value) => value.toFixed(2)
  const entries = [...byCurrency.values()].map((entry) => ({
    currency: entry.currency,
    total: fixed(entry.toppedUp + entry.granted),
    granted: fixed(entry.granted),
    toppedUp: fixed(entry.toppedUp),
  }))
  const primary = entries.find((entry) => entry.currency === 'CNY') ?? entries[0] ?? null
  return primary === null ? null : { available: true, entries, primary, source: 'account' }
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
  return { available: body?.is_available === true, entries, primary, source: 'api-key' }
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
const IMPL = 'r4+acct+id'

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
  /** Which seam answered last, and why not when none did; reported on the route. */
  let accountNote = 'not-asked'
  /** The identity the last account read actually reported; reported on the route. */
  let usedClient = null
  /** Whether that identity came from the asking page or from this process. */
  let usedClientSource = null

  /**
   * Balance of the signed-in DeepSeek account, through the same service DSH's
   * own account pages read.
   *
   * Every failure is a note rather than a throw: an account seam that is
   * missing, signed out, or refused must not stop the platform key below from
   * answering, and the route has to be able to say which of the two it was.
   *
   * @returns `{ balance, note }` with balance null when the account route has
   * nothing to contribute.
   */
  const readBalanceFromAccount = async (reported) => {
    let account
    try {
      account = typeof ctx.get === 'function' ? ctx.get('deepseekAccount') : undefined
    } catch (cause) {
      return { balance: null, note: `error: ${reasonOf(cause)}` }
    }
    if (account === undefined || account === null || typeof account.getBalance !== 'function') {
      return { balance: null, note: 'absent' }
    }
    const client = accountClient(config, reported)
    usedClient = client
    usedClientSource = reported === null ? 'defaults' : 'page'
    let detail
    try {
      detail = await account.getBalance(client)
    } catch (cause) {
      // A grant Platform rejected, or an edge failure: either way the answer is
      // "no balance from this seam", never a failed route.
      return { balance: null, note: `error: ${reasonOf(cause)}` }
    }
    if (detail === undefined || detail === null) return { balance: null, note: 'signed-out' }
    if (detail.status !== 'ready') return { balance: null, note: `failed (${String(detail.status)})` }
    const balance = normalizeAccountBalance(detail)
    return balance === null ? { balance: null, note: 'no-wallet' } : { balance, note: 'ready' }
  }

  /** Balance of the platform account, through the stored API key. */
  const readBalanceFromApiKey = async () => {
    const key = await resolveApiKey(ctx)
    if (key === '') {
      throw new Error(
        `未找到 DeepSeek 凭据（账号未登录，且无 ${API_KEY_REF}）：请登录 DeepSeek 账号，或在设置的模型页保存该 Key`,
      )
    }
    const response = await fetch(BALANCE_URL, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error(`余额接口返回 HTTP ${response.status}`)
    }
    return normalizeBalance(await response.json())
  }

  const readBalance = async (at, reported) => {
    if (balanceValue !== null && at - balanceAt < BALANCE_CACHE_MS) return balanceValue
    // The stored platform key keeps precedence: it is the seam this plugin has
    // always used, so a deployment that already works is not touched. The
    // account answers only when the key could not.
    let parsed = null
    let keyError = null
    try {
      parsed = await readBalanceFromApiKey()
    } catch (cause) {
      keyError = reasonOf(cause)
    }
    if (parsed === null) {
      const account = await readBalanceFromAccount(reported)
      accountNote = account.note
      parsed = account.balance
      if (parsed === null) {
        throw new Error(`${keyError}；账号余额也不可用（${account.note}）`)
      }
    } else {
      accountNote = 'not-needed'
    }
    balanceValue = parsed
    balanceAt = at
    return parsed
  }

  const collect = async (reported) => {
    const at = Date.now()
    const window = await currentWindow(at)
    const pricing = await loadPriceTable(config?.model)
    let balance = null
    let error = null
    try {
      balance = await readBalance(at, reported)
    } catch (cause) {
      error = reasonOf(cause)
    }
    return {
      ok: error === null,
      impl: IMPL,
      account: accountNote,
      client: usedClient,
      clientSource: usedClientSource,
      balance,
      window,
      pricing,
      fetchedAt: at,
      error,
    }
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
      payload = await collect(reportedIdentity(req))
    } catch (cause) {
      payload = {
        ok: false,
        impl: IMPL,
        account: accountNote,
        client: usedClient,
        clientSource: usedClientSource,
        balance: null,
        window: unknownWindow(),
        fetchedAt: Date.now(),
        error: reasonOf(cause),
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
                res.end(JSON.stringify({ error: reasonOf(cause) }))
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
