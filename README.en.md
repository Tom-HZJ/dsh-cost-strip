# dsh-cost-strip

A one-line cost strip for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH): **today's spend plus a 7-day total, right under the composer**, with a 7-day bar chart and per-model breakdown on hover, and click-to-refresh.

**Local-only, read-only, zero network, zero credentials, no cross-plugin file reads.** No API keys are read, no requests are made, and no other plugin's files are scraped — it only reads local session data through the host's read-only interfaces.

```
Today ≈¥13.09 · 7d ≈¥88.76
```

![cost strip](docs/images/strip.png)

Hover for the last 7 days:

![hover panel](docs/images/panel.png)

> Both images are demo renderings with example numbers — no real account data. In the live UI the strip sits in `conversation.composer.dock` (the list slot under the composer), right after the built-in token usage.

## Install

```bash
dsh plugin --profile desktop add dsh-cost-strip
# other profiles: dsh plugin --profile web add dsh-cost-strip
```

Then **fully quit and reopen DSH** (the host half changed, so the process must restart).

If your desktop profile is exclusively managed by the Electron app and the CLI refuses, add it from the sidebar (Plugins → Add plugin → `dsh-cost-strip`).

**Compatibility**: verified live on DSH `0.2.0-rc.2` (Windows desktop) — read-only host route, composer dock slot and hover panel all work. The host requires Node ≥ 22 (built-in zstd and the `sessionPersistence` service).

## Where the numbers come from

**Session data** — two levels, both local:

| Priority | Source | Notes |
|---|---|---|
| 1 | the host's `ctx.sessionPersistence` service | The official read-only seam: `list()` gives each stored session's header / revision / eventCount, `open(id, "read")` then `read(0)` gives the event stream. Storage format, compression layout and version migrations are the host's business — the plugin never touches the files. |
| 2 | `~/.dsh/sessions/**/session*.jsonl.zstd` | When no session service is mounted (older or trimmed-down hosts), it decompresses the logs itself: these are **multi-frame** zstd, split on the `28 B5 2F FD` magic. |

Both paths fold usage the **same way the host's own token projection does** (next section). Only sessions changed inside the 7-day window are read, and folds are cached by a metadata fingerprint **plus a 60-second time gate** — the revision `list()` reports is documented as best-effort, so the gate is not optional.

The service path reconciles three ways, so an active session is never silently dropped mid-write or mid-migration:

- a session the service returns no usage for → the durable log of **that same session** is read as a complement;
- a session missing from the host's list entirely (the host documents that unreadable headers are not discovered) → read from its durable log;
- when a session has several generations on disk (`session.v3` / `session.v4`), **only the newest** is read, so one transcript is never billed twice.

The hover panel shows `会话 x/y · 磁盘补读 n`, so which path served the numbers is visible at a glance.

**Pricing** — also two levels:

