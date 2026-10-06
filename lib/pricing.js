/**
 * DeepSeek API 计费时段（峰谷定价）—— 纯函数模块，零依赖，仅使用 ESM 与标准内置对象。
 * ===========================================================================
 * 一、时区陷阱（改代码前务必先读）
 * ---------------------------------------------------------------------------
 * DeepSeek 的计费时段是按**北京时间（UTC+8）**宣布的，但只要代码用「本地时间」
 * 去解释它，就一定会错：同一个 epoch 毫秒，在北京机器、UTC 机器、纽约机器上
 * `new Date(ms).getHours()` 会给出三个不同答案。
 *
 * 换算关系（本模块的全部依据）：
 *   - 北京时间 09:00–12:00  ==  UTC 01:00–04:00（同一个 UTC 日期）
 *   - 北京时间 14:00–18:00  ==  UTC 06:00–10:00（同一个 UTC 日期）
 *   - 历史错峰窗口 16:30–00:30 UTC  ==  北京时间**次日** 00:30–08:30（跨日！）
 *
 * 本模块避免该陷阱的三条硬规则：
 *   1) 只使用 Date 的 `getUTC*` 系列取值，绝不使用 `getHours()` / `getDay()`
 *      这类依赖本地时区的接口；
 *   2) 需要「北京墙上时钟」时，把 epoch 毫秒整体平移 +480 分钟后**再读 UTC 字段**
 *      （见 getBeijingParts）。平移后读出来的年月日时分就是北京时间本身，
 *      与运行环境的 TZ、夏令时完全无关；
 *   3) 所有对外 API 的时刻都由参数传入（epoch 毫秒或 Date 实例），模块内部
 *      **从不调用 Date.now()**，因此测试可以确定性复现，宿主也可以随意传时刻。
 *
 * ===========================================================================
 * 二、当前结论（2026-10-06 复核）
 * ---------------------------------------------------------------------------
 * 错峰优惠**存在**，但形态与历史完全不同：不是「每天 16:30–00:30 UTC 打折」，
 * 而是「默认半价 + 工作日两段高峰按标准价」：
 *
 *   - 高峰（标准价）：北京时间 周一至周五 09:00–12:00、14:00–18:00
 *   - 空闲（半价 = 高峰价的 50%）：其余全部时间，含周末与中国法定节假日；
 *     调休上班的周末同样按空闲时段计费
 *   - 生效：北京时间 2026-08-17 00:00 起；2026-08-23 起追加「周末/节假日全天
 *     按空闲时段计费」
 *
 * 因此 `scheduleKnown === true`。历史 16:30–00:30 UTC 的每日错峰优惠时段
 * **已不再适用**，见 LEGACY_OFFPEAK_WINDOW（active: false）。
 * 证据链接与不确定项见 docs/PRICING.md。
 *
 * 时段表是可修正的数据（SCHEDULE / CALENDAR_RULES / HOLIDAY_RANGES_2026），
 * 官方规则变化时只改数据、不动下面的判定逻辑；若官方取消优惠时段，把时段表
 * 改成只剩一个标准价默认项即可，模块会如实降级（nextChangeAt = null、
 * scheduleKnown = false，并在 note 中说明）。
 * ===========================================================================
 */

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
const MINUTES_PER_DAY = 1_440;

/** 北京时间相对 UTC 的偏移（分钟）。 */
export const BEIJING_UTC_OFFSET_MINUTES = 480;

/** 计费时段状态：标准价（高峰）。 */
export const STATE_STANDARD = 'standard';
/** 计费时段状态：优惠价（空闲，价格为高峰价的 50%）。 */
export const STATE_OFFPEAK = 'offpeak';

/**
 * 历史（≤2025 年）的每日错峰优惠窗口：16:30–00:30 UTC
 * = 北京时间次日 00:30–08:30。该窗口在 2026-08-17 峰谷定价改版后**不再适用**。
 * 保留为数据仅供对照与文档引用；本模块的判定逻辑不会读取它。
 */
export const LEGACY_OFFPEAK_WINDOW = Object.freeze({
  active: false,
  label: '历史错峰优惠时段（已失效）',
  startUtcMinutes: 16 * 60 + 30, // 16:30 UTC
  endUtcMinutes: 30, // 00:30 UTC（跨日）
  discountPercent: 50, // 当时 V3 系列五折；R1 系列为 75 折（即 25% 折扣）
  note: '2026-08-17 起 DeepSeek 改用峰谷定价，历史 16:30–00:30 UTC 的每日错峰优惠时段不再适用。',
});

