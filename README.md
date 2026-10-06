# dsh-balance-badge

A [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) plugin that puts your DeepSeek account balance, the billing window in force right now, and that window's prices under the composer — with a countdown to the next switch.

```
● 余额 ¥21.15 · 入¥1 命中¥0.02 出¥4 /M · 低谷 剩 79:29:11
```

Hover it for the full picture: granted vs. topped-up balance, both tariffs, the next switch instant, and the price source.

<p align="center">
  <em>中文说明见 <a href="./README.zh-CN.md">README.zh-CN.md</a></em>
</p>

## What it shows

- **Balance** — total, plus the granted / topped-up split, read from `GET https://api.deepseek.com/user/balance`.
- **Billing window** — whether you are in the peak or the off-peak tariff right now, and when that changes.
- **The price of that window** — input (cache miss), input (cache hit) and output, in 元 per million tokens, for your model.
- **A live countdown** — recomputed every second in the browser; the balance itself is refreshed every 60 s.

The chip is a decoration in `conversation.composer.dock`, so it sits under the composer and disappears with it.

## Requirements

- A DSH installation with the Web UI (the desktop app, or `dsh web`), on **macOS, Windows or Linux**.
- A DeepSeek API key known to DSH, or exported as `DEEPSEEK_API_KEY`. The plugin resolves it through DSH's own credentials service first, so a key saved in the Models settings page is used without any extra configuration.

## Install

The plugin is a plain ESM package with **no dependencies and no build step**. Clone it anywhere and point DSH at the directory.

> **Per-platform walkthrough (macOS / Windows / Linux) plus troubleshooting: [docs/INSTALL.md](./docs/INSTALL.md).**

### 1. Clone

```bash
git clone https://github.com/<owner>/dsh-balance-badge.git ~/dsh-plugins/dsh-balance-badge
```

### 2a. Install with DSH's plugin manager (recommended)

In the DSH app: **Plugins → add plugin**, and give it the absolute path to the clone:

- macOS / Linux: `/Users/you/dsh-plugins/dsh-balance-badge`
- Windows: `C:\Users\you\dsh-plugins\dsh-balance-badge`

That is the supported path — DSH registers the bundle, links it into the profile and applies the patch.

### 2b. Install with the bundled script (fallback)

If your build has no plugin manager, or the CLI refuses to manage a profile the desktop app owns:

```bash
node ~/dsh-plugins/dsh-balance-badge/scripts/install.mjs --dry-run   # show the plan
node ~/dsh-plugins/dsh-balance-badge/scripts/install.mjs             # do it
```

The script edits the profile manifest (`~/.dsh/profiles/<desktop|web>/package.json`), adds the bundle row and creates the `node_modules` symlink — the same steps the plugin manager performs. It backs the manifest up first, never deletes a real directory, and `--uninstall` reverses it.

### 3. Activate

- **Host half**: restart the DSH app (or the `dsh web` process) the first time. After that, note the caveat under *Development* below.
- **Browser half**: just reload the page.

### Verify

```bash
curl -s http://127.0.0.1:19387/deepseek-balance/summary | head -c 400
```

You want `"ok":true`, a `balance.primary` in CNY, and a `window` with `"scheduleKnown":true`. The route only answers loopback callers; anything else gets a 403.

## Pricing rules

DeepSeek moved to **peak / off-peak pricing** on 2026-08-17. In Beijing time (`UTC+8`):

| Window | When |
|---|---|
| **Peak** (standard) | Monday–Friday, 09:00–12:00 and 14:00–18:00, excluding Chinese statutory holidays |
| **Off-peak** (half price) | everything else — including weekends and statutory holidays **all day** |

The off-peak tariff is exactly **half** the peak tariff. Current list prices, in 元 per million tokens, as published on the [official price page](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/):

| | deepseek-flash | deepseek-v4-pro |
|---|---|---|
| input · cache hit | 0.02 / 0.04 | 0.15 / 0.30 |
| input · cache miss | 1 / 2 | 4.5 / 9.0 |
| output | 4 / 8 | 13.5 / 27.0 |

`off-peak / peak`. A test asserts the halving relationship for every model and field, so a price edit that breaks the published rule fails the suite.

## Configuration

The plugin takes one option, `model`, on its bundle row in the profile's `cordis.patch.yml`:

```yaml
- id: deepseek-balance
  name: dsh-balance-badge
  config:
    model: deepseek-v4-pro
```

Defaults to `deepseek-flash`. An unknown model degrades to showing the window without prices rather than inventing numbers. To make the balance fresher, lower `BALANCE_CACHE_MS` in `index.js` and `POLL_MS` in `client.js` (both 60 s).

## Security

The API key **never leaves the Host process**. The browser half receives only numbers, and the Host route is fenced to loopback callers:

- the key is read per request through DSH's `credentials` service (falling back to `DEEPSEEK_API_KEY`, then `~/.dsh/.credentials.yaml`);
- `GET /deepseek-balance/summary` returns 403 to any non-loopback peer;
- no third-party service is contacted — the only outbound call is to `api.deepseek.com`.

## Development

```bash
npm test             # 22 tests: schedule classification + price table
npm run test:install # drives scripts/install.mjs against a throwaway profile
```

Both suites run on `node:test`; there is nothing to install. The schedule tests assert that classification follows the Beijing wall clock, and they pass under `TZ=Asia/Shanghai` and `TZ=America/New_York` alike.

`test:install` is the one that covers the OS branch: it builds a fake `$DSH_HOME`, installs into it for real, and asserts the `node_modules` entry is a *link* (junction on Windows, symlink elsewhere) rather than a copy, that a reinstall is idempotent, and that `--uninstall` reverses both the manifest edits and the link without ever touching the package itself. CI runs it on Linux, macOS and Windows — the macOS run is what proves the path your Mac takes.

### A caveat worth knowing if you fork this

The Host half is not reloaded by editing files. Node caches an ES module by URL for the life of the process, and DSH's loader only re-`import()`s a bundle when its **entry name** changes — and every module it imports is subject to the same URL cache, so a renamed entry can still pull in a stale child module. Changing the **directory name** changes every URL at once and is the reliable way to pick up a Host-side edit without restarting DSH; otherwise restart the app. The browser half (`client.js`) is re-read from disk on every request, so a page reload is enough there. The full evidence table is in [README.zh-CN.md](./README.zh-CN.md).

## Layout

| Path | Role |
|---|---|
| `index.js` | Host half — registers the HTTP route, resolves the key, reads the balance |
| `client.js` | Browser half — the chip in `conversation.composer.dock` |
| `lib/pricing.js` | Pure schedule classification + the price table (zero dependencies) |
| `cordis.patch.yml` | The loader row that mounts the plugin |
| `test/` | `node:test` suites |
| `docs/INSTALL.md` | Per-platform install and troubleshooting |
| `docs/PRICING.md` | Sourcing and caveats for the schedule data (Chinese) |
| `scripts/install.mjs` | Cross-platform fallback installer |
| `.github/workflows/test.yml` | CI: the suite on Linux, macOS and Windows, Node 20 and 22 |

## License

[MIT](./LICENSE)
