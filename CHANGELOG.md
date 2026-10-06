# Changelog

## 1.1.0 — 2026-10-06

The balance now comes from whichever credential the machine actually has, so a signed-in DeepSeek account is enough on its own.

**Features**

- **Account fallback.** When no API key can answer, the balance is read through DSH's `deepseekAccount` service — the same seam DSH's own account page uses, and the credential a DeepSeek sign-in stores (a credential *record*, not a `refs` entry, which is why the key lookup never saw it). A machine that only ever signed in no longer shows "余额不可用" forever.
- **Key precedence is unchanged.** The stored platform key still answers first and the account is asked only when the key cannot, so an existing key deployment behaves exactly as before. A revoked or unreachable key now degrades to the account instead of pinning the chip to an error.
- **Reported client identity.** The browser half sends its own language, UTC offset, and — when the build carries one — version with every poll; the Host reports that identity to Platform on account reads instead of its process defaults.
- **Diagnostics on the route.** `balance.source` (`account` / `api-key`), `account` (`ready` / `not-needed` / `signed-out` / `absent` / `no-wallet` / `failed (…)` / `error: …`), `clientSource` (`page` / `defaults`) and `impl` say which seam answered, what the account attempt decided, whether the caller reported an identity, and which Host build is running.
- **Tests.** `test/account-fallback.test.mjs` (11 cases) drives the real route handler with a fake Context and a fake `fetch`: offline, no key, no signed-in account, no network. `npm test` is 33 cases now.

**Notes**

- Both credentials stay in the Host process. The account route never exposes the grant to the plugin — the service owns it and attaches it to the Platform request itself.
- The version reported to Platform falls back to a constant: `DSH_CLIENT_VERSION` is inlined into DSH's own client builds, and a third-party client bundle cannot read it. The read is guarded (`typeof`), so a future DSH build that does inline it is picked up with no code change; override with the `accountClientVersion` bundle option.
- Account sign-in needs the desktop renderer's UI. A `dsh web`-only deployment that never signed in still needs an API key — or a `$DSH_HOME` shared with a desktop profile, since the credential file is per-`DSH_HOME`, not per-profile.
- A genuine 401 on the account route makes DSH expire that grant, exactly as its own account pages do; an edge or network failure is reported as `failed (…)` and changes nothing.

## 1.0.0 — 2026-10-06

First public release.

**Features**

- Balance chip under the composer: total plus the granted / topped-up split, read from `GET https://api.deepseek.com/user/balance`.
- Peak / off-peak billing window in Beijing time, with a countdown to the next switch recomputed every second in the browser.
- Per-million-token prices for the window in force — both tariffs, the cache-hit and cache-miss input, and the output price, in the chip's tooltip and the current window's headline figures inline.
- Two models priced out of the box (`deepseek-flash`, `deepseek-v4-pro`); an unknown model degrades to showing the window without prices rather than inventing numbers.
- Cross-platform installer (`scripts/install.mjs`) with `--dry-run`, `--uninstall`, `--profile=` and a manifest backup. Directory junction on Windows, directory symlink on macOS and Linux.
- CI on Linux, macOS and Windows across Node 20 and 22, including a throwaway-profile install that takes the OS-specific link branch for real.

**Notes**

- The DeepSeek API key stays in the Host process. The browser half receives only numbers, and `GET /deepseek-balance/summary` answers loopback callers only (403 otherwise).
- Statutory-holiday dates for 2026 come from press summaries rather than the State Council notice, so `HOLIDAY_TABLE_VERIFIED` is `false` and a holiday tooltip carries that caveat. The rule itself (weekends and statutory holidays bill off-peak all day) is confirmed by the official price page.
- Zero runtime dependencies and no build step.