/**
 * 时段数据表（唯一的事实来源，可直接修正）。
 *
 * 字段说明：
 *   - startUtcMinutes / endUtcMinutes：以「UTC 当日 00:00 起的分钟数」表示的
 *     半开区间 [start, end)。若 start > end 表示跨 UTC 零点。null 表示「默认项」
 *     （不限定区间，仅在其它项都不匹配时兜底）。
 *   - daysOfWeek：允许命中的星期，按**北京时间**的星期判定（0=周日，6=周六）。
 *   - discountPercent：该时段的折扣百分比（50 = 五折/半价；0 = 标准价）。
 *
 * 校验锚点（test/pricing.test.mjs 会逐条断言）：
 *   60  == 01:00 UTC == 北京 09:00      240 == 04:00 UTC == 北京 12:00
 *   360 == 06:00 UTC == 北京 14:00      600 == 10:00 UTC == 北京 18:00
 */
export const SCHEDULE = Object.freeze([
  Object.freeze({
    id: 'cn-weekday-morning-peak',
    kind: STATE_STANDARD,
    label: '高峰时段（北京时间 周一至周五 09:00–12:00）',
    startUtcMinutes: 60, // 01:00 UTC = 北京时间 09:00
    endUtcMinutes: 240, // 04:00 UTC = 北京时间 12:00
    daysOfWeek: Object.freeze([1, 2, 3, 4, 5]),
    discountPercent: 0,
  }),
  Object.freeze({
    id: 'cn-weekday-afternoon-peak',
    kind: STATE_STANDARD,
    label: '高峰时段（北京时间 周一至周五 14:00–18:00）',
    startUtcMinutes: 360, // 06:00 UTC = 北京时间 14:00
    endUtcMinutes: 600, // 10:00 UTC = 北京时间 18:00
    daysOfWeek: Object.freeze([1, 2, 3, 4, 5]),
    discountPercent: 0,
  }),
  Object.freeze({
    id: 'offpeak-default',
    kind: STATE_OFFPEAK,
    label: '空闲时段（高峰时段之外的全部时间，价格为高峰价的 50%）',
    startUtcMinutes: null,
    endUtcMinutes: null,
    daysOfWeek: null,
    discountPercent: 50,
  }),
]);

/**
 * 时段规则的元信息。
 * `known: false` 表示「官方当前的峰谷定价规则未被确认」，此时 describeWindow
 * 会返回 scheduleKnown: false，note 中也会明确说明。
 */
export const SCHEDULE_META = Object.freeze({
  known: true,
  effectiveFrom: '2026-08-17T00:00:00+08:00',
  lastAmended: '2026-08-23T00:00:00+08:00',
  checkedOn: '2026-10-06',
  timezone: 'Asia/Shanghai (UTC+8)',
  peakSummary: '高峰（标准价）：北京时间 周一至周五 09:00–12:00、14:00–18:00',
  offpeakSummary: '空闲（半价）：其余全部时间，含周末与中国法定节假日',
  sources: Object.freeze([
    'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
    'https://www.cnfin.com/kx/detail/20260813/4454952_1.html',
    'https://www.stcn.com/article/detail/4103775.html',
    'https://www.ithome.com/1/004/494.htm',
  ]),
});

/**
 * 日历规则（与时段表正交）：2026-08-23 起，周末、调休上班的周末、
 * 中国法定节假日全天均按空闲时段计费。
 */
export const CALENDAR_RULES = Object.freeze({
  weekendsAreOffPeak: true,
  holidaysAreOffPeak: true,
  note: '2026-08-23 起：周末、调休上班的周末、中国法定节假日全天均按空闲时段计费。',
});

/**
 * 2026 年节假日表是否已与官方通知原文逐日核对。
 * ⚠️ 当前为 false：本环境无法抓取网页原文（web_fetch 被禁用），表中的日期来自
 * 新闻报道与推算。处于 false 状态时，note 会附上「节假日表未复核」的提示。
 * 核对来源：国务院办公厅关于 2026 年部分节假日安排的通知
 * https://www.gov.cn/zhengce/content/202511/content_7047090.htm
 */
export const HOLIDAY_TABLE_VERIFIED = false;

