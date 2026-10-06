# Changelog

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