| Priority | Source | Notes |
|---|---|---|
| 1 | `~/.dsh/dsh-cost-strip/prices.json` | Your own override: per model, or one flat rate for everything |
| 2 | bundled `data/prices.json` | DeepSeek official CNY list (api-docs.deepseek.com) plus peak/off-peak windows. Ships `deepseek-flash`, `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`, `deepseek-v4-pro` |
| 3 | models not in the table | **Tokens only, no money** — and the hover panel names them (it never borrows another model's price) |

Every amount carries a `≈`: it is a token × price estimate, not your platform bill.

## Usage semantics

The folding rules match the host token projection, which is why the numbers line up with official billing:

1. **Usage samples** ride on three event shapes: `assistant/chunk` (`data.chunk.type === "usage"`), `assistant/message` (`data.usage`) and `assistant/attempt` (`data.stream[].chunk.usage`). Recognising only `assistant/message` misses streaming reports.
2. **Repeated reports for the same `(turn, step)` overwrite** (last one wins), so nothing is billed twice; `llm/retry-started` opens a new attempt slot, and the new attempt **adds** to the old one instead of replacing it.
3. **Model attribution** comes from `data.message.source`, falling back to the most recent `request/header` (`data.header.config`); unattributable samples are recorded as `unknown/unknown` and priced with the default rate, stated as such.
4. **Days are local calendar days** (the host projection's convention), not a hard-coded timezone.
5. Peak/off-peak is decided **per sample's timestamp**: peak is Beijing time Monday–Friday 09:00–12:00 and 14:00–18:00 (excluding Chinese public holidays); everything else, weekends included, is off-peak at half the peak rate.

> Reconciliation (2026-10-16): on this machine the plugin's per-day token totals match the official ledger **exactly**; across the four days with ledger data its cost is within 0.001% on three of them (09-30, 10-01, 10-03). The fourth (10-02) differs because the ledger itself is incomplete there (264 calls in the ledger vs 321 in the session logs).

## Calibration

```bash
# print the effective price table plus a 7-day self-check
node tools/calibrate-prices.mjs

# fit prices from a ledger YOU name (preview); the path is explicit, the tool guesses nothing
node tools/calibrate-prices.mjs --ledger D:\path\to\ledger.json
# then write ~/.dsh/dsh-cost-strip/prices.json
node tools/calibrate-prices.mjs --ledger D:\path\to\ledger.json --write
```

Ledger shape: `{ "days": { "2026-10-01": { "provider": { "model": { inputTokens, cacheReadTokens, outputTokens, cost } } } } }` (≥3 days; a fit worse than 25% is rejected).

Per-model override (recommended; peak windows come from the bundled table):

```jsonc
{
  "models": {
    "deepseek-official/deepseek-flash": { "input": 2, "cacheRead": 0.04, "cacheWrite": 2, "output": 8 }
  },
  "default": { "input": 2, "cacheRead": 0.04, "cacheWrite": 2, "output": 8 },  // optional: used when attribution is missing
  "holidays": ["2026-10-01", "2026-10-02"]                                     // optional: these days bill off-peak
}
```

The older flat shape still works (one rate for every model):

```jsonc
{
  "currency": "CNY",
  "input": 2.0, "cacheRead": 0.5, "output": 8.0,
  "peakRule": { "windows": [[9, 12], [14, 18]], "weekdaysOnly": true, "offPeakFactor": 0.5, "holidays": [] }
}
```

## Known limitations

- Holiday table is not bundled: list your own holidays in `holidays`, otherwise holidays are priced as peak (the error direction is "too expensive").
- The bundled price list goes stale: it was fetched 2026-10-13. After a vendor price change, either wait for a plugin update or write your own `prices.json`.
- The host session service's metadata is best-effort: an actively written session may keep a stale revision while events keep growing, so the plugin re-reads at most once every 60 seconds. When the service's logical view and the durable logs disagree, the three reconciliation rules above decide.
- The fallback parser assumes file names `session(.<vN>)?\.jsonl\.zstd`, multi-frame zstd and the event shapes above. Run `npm test` after upgrading DSH.
- Frames are split on the `28 B5 2F FD` magic; a coincidental occurrence inside compressed data would split one frame (that frame is skipped). Not observed across 86 real session files.
- Fitted prices are flat averages (peak/off-peak, models and discounts all blended); for precision, override per model.
- No "official account-wide" billing mode (that needs a platform token and belongs to [dsh-key-usage](https://github.com/xyl886/dsh-key-usage) / the official site). This plugin deliberately touches no credentials.

## Design notes (traps worth knowing)

1. **Read sessions through the host service, not by decompressing files yourself**: `ctx.get("sessionPersistence")` → `list()` / `open(id,"read")` → `handle.read(0)`. The host owns format migrations and the storage layout; hand-rolled zstd is a fallback, nothing more.
2. **The host keeps a 2-entry memo between `open(id, "read")` and the following `read(0)`**: two concurrent readers overlap the two "find path + read file" waits; a third evicts the earlier session and forces a full re-decompression.
3. Session files are named `session.v4.jsonl.zstd` (plus historical v3 / unversioned names). Matching only `session.jsonl.zstd` finds **nothing, silently**.
4. Session logs are **multi-frame** zstd: one file holds hundreds of frames, each starting with `28 B5 2F FD`. Split before `zstdDecompressSync`; do not shell out to a `zstd` binary (usually absent on Windows).
5. `inheritedEventCount` is a prefix that must **not** be counted as usage (sub-agent sessions carry their parent's history); keep its `request/header` events for model attribution, drop the rest.
6. The status strip under the composer is the **list** slot `conversation.composer.dock`; `conversation.composer.bar` is the composer body itself (a single slot already registered by core) and will conflict.
7. **Do not pin old `@deepseek-ai/dsh-client-*` peer versions**: DSH's installer guard rejects a plugin whose peers target `^0.1.0-rc.x` when the host is `0.2.x`. This plugin only declares `@deepseek-ai/cordis`.

## Development

```bash
npm test   # 85 offline assertions: the three usage event shapes, dedupe and retry slots, local-calendar
           # days, peak windows, multi-frame zstd, a fake sessionPersistence service, the cache time gate,
           # disk complement and generation selection, price-table resolution, cost math and route wiring
```

Tests need neither DSH nor a network: they build their own session logs, a fake `sessionPersistence` and price tables (`DSH_HOME` points at a temp directory).

```
lib/index.js               host: read the session service / fall back to session logs / fold usage / price it / one read-only route
lib/client.js              UI: registers into conversation.composer.dock
data/prices.json           bundled official price table (CNY + peak windows)
tools/calibrate-prices.mjs price-table self-check / fit from an explicit ledger
tools/render-docs-images.mjs re-render the two README screenshots (headless Edge/Chrome)
test/run-tests.mjs         offline tests
```

## Relationship to similar plugins

- [dsh-key-usage](https://github.com/xyl886/dsh-key-usage): the big sidebar "Usage" panel (details, heatmap, projects, sessions, official balance). The two share the same semantics (both fold session data the way the host token projection does, both price it with the official list) but read independently: this plugin does not depend on it and does not need it installed to price anything.
- `dsh-balance-status` / `dsh-session-cost` and friends: also bottom-bar cost displays. This one is written from scratch (no code copied); the differences are "no credentials + bundled official prices + time-of-day pricing + only cost models it can price", while some of them need a platform token or hard-code rates.
- No affiliation with any of the above.

## License

[MIT](./LICENSE)
