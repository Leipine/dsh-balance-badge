// Browser half of the balance / billing-window plugin.
//
// A decoration in `conversation.composer.dock`: one muted chip under the
// composer showing the account balance and which billing window is in force,
// with a once-a-second countdown to the next switch. Every number comes from
// the Host route (`GET /deepseek-balance/summary`, see index.js); the API key
// never reaches this page.
//
// Written in the lazy-CJS module-loader protocol, exactly like the shipped
// decoration template: the factory id equals the package name, React comes from
// the browser module table, and no Client package is imported.
window.__ModuleLoader__.load({
  id: 'dsh-balance-badge',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Mirrors DEFAULT_PATH in index.js; change both together. */
    const ENDPOINT = '/deepseek-balance/summary'
    /** The upstream read is cached Host-side for 60s, so polling faster is waste. */
    const POLL_MS = 60000

    const TEXT = {
      zh: {
        balance: '余额',
        offpeak: '优惠时段',
        standard: '标准时段',
        left: '剩',
        granted: '赠送',
        toppedUp: '充值',
        loading: '读取余额…',
        unavailable: '余额不可用',
        priceIn: '入',
        priceHit: '命中',
        priceOut: '出',
        perMillion: '/M',
        cacheMiss: '输入（缓存未命中）',
        cacheHit: '输入（缓存命中）',
        output: '输出',
        peakRow: '高峰价',
        offpeakRow: '低谷价',
        priceSource: '价格来源',
        switchesAt: '下一次切换',
      },
      en: {
        balance: 'Balance',
        offpeak: 'Discounted',
        standard: 'Standard',
        left: 'left',
        granted: 'granted',
        toppedUp: 'topped up',
        loading: 'Reading balance…',
        unavailable: 'Balance unavailable',
        priceIn: 'in',
        priceHit: 'hit',
        priceOut: 'out',
        perMillion: '/M',
        cacheMiss: 'input (cache miss)',
        cacheHit: 'input (cache hit)',
        output: 'output',
        peakRow: 'Peak',
        offpeakRow: 'Off-peak',
        priceSource: 'Price source',
        switchesAt: 'Next switch',
      },
    }

    // The shipped web shell freezes <html lang="zh-CN">, so this is a reliable
    // read of the interface language in practice; a locale service is not
    // required for a chip this size.
    function pickText() {
      const lang = String(document.documentElement.lang || navigator.language || 'zh').toLowerCase()
      return lang.startsWith('zh') ? TEXT.zh : TEXT.en
    }

    function symbolOf(currency) {
      if (currency === 'CNY') return '¥'
      if (currency === 'USD') return '$'
      return currency === '' ? '' : `${currency} `
    }

    function amountOf(value, currency) {
      const parsed = Number(value)
      const shown = Number.isFinite(parsed) ? parsed.toFixed(2) : String(value ?? '')
      return `${symbolOf(currency)}${shown}`
    }

    /**
     * A list price, in 元/百万 tokens. These span 0.02 to 27, where two fixed
     * decimals would either pad 27 into "27.00" or round 0.02 badly, so whole
     * numbers stay whole and sub-1 prices keep up to two trimmed decimals.
     */
    function priceOf(value) {
      const parsed = Number(value)
      if (!Number.isFinite(parsed)) return String(value ?? '')
      if (parsed >= 1) return String(parsed)
      return parsed.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
    }

    /** '2026-10-09 09:00' in the browser's own zone, for the tooltip. */
    function formatLocal(epochMs) {
      if (!Number.isFinite(epochMs)) return ''
      const d = new Date(epochMs)
      const pad = (n) => (n < 10 ? `0${n}` : String(n))
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    function formatRemain(ms) {
      if (!Number.isFinite(ms) || ms < 0) return ''
      const total = Math.floor(ms / 1000)
      const hours = Math.floor(total / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      const seconds = total % 60
      const pad = (n) => (n < 10 ? `0${n}` : String(n))
      return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
    }

    function BalanceChip() {
      const [data, setData] = React.useState(null)
      // The countdown is derived from the last payload, so a bare tick is all
      // the second-by-second update needs.
      const [, setTick] = React.useState(0)

      React.useEffect(() => {
        let alive = true
        const load = () => {
          fetch(ENDPOINT, { headers: { accept: 'application/json' } })
            .then((response) => {
              if (!response.ok) throw new Error(`HTTP ${response.status}`)
              return response.json()
            })
            .then((body) => {
              if (alive) setData(body)
            })
            .catch((error) => {
              // Keep the last good payload on a transient failure; only a first
              // load with nothing to show reports the error.
              if (alive) {
                setData((previous) => previous ?? { ok: false, error: String(error?.message ?? error) })
              }
            })
        }
        load()
        const timer = window.setInterval(load, POLL_MS)
        return () => {
          alive = false
          window.clearInterval(timer)
        }
      }, [])

      React.useEffect(() => {
        const timer = window.setInterval(() => setTick((n) => n + 1), 1000)
        return () => window.clearInterval(timer)
      }, [])

      const t = pickText()
      const windowInfo = data?.window ?? null
      const entry = data?.balance?.primary ?? null
      const offpeak = windowInfo?.state === 'offpeak'
      const scheduleKnown = windowInfo !== null && windowInfo.scheduleKnown !== false
      const remain =
        windowInfo !== null && Number.isFinite(windowInfo.nextChangeAt)
          ? Math.max(0, windowInfo.nextChangeAt - Date.now())
          : null

      const pricing = data?.pricing ?? null
      // The Host sends both tariffs; which one is in force is the window's call.
      const priceSet = pricing === null ? null : offpeak ? pricing.offpeak : pricing.peak

      const details = []
      if (entry !== null) {
        details.push(
          `${t.balance} ${amountOf(entry.total, entry.currency)}（${t.granted} ${amountOf(entry.granted, entry.currency)} · ${t.toppedUp} ${amountOf(entry.toppedUp, entry.currency)}）`,
        )
      }
      if (pricing !== null) {
        details.push(`${pricing.model}（${pricing.label}）· ${pricing.unit}`)
        details.push(
          `  ${t.offpeakRow}：${t.cacheMiss} ¥${priceOf(pricing.offpeak.cacheMiss)} · ${t.cacheHit} ¥${priceOf(pricing.offpeak.cacheHit)} · ${t.output} ¥${priceOf(pricing.offpeak.output)}`,
        )
        details.push(
          `  ${t.peakRow}：${t.cacheMiss} ¥${priceOf(pricing.peak.cacheMiss)} · ${t.cacheHit} ¥${priceOf(pricing.peak.cacheHit)} · ${t.output} ¥${priceOf(pricing.peak.output)}`,
        )
      }
      if (windowInfo !== null && windowInfo.note !== '') details.push(windowInfo.note)
      if (windowInfo !== null && Number.isFinite(windowInfo.nextChangeAt)) {
        details.push(`${t.switchesAt}：${formatLocal(windowInfo.nextChangeAt)}`)
      }
      if (pricing !== null) details.push(`${t.priceSource}：${pricing.source}（${pricing.checkedOn}）`)
      if (data?.error) details.push(data.error)

      const separator = (key) =>
        h('span', { key, style: { color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))' } }, '·')

      const parts = []
      if (data === null) {
        parts.push(
          h(
            'span',
            { key: 'loading', style: { color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))' } },
            t.loading,
          ),
        )
      } else if (entry === null) {
        parts.push(
          h(
            'span',
            { key: 'unavailable', style: { color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))' } },
            t.unavailable,
          ),
        )
      } else {
        parts.push(h('span', { key: 'balance' }, `${t.balance} ${amountOf(entry.total, entry.currency)}`))
      }

      // The price for the window that is in force, inline, because knowing what
      // the current tariff costs is the point of the chip. The tooltip carries
      // both tariffs plus the source.
      if (priceSet !== null) {
        parts.push(separator('sep-price'))
        parts.push(
          h(
            'span',
            { key: 'price' },
            `${t.priceIn}¥${priceOf(priceSet.cacheMiss)} ${t.priceHit}¥${priceOf(priceSet.cacheHit)} ${t.priceOut}¥${priceOf(priceSet.output)} ${t.perMillion}`,
          ),
        )
      }

      if (scheduleKnown) {
        const label = offpeak ? t.offpeak : t.standard
        const countdown = remain !== null ? formatRemain(remain) : ''
        parts.push(separator('sep-window'))
        parts.push(h('span', { key: 'window' }, countdown === '' ? label : `${label} ${t.left} ${countdown}`))
      }

      return h(
        'div',
        {
          title: details.length > 0 ? details.join('\n') : undefined,
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '0 2px',
            fontSize: '12px',
            lineHeight: 1.5,
            color: 'var(--dsw-alias-label-secondary, inherit)',
            whiteSpace: 'nowrap',
            userSelect: 'none',
          },
        },
        h('span', {
          key: 'dot',
          'aria-hidden': true,
          style: {
            flex: 'none',
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            // Both states are theme aliases, so the dot follows light and dark
            // themes instead of pinning a colour the host cannot restyle.
            background: offpeak
              ? 'var(--dsw-alias-state-success-primary, #2ea043)'
              : 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
          },
        }),
        parts,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'deepseek-balance', order: 20 },
            BalanceChip,
          ),
        )
      },
    }
  },
})
