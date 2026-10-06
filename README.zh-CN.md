# dsh-balance-badge

在 DSH 输入框下方显示 **DeepSeek 账户余额**、**当前计费时段**（高峰/低谷）、**该时段的每百万 tokens 价格**，以及切换倒计时。

示例：

```
● 余额 ¥21.15 · 入¥1 命中¥0.02 出¥4 /M · 低谷 剩 79:29:11
```

悬停可看到赠送/充值明细、两档完整价格表、下一次切换时刻与价格来源。

## 结构

目录：`C:\Users\LB\.dsh\dsh_orb\dsh-balance-badge`

| 文件 | 作用 |
|---|---|
| `package.json` | bundle 清单：`exports["."] → ./index.js`、`dsh.bundle.patch`、`dsh.client` |
| `cordis.patch.yml` | 把本包插入 profile 的 loader 树（行 id `deepseek-balance`） |
| `index.js` | Host 半：`GET /deepseek-balance/summary` |
| `client.js` | 浏览器半：在 `conversation.composer.dock` 注册徽标 |
| `lib/pricing.js` | 计费时段规则 **+ 价格表**（纯函数，零依赖） |
| `test/pricing.test.mjs` | 15 条时段测试 |
| `test/price-table.test.mjs` | 7 条价格测试（含「低谷恒为高峰的一半」） |
| `docs/PRICING.md` | 时段规则的来源、时区陷阱、已验证与未验证项 |

## 数据

```
浏览器徽标 ──GET /deepseek-balance/summary──▶ Host 半
                                              ├─ credentials 服务解析 DEEPSEEK_API_KEY
                                              ├─ GET https://api.deepseek.com/user/balance
                                              └─ lib/pricing.js：时段判定 + 价格表
```

API Key **始终留在 Host 进程**；页面只拿到余额数字、时段和价格。路由只接受本机回环请求，其余 403。

### 计费时段（官方口径，2026-08-17 生效）

按**北京时间**：周一至周五（不含中国法定节假日）**9:00–12:00、14:00–18:00 为高峰**；
其余时段，**包括周末及中国法定节假日全天，均为低谷**。**低谷价 = 高峰价的一半。**

### 价格（元/百万 tokens，抄自官方价格页 2026-10-06）

| | deepseek-flash | deepseek-v4-pro |
|---|---|---|
| 输入·缓存命中 | 低谷 0.02 / 高峰 0.04 | 0.15 / 0.30 |
| 输入·缓存未命中 | 低谷 1 / 高峰 2 | 4.5 / 9.0 |
| 输出 | 低谷 4 / 高峰 8 | 13.5 / 27.0 |

来源：<https://api-docs.deepseek.com/zh-cn/quick_start/pricing/>（本机 `web_fetch` 被 DNS 拦截，
改用 shell 的 `Invoke-WebRequest` 抓原文核对）。改价格只改 `lib/pricing.js` 的 `PRICES`，
`test/price-table.test.mjs` 会守住「低谷 = 高峰 ÷ 2」这条官方规则。

默认展示 `deepseek-flash`；换模型在 bundle 行的 `config.model` 里指定（如 `deepseek-v4-pro`），
未收录的模型会退化为只显示时段、不显示价格，而不是编一个数字。

### 余额的实时性

**准实时，不是逐秒。** Host 对上游 `GET /user/balance` 的结果缓存 60 秒，页面每 60 秒轮询一次，
所以最坏情况滞后约 2 分钟；倒计时与时段切换是本地每秒计算的。要更灵敏就同时调小
`index.js` 的 `BALANCE_CACHE_MS` 和 `client.js` 的 `POLL_MS`（浏览器半改完刷新页面即可生效）。

## 安装 / 安装状态

跨平台安装脚本：`scripts/install.mjs`（零依赖，Windows 建 junction、macOS/Linux 建目录软链）：

```bash
node scripts/install.mjs --dry-run     # 先看计划，不改任何东西
node scripts/install.mjs               # 执行
node scripts/install.mjs --uninstall   # 撤销
```

