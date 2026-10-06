// Unit tests for lib/pricing.js — node:test and node:assert/strict only, no
// npm install and no test framework.
//
// Every instant here is built with explicit UTC arithmetic, so the expectations
// hold on a machine in any zone. Most cases neutralise the holiday table with
// `{ holidays: [] }` so that editing the calendar cannot silently break a test
// about the weekly peak rule; the calendar gets its own cases at the end.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  describeWindow,
  classify,
  getNextChange,
  getBeijingParts,
  formatBeijingDateTime,
  HOLIDAYS_2026,
} from '../lib/pricing.js'

const HOUR = 60 * 60 * 1000
const BEIJING_OFFSET = 8 * HOUR
const NO_HOLIDAYS = { holidays: [] }
const pad = (n) => String(n).padStart(2, '0')

/** Epoch ms for a Beijing wall-clock reading. */
function beijing(dateKey, hours = 0, minutes = 0) {
  const [year, month, day] = dateKey.split('-').map(Number)
  return Date.UTC(year, month - 1, day, hours, minutes) - BEIJING_OFFSET
}

/** 'YYYY-MM-DD HH:mm' in Beijing, derived independently of the module under test. */
function label(ms) {
  const d = new Date(ms + BEIJING_OFFSET)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

/** Beijing weekday, 0 = Sunday. Ground truth straight from the engine. */
function weekday(dateKey) {
  // Shift into Beijing first: reading getUTCDay() on the raw instant would
  // report the weekday of the *previous* UTC day for any Beijing midnight.
  return new Date(beijing(dateKey) + BEIJING_OFFSET).getUTCDay()
}

const stateAt = (dateKey, hours, minutes = 0) =>
  describeWindow(beijing(dateKey, hours, minutes), NO_HOLIDAYS).state

// 2026-10-12 is a Monday and 2026-10-09 a Friday; assert that rather than
// trusting the comment, because the whole suite is anchored on them.
const MONDAY = '2026-10-12'
const FRIDAY = '2026-10-09'
const SATURDAY = '2026-10-10'
const SUNDAY = '2026-10-11'

test('fixture dates have the weekdays the tests assume', () => {
  assert.equal(weekday(MONDAY), 1)
  assert.equal(weekday(FRIDAY), 5)
  assert.equal(weekday(SATURDAY), 6)
  assert.equal(weekday(SUNDAY), 0)
})

test('peak windows sit at Beijing 09:00-12:00 and 14:00-18:00', () => {
  assert.equal(stateAt(MONDAY, 8, 59), 'offpeak')
  assert.equal(stateAt(MONDAY, 9, 0), 'standard', 'peak starts at 09:00 inclusive')
  assert.equal(stateAt(MONDAY, 10, 0), 'standard')
  assert.equal(stateAt(MONDAY, 11, 59), 'standard')
  assert.equal(stateAt(MONDAY, 12, 0), 'offpeak', 'peak ends at 12:00 exclusive')
  assert.equal(stateAt(MONDAY, 13, 59), 'offpeak', 'the midday gap is off-peak')
  assert.equal(stateAt(MONDAY, 14, 0), 'standard')
  assert.equal(stateAt(MONDAY, 17, 59), 'standard')
  assert.equal(stateAt(MONDAY, 18, 0), 'offpeak', 'peak ends at 18:00 exclusive')
  assert.equal(stateAt(MONDAY, 23, 59), 'offpeak')
})

test('regression: the peak window is not shifted by the UTC offset', () => {
  // A module that compared UTC window minutes against Beijing minutes without
  // adding +480 put the peaks at Beijing 01:00-04:00 and 06:00-10:00. These two
  // readings are the sharpest witnesses: 01:00 and 10:00 flip under that bug.
  assert.equal(stateAt(MONDAY, 1, 0), 'offpeak', '01:00 Beijing is NOT peak')
  assert.equal(stateAt(MONDAY, 10, 0), 'standard', '10:00 Beijing IS peak')
  assert.equal(stateAt(MONDAY, 2, 0), 'offpeak')
  assert.equal(stateAt(MONDAY, 7, 0), 'offpeak')
})

test('weekends are off-peak all day', () => {
  assert.equal(stateAt(SATURDAY, 10, 0), 'offpeak')
  assert.equal(stateAt(SATURDAY, 15, 0), 'offpeak')
  assert.equal(stateAt(SATURDAY, 3, 0), 'offpeak')
  assert.equal(stateAt(SUNDAY, 10, 0), 'offpeak')
  assert.equal(stateAt(SUNDAY, 15, 0), 'offpeak')
})

test('countdown arithmetic lands on the next boundary', () => {
  const at = beijing(MONDAY, 9, 0)
  const verdict = describeWindow(at, NO_HOLIDAYS)
  assert.equal(verdict.state, 'standard')
  assert.equal(label(verdict.nextChangeAt), `${MONDAY} 12:00`)
  assert.equal(verdict.remainMs, 3 * HOUR)
  assert.equal(verdict.remainMs, verdict.nextChangeAt - at)
})

test('the midday gap counts down to the afternoon peak', () => {
  const verdict = describeWindow(beijing(MONDAY, 12, 0), NO_HOLIDAYS)
  assert.equal(verdict.state, 'offpeak')
  assert.equal(label(verdict.nextChangeAt), `${MONDAY} 14:00`)
  assert.equal(verdict.remainMs, 2 * HOUR)
})

test('Friday evening counts down across the weekend to Monday morning', () => {
  const verdict = describeWindow(beijing(FRIDAY, 18, 0), NO_HOLIDAYS)
  assert.equal(verdict.state, 'offpeak')
  assert.equal(label(verdict.nextChangeAt), `${MONDAY} 09:00`)
  assert.equal(verdict.remainMs, 3 * 24 * HOUR - 9 * HOUR)
})

test('boundaries hold across a month and a year rollover', () => {
  // 2026-12-31 is a Thursday; 2027-01-01 a Friday.
  assert.equal(weekday('2026-12-31'), 4)
  assert.equal(weekday('2027-01-01'), 5)

  const newYearEve = describeWindow(beijing('2026-12-31', 10, 0), NO_HOLIDAYS)
  assert.equal(newYearEve.state, 'standard')
  assert.equal(label(newYearEve.nextChangeAt), '2026-12-31 12:00')

  const monthEnd = describeWindow(beijing('2026-10-31', 20, 0), NO_HOLIDAYS)
  assert.equal(monthEnd.state, 'offpeak')
  assert.equal(label(monthEnd.nextChangeAt), '2026-11-02 09:00', '31 Oct 2026 is a Saturday')

  const yearStart = describeWindow(beijing('2027-01-01', 9, 0), NO_HOLIDAYS)
  assert.equal(yearStart.state, 'standard')
  assert.equal(label(yearStart.nextChangeAt), '2027-01-01 12:00')
})

test('classification depends on the instant, never on the host time zone', () => {
  // The engine's own reading of the shifted instant must agree with the module,
  // whichever zone this process happens to run in.
  const at = beijing(MONDAY, 9, 30)
  const shifted = new Date(at + BEIJING_OFFSET)
  assert.equal(shifted.getUTCHours(), 9)
  assert.equal(shifted.getUTCMinutes(), 30)
  assert.equal(getBeijingParts(at).minutesOfDay, 9 * 60 + 30)
  assert.equal(getBeijingParts(at).dateKey, MONDAY)
  assert.equal(describeWindow(at, NO_HOLIDAYS).state, 'standard')
  assert.equal(formatBeijingDateTime(at), `${MONDAY} 09:30`)
})

test('a Date instance and its epoch milliseconds agree', () => {
  const at = beijing(MONDAY, 15, 0)
  assert.deepEqual(describeWindow(new Date(at), NO_HOLIDAYS), describeWindow(at, NO_HOLIDAYS))
})

test('classify and getNextChange match describeWindow', () => {
  const at = beijing(MONDAY, 12, 30)
  assert.equal(classify(at, NO_HOLIDAYS), 'offpeak')
  assert.equal(getNextChange(at, NO_HOLIDAYS), describeWindow(at, NO_HOLIDAYS).nextChangeAt)
})

test('an explicit holiday moves an otherwise-peak weekday to off-peak', () => {
  const at = beijing(MONDAY, 10, 0)
  assert.equal(describeWindow(at, NO_HOLIDAYS).state, 'standard')
  const holiday = describeWindow(at, { holidays: [MONDAY] })
  assert.equal(holiday.state, 'offpeak')
  assert.equal(holiday.discountPercent, 50)
  assert.match(holiday.note, /节假日|法定/)
})

test('the reported schedule is known and reports a 50% off-peak discount', () => {
  const offpeak = describeWindow(beijing(MONDAY, 3, 0), NO_HOLIDAYS)
  assert.equal(offpeak.scheduleKnown, true)
  assert.equal(offpeak.discountPercent, 50)
  assert.equal(describeWindow(beijing(MONDAY, 10, 0), NO_HOLIDAYS).discountPercent, 0)
  assert.ok(offpeak.note.length > 0)
})

test('the shipped 2026 calendar only contains well-formed Beijing dates', () => {
  assert.ok(HOLIDAYS_2026.length > 0)
  for (const item of HOLIDAYS_2026) {
    assert.match(item.date, /^\d{4}-\d{2}-\d{2}$/)
    assert.equal(Number(item.date.slice(0, 4)), 2026)
    assert.ok(typeof item.name === 'string' && item.name.length > 0)
  }
  // Every entry must survive a round trip through the classifier.
  for (const item of HOLIDAYS_2026) {
    const verdict = describeWindow(beijing(item.date, 10, 0))
    assert.equal(verdict.state, 'offpeak', `${item.date} (${item.name}) should be off-peak`)
  }
})

test('an invalid instant is rejected rather than silently classified', () => {
  assert.throws(() => describeWindow(Number.NaN), TypeError)
  assert.throws(() => describeWindow('2026-10-12'), TypeError)
  assert.throws(() => describeWindow(new Date(Number.NaN)), TypeError)
})