/**
 * 2026 年中国法定节假日区间（北京时间日期，含首尾）。
 * 只影响「工作日高峰是否生效」：落在这些日期上的全天都按空闲时段计费。
 *
 * confidence: 'reported' = 有直接新闻印证；'unverified' = 依据公开报道推算、待复核。
 */
const HOLIDAY_RANGES_2026 = Object.freeze([
  { name: '元旦', from: '2026-01-01', to: '2026-01-03', confidence: 'unverified' },
  { name: '春节', from: '2026-02-15', to: '2026-02-23', confidence: 'unverified' },
  { name: '清明节', from: '2026-04-04', to: '2026-04-06', confidence: 'reported' },
  { name: '劳动节', from: '2026-05-01', to: '2026-05-05', confidence: 'unverified' },
  { name: '端午节', from: '2026-06-19', to: '2026-06-21', confidence: 'unverified' },
  { name: '中秋节', from: '2026-09-25', to: '2026-09-27', confidence: 'unverified' },
  { name: '国庆节', from: '2026-10-01', to: '2026-10-08', confidence: 'unverified' },
]);

/** 展开后的节假日表：[{ date, name, confidence, year }]，date 为北京时间日期 'YYYY-MM-DD'。 */
export const HOLIDAYS_2026 = Object.freeze(expandHolidayRanges(HOLIDAY_RANGES_2026));

/** 已收录节假日数据的年份列表。 */
export const HOLIDAY_YEARS = Object.freeze(
  [...new Set(HOLIDAYS_2026.map((h) => h.date.slice(0, 4)))].sort(),
);

// ---------------------------------------------------------------------------
// 时间工具（全部为纯函数，只用 getUTC*，绝不触碰本地时区）
// ---------------------------------------------------------------------------

function pad2(value) {
  return String(value).padStart(2, '0');
}

/**
 * 把入参统一成 epoch 毫秒。
 * @param {number|Date} at epoch 毫秒，或 Date 实例
 * @returns {number}
 * @throws {TypeError} 入参不是数字/Date，或时间无效（NaN）
 */
export function toEpochMs(at) {
  if (at instanceof Date) {
    const ms = at.getTime();
    if (!Number.isFinite(ms)) throw new TypeError('pricing: 传入的 Date 无效（getTime() 为 NaN）');
    return ms;
  }
  if (typeof at === 'number') {
    if (!Number.isFinite(at)) throw new TypeError('pricing: 传入的时间戳必须是有限数字');
    return Math.trunc(at);
  }
  if (typeof at === 'bigint') {
    return Number(at);
  }
  throw new TypeError(`pricing: 需要 epoch 毫秒数或 Date 实例，收到 ${typeof at}`);
}

/**
 * 取「北京墙上时钟」的各个字段。做法：epoch + 480 分钟后只读 UTC 字段，
 * 因此与运行机器的本地时区、夏令时无关。
 * @param {number|Date} at
 * @returns {{epochMs:number, year:number, month:number, day:number, weekday:number,
 *            minutesOfDay:number, dateKey:string, isWeekend:boolean}}
 *          month 为 1–12；weekday 0=周日…6=周六（北京时间）；dateKey 'YYYY-MM-DD'。
 */
export function getBeijingParts(at) {
  const epochMs = toEpochMs(at);
  const shifted = new Date(epochMs + BEIJING_UTC_OFFSET_MINUTES * MS_PER_MINUTE);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  const weekday = shifted.getUTCDay();
  return {
    epochMs,
    year,
    month,
    day,
    weekday,
    minutesOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    dateKey: `${year}-${pad2(month)}-${pad2(day)}`,
    isWeekend: weekday === 0 || weekday === 6,
  };
}

/** 格式化为北京时间 'YYYY-MM-DD HH:mm'。 */
export function formatBeijingDateTime(at) {
  const parts = getBeijingParts(at);
  return `${parts.dateKey} ${formatBeijingClock(parts.minutesOfDay)}`;
}

/** 格式化为北京时间 'HH:mm'。 */
export function formatBeijingTime(at) {
  return formatBeijingClock(getBeijingParts(at).minutesOfDay);
}

function formatBeijingClock(minutesOfDay) {
  return `${pad2(Math.floor(minutesOfDay / 60))}:${pad2(minutesOfDay % 60)}`;
}

