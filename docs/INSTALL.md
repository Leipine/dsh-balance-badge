# Installing dsh-balance-badge

The plugin is a plain ESM package with **no dependencies and no build step**. "Installing" it means three things, and every route below does exactly these:

1. register the package in a DSH **profile** (`~/.dsh/profiles/<name>/package.json`, or `%USERPROFILE%\.dsh\profiles\<name>\package.json`),
2. make the package resolvable from that profile's `node_modules`,
3. mount the bundle row from `cordis.patch.yml`.

Nothing is installed globally, and nothing outside the profile is touched.

## Prerequisites

| | |
|---|---|
| DSH | The desktop app (Orb), or `dsh web`. Profiles are created by DSH itself, so start it once before installing. |
| Node | 20 or newer, for the CLI steps below. The plugin itself runs inside DSH's own runtime. |
| DeepSeek API key | Stored in DSH (the Models settings page writes it), or exported as `DEEPSEEK_API_KEY`. Without one the chip shows "余额不可用" and the reason on hover. |

## macOS

```bash
git clone https://github.com/<owner>/dsh-balance-badge.git ~/dsh-plugins/dsh-balance-badge
```

**Route A — DSH's own plugin manager (recommended).** In the app: **Plugins → add plugin**, then give it the absolute path:

```
/Users/<you>/dsh-plugins/dsh-balance-badge
```

**Route B — the bundled installer.** Use this when the build has no plugin manager, or when it refuses to manage a profile the desktop app owns:

```bash
node ~/dsh-plugins/dsh-balance-badge/scripts/install.mjs --dry-run   # print the plan
node ~/dsh-plugins/dsh-balance-badge/scripts/install.mjs             # apply it
```

Then restart DSH once and reload the page. To remove it:

```bash
node ~/dsh-plugins/dsh-balance-badge/scripts/install.mjs --uninstall
```

The installer writes a `link:` dependency, so the clone stays the living copy — `git pull` in it is the upgrade path.

## Windows

Identical, with PowerShell:

```powershell
git clone https://github.com/<owner>/dsh-balance-badge.git "$env:USERPROFILE\dsh-plugins\dsh-balance-badge"
node "$env:USERPROFILE\dsh-plugins\dsh-balance-badge\scripts\install.mjs" --dry-run
node "$env:USERPROFILE\dsh-plugins\dsh-balance-badge\scripts\install.mjs"
```

The only difference from macOS is the link type: Windows gets a **directory junction**, macOS and Linux get a **directory symlink**. Neither needs administrator rights, and both are removed with the link alone.

## Linux

As macOS. `dsh web` is the usual host here, so the target profile is often `web`:

```bash
node ./scripts/install.mjs --profile=web
```

## Choosing the profile

`install.mjs` picks, in order: `--profile=<name>`, then `$DSH_PROFILE`, then `desktop`, then `web` — first one that has a `package.json`. It always prints which profile it chose and the absolute path, so a wrong guess is visible before anything is written. Pass `--profile=` to override, or `$DSH_HOME` if DSH lives somewhere other than `~/.dsh`.

## Verify

```bash
curl -s http://127.0.0.1:19387/deepseek-balance/summary | head -c 400
```

A healthy answer contains `"ok":true`, a `balance.primary` entry in CNY, and a `window` with `"scheduleKnown":true`. If the port differs (the app prints the URL it serves), use that one. The route answers **loopback callers only** — anything else gets `403`, by design, because it reports a private balance figure.

Then look at the composer: a chip like

```
● 余额 ¥21.15 · 入¥1 命中¥0.02 出¥4 /M · 低谷 剩 79:29:11
```

appears under the input. Hover it for both tariffs, the granted/topped-up split, the next switch instant and the price source.

## Troubleshooting

**The route answers but the chip never appears.**
The Host half and the browser half install independently: the route is proof the Host half loaded, not that the browser half did. DSH's client-module registry resolves a bundle's client entry through the profile's `node_modules` link, so if the link was created *after* the profile manifest named the bundle, the registry caches that resolution failure and silently drops the client module. `install.mjs` creates the link first for exactly this reason. If you edited the profile by hand in the other order, remove and re-add the bundle (or restart DSH) to force a recomposition. Check with:

```bash
curl -s http://127.0.0.1:19387/plugins/events --max-time 3 | grep -o '"id":"dsh-balance-badge"[^}]*'
```

**I edited the Host half and nothing changed.**
Node caches an ES module by URL for the life of the process, and DSH's loader only re-`import()`s a bundle when its entry name changes — and every module the entry imports is subject to the same URL cache, so a renamed entry can still pull in a stale child. Renaming the **directory** changes every URL at once and is the reliable way to pick up a Host-side edit without restarting DSH; otherwise restart the app. The browser half is re-read from disk on every request, so a page reload is enough there.

**"余额不可用" with a message on hover.**
The Host could not resolve an API key, or the upstream call failed; the exact reason is in the tooltip and in the route's `error` field. Keys are resolved per request, so saving one in DSH takes effect on the next poll without a restart.

**Prices are missing but the window is shown.**
The configured `model` is not in the price table. See the Configuration section of the main README.
