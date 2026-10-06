# DeepSeek 计费时段（峰谷定价）依据

本文件记录 `lib/pricing.js` 里那张时段表的来源、已验证与未验证的部分，以及踩过的坑。

## 一、当前规则（截至 2026-08）

按**北京时间（Asia/Shanghai, UTC+8）**：

| 时段 | 计费 |
|---|---|
| 周一至周五 09:00–12:00 | 高峰（标准价） |
| 周一至周五 14:00–18:00 | 高峰（标准价） |
| 周一至周五其余时间（含 12:00–14:00 午间、夜间） | 空闲（低谷价） |
| 周六、周日全天 | 空闲（低谷价） |
| 中国法定节假日全天 | 空闲（低谷价） |
| 调休上班的周末 | 空闲（低谷价） |

关键点：**周末与节假日不再区分峰谷，全天按低谷价计费**；这与 2025 年以前
「每天固定一段时间打折」的旧模型完全不同。

与此对照，历史上的每日错峰窗口是 **16:30–00:30 UTC**（= 北京时间次日 00:30–08:30），
该模型已失效。模块里把它保留为 `LEGACY_OFFPEAK_WINDOW`（`active: false`）仅供对照，
判定逻辑不会读取它。

## 二、来源

- DeepSeek 官方价格页：[模型 & 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)
- [DeepSeek 再度宣布调价 周末不再区分峰谷计费（证券时报）](https://www.stcn.com/article/detail/4103775.html)
- [DeepSeek：调休上班的周末、中国法定节假日全天均按空闲时段计费（IT之家）](https://www.ithome.com/1/004/494.htm)
- [DeepSeek API 在周六/周日全为谷时（网易）](https://m.163.com/dy/article/L51AITVR0511BLFD.html)
- 同类 DSH 插件（交叉印证时段口径）：[lijunyu726/dsh-price-phase](https://github.com/lijunyu726/dsh-price-phase)、[overact/dsh-peak-indicator](https://github.com/overact/dsh-peak-indicator)

## 三、时区陷阱（改代码前必读）

规则是按北京时间公布的，但代码里凡是拿「本地时间」去解释它，都必然出错：
同一个 epoch 毫秒，在 UTC、北京、纽约三台机器上 `new Date(ms).getHours()`
会给出三个不同答案。

`lib/pricing.js` 的三条硬约束：

1. 只用 `getUTC*` 系列，绝不用 `getHours()` / `getDay()` 这类依赖本地时区的接口；
2. 需要「北京墙上时钟」时，先把 epoch **整体平移 +480 分钟**，再读 UTC 字段
   （见 `getBeijingParts`）。中国自 1991 年起不实行夏令时，固定偏移是精确的；
3. 所有对外 API 的时刻都由参数传入，模块内部**从不调用 `Date.now()`**，
   因此测试可确定性复现。

测试在 `TZ=Asia/Shanghai` 与 `TZ=America/New_York` 两种环境下结果完全一致，
这是「与宿主时区无关」的实测证据，而不是推断。

### 已修复的回归：窗口边界漏加偏移

`SCHEDULE` 里的窗口边界按 UTC 书写（`60` 表示 01:00 UTC = 北京 09:00），
而判定时比较的是**北京墙上时钟的分钟数**（09:00 = 540）。早期版本只用取模、
漏加了 `+480`，导致高峰窗口整体**提前 8 小时**，实际判成北京时间
01:00–04:00 与 06:00–10:00。`test/pricing.test.mjs` 用
「周一 01:00 必须是空闲、周一 10:00 必须是高峰」两个锚点锁死了这个回归。

## 四、验证状态（重要）

| 项目 | 状态 |
|---|---|
| 工作日两段高峰、周末全天空闲 | ✅ 多来源一致，已编码 |
| 调休上班的周末按空闲计费 | ✅ 有直接报道，已按「周末全天空闲」实现 |
| 2026 年法定节假日**具体日期** | ⚠️ **未复核**：本机 `web_fetch` 被禁用，无法抓取国务院办公厅通知原文，表中的日期来自公开报道与推算 |

因此模块导出 `HOLIDAY_TABLE_VERIFIED = false`。处于该状态时，若当前时刻
正因节假日被判为空闲，`describeWindow().note` 会附上
「节假日表未与国务院办公厅通知逐日核对，请以官方通知为准」。
**请以平台账单为准。**

复核方法：对照[国务院办公厅关于 2026 年部分节假日安排的通知](https://www.gov.cn/zhengce/content/202511/content_7047090.htm)，
把 `HOLIDAY_RANGES_2026` 的日期改正，并把 `HOLIDAY_TABLE_VERIFIED` 置为 `true`。

## 五、如何修正

时段表是数据，不是逻辑：

- 窗口变化 → 改 `SCHEDULE`（含 `startUtcMinutes` / `endUtcMinutes` / `daysOfWeek`）；
- 节假日变化 → 改 `HOLIDAY_RANGES_2026`；
- 调休上班日单独计费 → 目前并**不需要**：调休周末本身就在「周末全天空闲」规则内；
- 官方若取消优惠时段 → 把 `SCHEDULE_META.known` 置为 `false`，或让时段表只剩标准价一项，
  模块会如实降级为 `scheduleKnown: false` 并在 `note` 说明，不会假装有优惠。

改完请运行：

```powershell
$node = 'C:\Users\LB\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node --test 'C:\Users\LB\.dsh\dsh_orb\dsh-balance-plugin\test\pricing.test.mjs'
```