/**
 * 「UTC 当日分钟」→「北京当日分钟」。
 *
 * 必须加上 +480 偏移。SCHEDULE 里的 startUtcMinutes / endUtcMinutes 是按 UTC
 * 书写的（60 表示 01:00 UTC），而判定时比较的是北京墙上时钟的分钟数
 * （北京 09:00 = 540）。只做取模、不加偏移，会把高峰窗口整体**提前 8 小时**：
 * 实测高峰会落在北京时间 01:00–04:00 与 06:00–10:00，而不是文档与官方口径里的
 * 09:00–12:00 与 14:00–18:00。
 * test/pricing.test.mjs 用 2026-10-12（周一）09:00 / 12:00 / 14:00 / 18:00
 * 四个锚点锁死这个回归。
 */
function toBeijingMinutes(utcMinutes) {
  return (((utcMinutes + BEIJING_UTC_OFFSET_MINUTES) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/** 'YYYY-MM-DD' → 该日历日 00:00 的「UTC 日历毫秒」（纯日历值，不代表瞬时）。 */
function dateKeyToCalendarMs(dateKey) {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey));
  if (!matched) throw new TypeError(`pricing: 无效日期 '${dateKey}'，应为 YYYY-MM-DD`);
  return Date.UTC(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3]));
}

/** 「UTC 日历毫秒」→ 'YYYY-MM-DD'。 */
function calendarMsToDateKey(calendarMs) {
  const d = new Date(calendarMs);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** 把节假日区间展开成逐日条目。 */
function expandHolidayRanges(ranges) {
  const out = [];
  for (const range of ranges) {
    const start = dateKeyToCalendarMs(range.from);
    const end = dateKeyToCalendarMs(range.to);
    if (end < start) {
      throw new TypeError(`pricing: 节假日区间结束早于开始（${range.from} → ${range.to}）`);
    }
    for (let cursor = start; cursor <= end; cursor += MS_PER_DAY) {
      const date = calendarMsToDateKey(cursor);
      out.push(Object.freeze({ date, name: range.name, confidence: range.confidence, year: Number(date.slice(0, 4)) }));
    }
  }
  return out;
}

const DEFAULT_HOLIDAY_INDEX = new Map(HOLIDAYS_2026.map((h) => [h.date, h]));

function buildHolidayIndex(holidays) {
  const index = new Map();
  for (const item of holidays) {
    if (typeof item === 'string') {
      const date = item.trim();
      dateKeyToCalendarMs(date); // 校验格式
      index.set(date, Object.freeze({ date, name: '法定节假日', confidence: 'user-supplied', year: Number(date.slice(0, 4)) }));
      continue;
    }
    if (item && typeof item === 'object' && typeof item.date === 'string') {
      const date = item.date.trim();
      dateKeyToCalendarMs(date);
      index.set(date, Object.freeze({ date, name: item.name ?? '法定节假日', confidence: item.confidence ?? 'user-supplied', year: Number(date.slice(0, 4)) }));
      continue;
    }
    throw new TypeError('pricing: options.holidays 的每一项应为 YYYY-MM-DD 字符串或 { date, name }');
  }
  return index;
}

// ---------------------------------------------------------------------------
// 判定逻辑（只消费上面的数据）
// ---------------------------------------------------------------------------

/** 判定 minutesOfDay（北京分钟）是否落在半开区间 [start, end) 内；start > end 表示跨零点。 */
function isWithinWindow(minutesOfDay, startMinutes, endMinutes) {
  if (startMinutes === endMinutes) return false;
  if (startMinutes < endMinutes) return minutesOfDay >= startMinutes && minutesOfDay < endMinutes;
  return minutesOfDay >= startMinutes || minutesOfDay < endMinutes;
}

function hasExplicitWindow(entry) {
  return entry && entry.startUtcMinutes != null && entry.endUtcMinutes != null;
}

function normalizeSchedule(schedule) {
  if (schedule == null) return SCHEDULE;
  if (!Array.isArray(schedule)) throw new TypeError('pricing: options.schedule 必须是数组');
  return schedule;
}

function scheduleHasOffpeak(schedule) {
  return schedule.some((entry) => entry && entry.kind === STATE_OFFPEAK && Number.isFinite(entry.discountPercent));
}

/** 组装一次判定所需的上下文（避免在候选点循环里重复解析数据）。 */
function buildContext(options = {}) {
  const schedule = normalizeSchedule(options.schedule);
  const holidays = options.holidays == null ? DEFAULT_HOLIDAY_INDEX : buildHolidayIndex(options.holidays);
  const weekendsAreOffPeak = options.weekendsAreOffPeak ?? CALENDAR_RULES.weekendsAreOffPeak;
  const holidaysAreOffPeak = options.holidaysAreOffPeak ?? CALENDAR_RULES.holidaysAreOffPeak;
  const scheduleKnown =
    options.scheduleKnown ?? (Boolean(SCHEDULE_META.known) && scheduleHasOffpeak(schedule));
  const holidayTableVerified = options.holidayTableVerified ?? HOLIDAY_TABLE_VERIFIED;
  return { schedule, holidays, weekendsAreOffPeak, holidaysAreOffPeak, scheduleKnown, holidayTableVerified };
}

/** 在已解析的上下文中判定某个瞬时的时段。 */
function classifyWith(context, atMs) {
  const parts = getBeijingParts(atMs);
  const holiday = context.holidays.get(parts.dateKey) ?? null;
  const weekendForcedOffPeak = context.weekendsAreOffPeak && parts.isWeekend;
  const holidayForcedOffPeak = context.holidaysAreOffPeak && holiday !== null;
  const forcedOffPeak = weekendForcedOffPeak || holidayForcedOffPeak;

  const defaultEntry =
    context.schedule.find((entry) => entry && !hasExplicitWindow(entry)) ?? null;

  let entry = null;
  if (!forcedOffPeak) {
    for (const candidate of context.schedule) {
      if (!hasExplicitWindow(candidate)) continue;
      if (candidate.daysOfWeek && !candidate.daysOfWeek.includes(parts.weekday)) continue;
      const start = toBeijingMinutes(candidate.startUtcMinutes);
      const end = toBeijingMinutes(candidate.endUtcMinutes);
      if (isWithinWindow(parts.minutesOfDay, start, end)) {
        entry = candidate;
        break;
      }
    }
  }
  if (!entry) entry = defaultEntry;

  const state = entry && entry.kind === STATE_OFFPEAK ? STATE_OFFPEAK : STATE_STANDARD;
  const discountPercent =
    state === STATE_OFFPEAK && Number.isFinite(entry?.discountPercent) ? entry.discountPercent : 0;

  return {
    state,
    discountPercent,
    entry,
    parts,
    dayInfo: {
      isWeekend: parts.isWeekend,
      holiday,
      weekendForcedOffPeak,
      holidayForcedOffPeak,
      forcedOffPeak,
    },
    scheduleKnown: context.scheduleKnown,
    holidayTableVerified: context.holidayTableVerified,
  };
}

/**
 * 某个瞬时属于哪个计费时段。
 * @param {number|Date} at
 * @param {object} [options] 见 describeWindow
 * @returns {'offpeak'|'standard'}
 */
export function classify(at, options) {
  const context = buildContext(options);
  return classifyWith(context, toEpochMs(at)).state;
}

/**
 * 计算某个瞬时对应的「北京日历日 00:00」的 epoch 毫秒。
 * 做法：先取该北京日期的 UTC 日历值，再减掉 8 小时。
 */
function beijingDayStartMs(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day) - BEIJING_UTC_OFFSET_MINUTES * MS_PER_MINUTE;
}

