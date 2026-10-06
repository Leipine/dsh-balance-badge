// Tests for the price table in lib/pricing.js.
//
// The numbers are the ones published on the official price page and fetched on
// 2026-10-06; they are asserted literally so that an accidental edit shows up as
// a failure rather than as a silently wrong price on the chip. The structural
// invariant the page states — 空闲时段价格为高峰时段价格的一半 — is asserted
// separately, over every model and every field, so a new model cannot be added
// with an inconsistent pair.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PRICES,
  DEFAULT_PRICE_MODEL,
  PRICE_SOURCE,
  PRICE_UNIT,
  priceTableFor,
} from '../lib/pricing.js'

test('the default model is the one this account runs', () => {
  assert.equal(DEFAULT_PRICE_MODEL, 'deepseek-flash')
  assert.equal(priceTableFor().model, 'deepseek-flash')
  assert.equal(priceTableFor('').model, 'deepseek-flash')
  assert.equal(priceTableFor('   ').model, 'deepseek-flash')
})

test('deepseek-flash matches the published table', () => {
  const table = priceTableFor('deepseek-flash')
  assert.equal(table.label, 'DeepSeek-V4.1-Flash')
  assert.deepEqual(table.offpeak, { cacheHit: 0.02, cacheMiss: 1, output: 4 })
  assert.deepEqual(table.peak, { cacheHit: 0.04, cacheMiss: 2, output: 8 })
})

test('deepseek-v4-pro matches the published table', () => {
  const table = priceTableFor('deepseek-v4-pro')
  assert.equal(table.label, 'DeepSeek-V4-Pro-0813')
  assert.deepEqual(table.offpeak, { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 })
  assert.deepEqual(table.peak, { cacheHit: 0.3, cacheMiss: 9, output: 27 })
})

test('every model prices off-peak at exactly half of peak', () => {
  // The price page states this as a rule, not as a coincidence: 空闲时段价格为
  // 高峰时段价格的一半. Floating point makes an exact equality the wrong
  // assertion for 4.5 and 13.5, so compare at a tolerance far below any real
  // price increment.
  for (const [model, entry] of Object.entries(PRICES)) {
    for (const field of ['cacheHit', 'cacheMiss', 'output']) {
      const half = entry.peak[field] / 2
      assert.ok(
        Math.abs(entry.offpeak[field] - half) < 1e-9,
        `${model}.${field}: offpeak ${entry.offpeak[field]} is not half of peak ${entry.peak[field]}`,
      )
    }
  }
})

test('a table carries its unit, currency and source', () => {
  const table = priceTableFor('deepseek-flash')
  assert.equal(table.currency, 'CNY')
  assert.equal(table.unit, PRICE_UNIT)
  assert.equal(table.source, PRICE_SOURCE)
  assert.equal(table.checkedOn, '2026-10-06')
})

test('an unknown model yields null instead of invented prices', () => {
  assert.equal(priceTableFor('gpt-4'), null)
  assert.equal(priceTableFor('deepseek-chat'), null)
  assert.deepEqual(priceTableFor(null), priceTableFor(DEFAULT_PRICE_MODEL))
  assert.deepEqual(priceTableFor(undefined), priceTableFor(DEFAULT_PRICE_MODEL))
})

test('the returned table is detached from the module constants', () => {
  const first = priceTableFor('deepseek-flash')
  first.peak.output = 999
  const second = priceTableFor('deepseek-flash')
  assert.equal(second.peak.output, 8, 'mutating a returned table must not leak into PRICES')
})
