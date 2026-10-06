// Which credential seam answers the balance, and what the route says when none
// can. Every test drives the real route handler with a fake Context and a fake
// `fetch`, so the suite runs offline and never reads this machine's real
// credential store.
import { test } from 'node:test'
import assert from 'node:assert/strict'

// Pin the credential sources first: no ambient key, and a DSH_HOME with no
// credentials file. Both are read lazily by the Host half, so setting them here
// — before the module is imported — keeps every case below deterministic.
process.env.DSH_HOME = '/nonexistent-dsh-home-for-tests'
delete process.env.DEEPSEEK_API_KEY

const { apply } = await import('../index.js')

const KEY_BALANCE = {
  is_available: true,
  balance_infos: [
    { currency: 'CNY', total_balance: '21.15', granted_balance: '1.00', topped_up_balance: '20.15' },
  ],
}

/** Upstream behaviour for the next key-shaped read. */
let upstream = 'ok'
let upstreamCalls = []

globalThis.fetch = async (url) => {
  upstreamCalls.push(String(url))
  if (upstream === 'unreachable') throw new Error('network down')
  if (upstream === 'unauthorized') return { ok: false, status: 401, json: async () => ({}) }
  return { ok: true, status: 200, json: async () => KEY_BALANCE }
}

/** Account reads the Host performed, with the identity it reported for each. */
let accountCalls = []

const accountOf = (reply) => ({
  async getBalance(client) {
    accountCalls.push(client)
    return typeof reply === 'function' ? reply() : reply
  },
})

const ACCOUNT_READY = () => ({
  status: 'ready',
  value: [{ currency: 'CNY', balance: '20.15' }],
  bonusWallets: [{ currency: 'CNY', balance: '1.00' }],
})

const credentialsWith = (value) => ({ async resolve() { return { value } } })

function fakeContext({ account, credentials } = {}) {
  return {
    get(name) {
      if (name === 'deepseekAccount') return account
      if (name === 'credentials') return credentials
      return undefined
    },
    inject(names, run) {
      run({ effect: (fn) => fn(), webServer: { register: (route) => { registered = route } } })
    },
  }
}

let registered = null

/** Register the route with a fake Context and answer one loopback GET. */
async function ask({ account, credentials, config, headers, upstream: mode = 'ok' } = {}) {
  registered = null
  accountCalls = []
  upstreamCalls = []
  upstream = mode
  apply(fakeContext({ account, credentials }), config)
  assert.notEqual(registered, null, 'the route was never registered')
  return new Promise((resolve, reject) => {
    const res = {
      writeHead() {},
      end(body) {
        try {
          resolve(JSON.parse(body))
        } catch (cause) {
          reject(cause)
        }
      },
    }
    const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers }
    Promise.resolve(registered.handler(req, res)).catch(reject)
  })
}

test('a stored platform key answers and the account seam is never touched', async () => {
  const payload = await ask({ account: accountOf(ACCOUNT_READY), credentials: credentialsWith('sk-good') })
  assert.equal(payload.ok, true)
  assert.equal(payload.balance.source, 'api-key')
  assert.equal(payload.account, 'not-needed')
  assert.equal(accountCalls.length, 0)
  assert.equal(upstreamCalls.length, 1)
})

test('a signed-in account answers when no key is stored anywhere', async () => {
  const payload = await ask({ account: accountOf(ACCOUNT_READY) })
  assert.equal(payload.ok, true)
  assert.equal(payload.balance.source, 'account')
  assert.equal(payload.account, 'ready')
  assert.equal(upstreamCalls.length, 0, 'no key-shaped call is made when nothing has a key')
  assert.deepEqual(payload.balance.primary, {
    currency: 'CNY',
    total: '21.15',
    granted: '1.00',
    toppedUp: '20.15',
  })
})

test('a key Platform rejects falls through to the account', async () => {
  // The regression this change exists for: a revoked key used to pin the chip to
  // "Balance unavailable" even though the account could answer.
  const payload = await ask({
    account: accountOf(ACCOUNT_READY),
    credentials: credentialsWith('sk-revoked'),
    upstream: 'unauthorized',
  })
  assert.equal(payload.ok, true)
  assert.equal(payload.error, null)
  assert.equal(payload.balance.source, 'account')
})