/** 把「北京某日的第 X 分钟」换算成 epoch 毫秒。 */
function beijingMinutesToEpochMs(dayStartMs, beijingMinutes) {
  return dayStartMs + beijingMinutes * MS_PER_MINUTE;
}

/**
 * 收集一段时间窗内所有可能的切换候选点（时段窗口的起止边界）。
 * 额外的 ±1 天冗余候选不会引入假边界：只有当候选点的判定结果与当前不同时才会被采用。
 */
function collectBoundaryCandidates(centerParts, horizonDays, schedule) {
  const candidates = [];
  const firstDayStart = beijingDayStartMs(centerParts);
  for (let dayOffset = -1; dayOffset <= horizonDays; dayOffset += 1) {
    const dayStartMs = firstDayStart + dayOffset * MS_PER_DAY;
    for (const entry of schedule) {
      if (!hasExplicitWindow(entry)) continue;
      const startMinutes = toBeijingMinutes(entry.startUtcMinutes);
      const endMinutes = toBeijingMinutes(entry.endUtcMinutes);
      // 跨零点的窗口，其结束点落在次日。
      const endDayOffset = entry.endUtcMinutes <= entry.startUtcMinutes ? 1 : 0;
      candidates.push(beijingMinutesToEpochMs(dayStartMs, startMinutes));
      candidates.push(beijingMinutesToEpochMs(dayStartMs + endDayOffset * MS_PER_DAY, endMinutes));
    }
  }
  return candidates.sort((a, b) => a - b);
}