它会挑选 profile（优先 `$DSH_PROFILE`，其次 desktop/web，可用 `--profile=` 指定），
往 profile 的 `package.json` 写入 `"dsh-balance-badge": "link:<本目录>"` 并把它追加进
`dsh.profile.bundles`，再在 profile 的 `node_modules` 下建链接。改清单前会先备份。

> 顺序很重要：**先建链接，再写清单**。loader 一旦在清单里看到新 bundle 就会立刻加载，
> 而 DSH 的客户端模块登记表是顺着 `node_modules` 里那个链接去解析包的；反过来写会出现
> 「bundle 已声明但解析不到」的窗口期，登记表会把这次失败记住，**浏览器半从此静默不加载**。

当前已装入 **desktop** profile（`$DSH_PROFILE` 实测为 `desktop`）：

- `profiles\desktop\package.json`：`dependencies["dsh-balance-badge"] = "link:C:/Users/LB/.dsh/dsh_orb/dsh-balance-badge"`，
  `dsh.profile.bundles` 末位追加 `dsh-balance-badge`
- `profiles\desktop\node_modules\dsh-balance-badge` → 指向本目录的链接
- 最初的清单备份为同目录下 `package.json.bak-before-balance-plugin`

## 改代码后如何生效（踩坑记录）

**浏览器半（`client.js`）**：宿主每次请求都重新读文件，**刷新页面即可**。

**Host 半**：Node 的 ESM 缓存按 URL 活满整个进程，而 loader 只在 **entry 名变化** 时会重新
`import()`。实测矩阵：

| 手段 | 结果 |
|---|---|
| 改文件 mtime | 无变化 |
| 同名 bundle 摘掉再加回 | 旧代码（loader 复用命名空间） |
| 只换 entry 名、文件 URL 不变 | 旧代码（Node 按 URL 命中旧模块） |
| 只换文件 URL、entry 名不变 | 旧代码（loader 不重新 import） |
| **entry 名 + 模块 URL 都换** | ✅ 立即生效 |

而且**被 import 的子模块同样受 URL 缓存约束**：曾经出现入口已是新代码、但 `lib/pricing.js`
仍是旧 URL 的旧模块，导致价格表死活不出现。所以一次重命名必须让**整棵依赖树**换 URL ——
**改目录名是最省事的做法**（一次换掉所有文件路径），并同步改 `package.json` 的 `name`、
`cordis.patch.yml` 的 `name`、`client.js` 的 `id`、profile 里的 junction 名与 bundle 名。

## 验证

```powershell
# 1. Host 路由（应含 pricing 段）
Invoke-RestMethod 'http://127.0.0.1:19387/deepseek-balance/summary' | ConvertTo-Json -Depth 6
# 2. 单测
$node = 'C:\Users\LB\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node --test 'C:\Users\LB\.dsh\dsh_orb\dsh-balance-badge\test\pricing.test.mjs' `
              'C:\Users\LB\.dsh\dsh_orb\dsh-balance-badge\test\price-table.test.mjs'
```

已实测：22/22 通过；运行中的路由返回 `pricing.model=deepseek-flash`、
低谷 入1/命中0.02/出4、高峰 入2/命中0.04/出8；客户端模块 `dsh-balance-badge` 在模块图中且 bundle 200。

## 卸载 / 回滚

```bash
node scripts/install.mjs --uninstall
```

或恢复备份：把 profile 目录下的 `package.json.bak-before-balance-plugin` 覆盖回 `package.json`。
两者都会让余额路由与徽标一起消失，不影响账户余额本身。

## 已知简化

- 徽标文案按 `<html lang>` 选中/英，未接入 Client locale 服务。
- 2026 年法定节假日**具体日期未经官方原文复核**（`web_fetch` 被 DNS 拦截，只有搜索摘要），
  模块导出 `HOLIDAY_TABLE_VERIFIED = false`，节假日当天 tooltip 会附带提醒。
  官方口径本身（周末/节假日全天空闲）已由价格页原文确认。
- 价格表默认只收录 `deepseek-flash` 与 `deepseek-v4-pro` 两个模型。