test('an unreachable key host falls through to the account', async () => {
  const payload = await ask({
    account: accountOf(ACCOUNT_READY),
    credentials: credentialsWith('sk-good'),
    upstream: 'unreachable',
  })
  assert.equal(payload.ok, true)
  assert.equal(payload.balance.source, 'account')
})

test('neither seam answering names both in the error', async () => {
  const payload = await ask({})
  assert.equal(payload.ok, false)
  assert.equal(payload.balance, null)
  assert.equal(payload.account, 'absent')
  assert.match(payload.error, /账号未登录/)
  assert.match(payload.error, /DEEPSEEK_API_KEY/)
})

test('account problems are reported, never thrown, and never invent a balance', async () => {
  const signedOut = await ask({ account: accountOf(null) })
  assert.equal(signedOut.account, 'signed-out')
  assert.match(signedOut.error, /signed-out/)

  const threw = await ask({ account: accountOf(() => { throw new Error('edge exploded') }) })
  assert.equal(threw.ok, false)
  assert.equal(threw.account, 'error: edge exploded')

  const failed = await ask({ account: accountOf({ status: 'failed' }) })
  assert.equal(failed.balance, null)
  assert.equal(failed.account, 'failed (failed)')
})

test('wallets are merged per currency, with bonus-only accounts still a balance', async () => {
  const bonusOnly = await ask({
    account: accountOf({ status: 'ready', value: [], bonusWallets: [{ currency: 'CNY', balance: '5.00' }] }),
  })
  assert.equal(bonusOnly.balance.primary.total, '5.00')
  assert.equal(bonusOnly.balance.primary.toppedUp, '0.00')

  const usdOnly = await ask({
    account: accountOf({ status: 'ready', value: [{ currency: 'USD', balance: '3.00' }], bonusWallets: [] }),
  })
  assert.equal(usdOnly.balance.primary.currency, 'USD')
  assert.equal(usdOnly.balance.primary.total, '3.00')
})

test('the identity the page reports is preferred and echoed on the route', async () => {
  const payload = await ask({
    account: accountOf(ACCOUNT_READY),
    headers: {
      'x-dsh-client-version': '1.2.3',
      'x-dsh-client-locale': 'en-US',
      'x-dsh-client-timezone-offset': '-28800',
    },
  })
  assert.deepEqual(accountCalls[0], {
    version: '1.2.3',
    locale: 'en-US',
    timezoneOffsetSeconds: -28800,
  })
  assert.equal(payload.clientSource, 'page')
  assert.equal(payload.client.version, '1.2.3')
})

test('a partial or malformed identity falls back field by field', async () => {
  await ask({
    account: accountOf(ACCOUNT_READY),
    config: { accountClientVersion: '9.9.9', locale: 'ja-JP' },
    headers: { 'x-dsh-client-locale': 'en-US' },
  })
  const partial = accountCalls[0]
  assert.equal(partial.locale, 'en-US', 'the page wins for the field it sent')
  assert.equal(partial.version, '9.9.9', 'a field the page did not send falls back to config')
  assert.ok(Number.isFinite(partial.timezoneOffsetSeconds))

  await ask({
    account: accountOf(ACCOUNT_READY),
    headers: { 'x-dsh-client-timezone-offset': 'not-a-number' },
  })
  assert.ok(
    Number.isFinite(accountCalls[0].timezoneOffsetSeconds),
    'a malformed zone must never reach Platform as NaN',
  )
})

test('a headless caller keeps working on the deployment defaults', async () => {
  const payload = await ask({ account: accountOf(ACCOUNT_READY) })
  assert.equal(payload.ok, true)
  assert.equal(payload.clientSource, 'defaults')
  assert.equal(typeof payload.client.version, 'string')
  assert.equal(typeof payload.client.locale, 'string')
  assert.ok(Number.isFinite(payload.client.timezoneOffsetSeconds))
})

test('the route carries a build marker so a stale module is visible', async () => {
  const payload = await ask({ account: accountOf(ACCOUNT_READY) })
  assert.equal(typeof payload.impl, 'string')
  assert.notEqual(payload.impl, '')
})