const BOUNDARY_HORIZON_DAYS = 40;

/**
 * 下一个时段切换点的 epoch 毫秒；若时段表里根本不存在切换点则返回 null。
 * @param {number|Date} at
 * @param {object} [options] 见 describeWindow
 * @returns {number|null}
 */
export function getNextChange(at, options) {
  const atMs = toEpochMs(at);
  const context = buildContext(options);
  const current = classifyWith(context, atMs);
  const candidates = collectBoundaryCandidates(current.parts, BOUNDARY_HORIZON_DAYS, context.schedule);
  for (const candidate of candidates) {
    if (candidate <= atMs) continue;
    if (classifyWith(context, candidate).state !== current.state) return candidate;
  }
  return null;
}

/** 组装中文说明文本。 */
function buildNote(context, info, nextChangeAt) {
  const sentences = [];
  const atLabel = formatBeijingDateTime(info.parts.epochMs);

  if (info.state === STATE_STANDARD) {
    sentences.push(
      `当前为高峰时段（北京时间 ${atLabel}，高峰为周一至周五 09:00–12:00、14:00–18:00），按标准价计费。`,
    );
  } else if (info.dayInfo.holidayForcedOffPeak) {
    sentences.push(
      `当前为空闲时段（中国法定节假日：${info.dayInfo.holiday.name}，北京时间 ${atLabel}），价格为高峰价的 50%。`,
    );
  } else if (info.dayInfo.weekendForcedOffPeak) {
    sentences.push(`当前为空闲时段（周末全天不计高峰，北京时间 ${atLabel}），价格为高峰价的 50%。`);
  } else {
    sentences.push(`当前为空闲时段（高峰时段之外，北京时间 ${atLabel}），价格为高峰价的 50%。`);
  }

  if (nextChangeAt === null) {
    sentences.push('当前时段表没有可用的切换点。');
  } else {
    const tail = info.state === STATE_STANDARD ? '转为空闲时段、价格为高峰价的 50%' : '转为高峰时段、按标准价计费';
    sentences.push(`下一次切换：北京时间 ${formatBeijingDateTime(nextChangeAt)}（${tail}）。`);
  }

  if (info.scheduleKnown === false) {
    sentences.push('官方当前的峰谷定价规则未能确认，以上时段仅供参考。');
  }

  if (info.dayInfo.holidayForcedOffPeak && info.holidayTableVerified === false) {
    sentences.push('节假日表未与国务院办公厅通知逐日核对，请以官方通知为准。');
  } else if (context.holidaysAreOffPeak && !HOLIDAY_YEARS.includes(String(info.parts.year))) {
    sentences.push(`${info.parts.year} 年法定节假日表未收录，该年节假日当天可能被误判为高峰。`);
  }

  return sentences.join('');
}

/**
 * 描述某个瞬时落在哪个计费时段，并给出下一次切换与倒计时。
 *
 * @param {number|Date} at epoch 毫秒或 Date 实例（模块不读系统时钟）
 * @param {object} [options]
 * @param {Array} [options.schedule] 覆盖 SCHEDULE 的时段表
 * @param {Array<string|{date:string,name?:string}>} [options.holidays] 覆盖内置节假日表
 * @param {boolean} [options.weekendsAreOffPeak] 覆盖「周末全天空闲」规则
 * @param {boolean} [options.holidaysAreOffPeak] 覆盖「节假日全天空闲」规则
 * @param {boolean} [options.scheduleKnown] 覆盖 scheduleKnown
 * @param {boolean} [options.holidayTableVerified] 覆盖节假日表复核标记
 * @returns {{state:'offpeak'|'standard', discountPercent:number, nextChangeAt:number|null,
 *            remainMs:number|null, scheduleKnown:boolean, note:string}}
 *   state          该时刻的计费时段；
 *   discountPercent 空闲时段为折扣百分比（50 = 五折/减半），标准时段为 0；
 *   nextChangeAt   下一次切换的 epoch 毫秒（UTC 瞬时），无切换点为 null；
 *   remainMs       nextChangeAt - at（毫秒，恒 > 0），无切换点为 null；
 *   scheduleKnown  规则是否已知（官方取消优惠时段时为 false）；
 *   note           中文补充说明，可能为空字符串。
 * @throws {TypeError} at 不是有效的 epoch 毫秒或 Date
 */
