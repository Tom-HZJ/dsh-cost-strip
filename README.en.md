# dsh-cost-strip

A one-line cost strip for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH): **today's spend plus a 7-day total, right under the composer**, with a 7-day bar chart on hover and click-to-refresh.

**Local-only, read-only, zero network, zero credentials.** No API keys are read, no requests are made — it only parses files DSH already wrote on your machine.

```
Today ¥7.77 · 7d ¥86.90
```

## Install

```bash
dsh plugin --profile desktop add dsh-cost-strip
# other profiles: dsh plugin --profile web add dsh-cost-strip
```

Then **fully quit and reopen DSH** (the host half changed, so the process must restart).

If your desktop profile is exclusively managed by the Electron app and the CLI refuses, add it from the sidebar (Plugins → Add plugin → `dsh-cost-strip`).

## Where the numbers come from

Three sources, all local, in priority order:

1. `~/.dsh/dsh-key-usage/snapshot.json` — if [dsh-key-usage](https://github.com/xyl886/dsh-key-usage) is installed, reuse its aggregate (official price list × session tokens; measured within 1% of the account's `platform.deepseek.com` bill). **Identical numbers to that panel.**
2. `~/.dsh/sessions/**/session*.jsonl.zstd` — parse session logs (multi-frame zstd) and price them with, in order: `~/.dsh/dsh-cost-strip/prices.json` → a least-squares fit of `input / cacheRead / output` prices derived from `~/.dsh/dsh-usage/usage-ledger.json` (needs ≥3 days, rejects a fit worse than 25%) → nothing.
3. Nothing available — show tokens only and explain why in the hover panel.

## Calibration

```bash
node tools/calibrate-prices.mjs          # preview
node tools/calibrate-prices.mjs --write  # write ~/.dsh/dsh-cost-strip/prices.json
```

For strict peak/off-peak pricing (Beijing time, weekdays 09:00–12:00 and 14:00–18:00 are peak) write `prices.json` yourself with a `peakRule` — see the Chinese README for the exact shape. The fitted prices are flat averages (peak/off-peak, models and discounts all blended).

## Known limitations

- Holiday table is not bundled: list your own holidays in `peakRule.holidays`, otherwise holidays are priced as peak.
- Session log format may change with DSH upgrades: the parser assumes `assistant/message` events with `data.usage.{inputTokens,cacheReadTokens,outputTokens}`, file name `session.v4.jsonl.zstd`, and multi-frame zstd. Run `npm test` after upgrading DSH.
- Frames are split on the `28 B5 2F FD` magic; a coincidental occurrence inside compressed data would split one frame (that frame is skipped). Not observed across 86 real session files.
- No "official account-wide" billing mode (that needs a platform token and belongs to dsh-key-usage / the official site). This plugin deliberately touches no credentials.

## Design notes (traps worth knowing)

1. Session files are named `session.v4.jsonl.zstd` (plus historical v3 / unversioned names). Matching only `session.jsonl.zstd` finds **nothing, silently**.
2. Session logs are **multi-frame** zstd: one file holds hundreds of frames, each starting with `28 B5 2F FD`. Split before `zstdDecompressSync`; do not shell out to a `zstd` binary (usually absent on Windows).
3. Usage events look like `{ type:"assistant/message", data:{ turn, step, usage, message } }` — usage lives at `data.usage`.
4. The status strip under the composer is the **list** slot `conversation.composer.dock`; `conversation.composer.bar` is the composer body itself (a single slot already registered by core) and will conflict.
5. **Do not pin old `@deepseek-ai/dsh-client-*` peer versions**: DSH's installer guard rejects a plugin whose peers target `^0.1.0-rc.x` when the host is `0.2.x`. This plugin only declares `@deepseek-ai/cordis`.

## Development

```bash
npm test   # 26 offline assertions: multi-frame zstd, GMT+8 day buckets, ledger fit, peak rules, cost math, snapshot priority
```

Tests need neither DSH nor network (they build their own session logs and ledger under a temporary `DSH_HOME`).

## License

[MIT](./LICENSE)