export function describeWindow(at, options) {
  const atMs = toEpochMs(at);
  const context = buildContext(options);
  const info = classifyWith(context, atMs);
  const nextChangeAt = getNextChangeWithContext(context, atMs, info);
  return {
    state: info.state,
    discountPercent: info.discountPercent,
    nextChangeAt,
    remainMs: nextChangeAt === null ? null : nextChangeAt - atMs,
    scheduleKnown: info.scheduleKnown,
    note: buildNote(context, info, nextChangeAt),
  };
}

/** getNextChange 的内部版本：复用已算好的当前判定结果。 */
function getNextChangeWithContext(context, atMs, currentInfo) {
  const candidates = collectBoundaryCandidates(currentInfo.parts, BOUNDARY_HORIZON_DAYS, context.schedule);
  for (const candidate of candidates) {
    if (candidate <= atMs) continue;
    if (classifyWith(context, candidate).state !== currentInfo.state) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 价格表（元 / 百万 tokens）
//
// 抄自官方价格页，2026-10-06 用 Invoke-WebRequest 抓取原文核对（本机 web_fetch
// 被 DNS 拦截，但 shell 的网络是通的）。官方页面同时给出了两条与本模块一致的
// 口径，等于外部验证：
//   「空闲时段价格为高峰时段价格的一半」——这正是下面每项 offpeak = peak / 2；
//   「北京时间周一至周五（不含中国法定节假日）9:00-12:00、14:00-18:00 为高峰
//     时段；其余时段，包括周末及中国法定节假日全天均为空闲时段」——与 SCHEDULE
//     和 CALENDAR_RULES 完全一致。
//
// 价格会变。改这里，别改渲染；test/pricing.test.mjs 会验证 offpeak 恒为 peak 的一半。
// ---------------------------------------------------------------------------

/** 官方价格页地址，会随价格一起送到界面的 tooltip 里。 */
export const PRICE_SOURCE = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';
/** 抓取核对日期。 */
export const PRICE_CHECKED_ON = '2026-10-06';
/** 计价单位，仅用于展示。 */
export const PRICE_UNIT = '元/百万 tokens';
/** 未指定模型时展示哪个。 */
export const DEFAULT_PRICE_MODEL = 'deepseek-flash';

/**
 * 各模型两档价格。
 * `cacheHit` = 输入·缓存命中，`cacheMiss` = 输入·缓存未命中，`output` = 输出；
 * 单位均为元/百万 tokens。价格只用于展示，不参与任何余额计算。
 */
export const PRICES = Object.freeze({
  'deepseek-flash': Object.freeze({
    label: 'DeepSeek-V4.1-Flash',
    peak: Object.freeze({ cacheHit: 0.04, cacheMiss: 2, output: 8 }),
    offpeak: Object.freeze({ cacheHit: 0.02, cacheMiss: 1, output: 4 }),
  }),
  'deepseek-v4-pro': Object.freeze({
    label: 'DeepSeek-V4-Pro-0813',
    peak: Object.freeze({ cacheHit: 0.3, cacheMiss: 9, output: 27 }),
    offpeak: Object.freeze({ cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 }),
  }),
});

/**
 * 取某个模型的两档价格表。
 * @param {string} [model] 模型 id；缺省用 DEFAULT_PRICE_MODEL。
 * @returns {{model:string,label:string,currency:string,unit:string,
 *            peak:{cacheHit:number,cacheMiss:number,output:number},
 *            offpeak:{cacheHit:number,cacheMiss:number,output:number},
 *            source:string,checkedOn:string}|null} 未知模型返回 null（界面只显示时段，不显示价格）
 */
export function priceTableFor(model) {
  const key = typeof model === 'string' && model.trim() !== '' ? model.trim() : DEFAULT_PRICE_MODEL;
  const entry = PRICES[key];
  if (entry === undefined) return null;
  return {
    model: key,
    label: entry.label,
    currency: 'CNY',
    unit: PRICE_UNIT,
    peak: { ...entry.peak },
    offpeak: { ...entry.offpeak },
    source: PRICE_SOURCE,
    checkedOn: PRICE_CHECKED_ON,
  };
}
