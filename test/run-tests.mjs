// 离线测试：不需要 DSH，也不需要网络。
// 用法：node test/run-tests.mjs
//
// 覆盖：多帧 zstd 解析、GMT+8 分日、账本反解单价、峰谷判定、快照优先、成本聚合。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { pathToFileURL } from "node:url";

const root = mkdtempSync(join(tmpdir(), "dsh-cost-strip-test-"));
process.env.DSH_HOME = root;

let passed = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) {
    passed++;
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------- 造数据
function frame(lines) {
  return zstdCompressSync(Buffer.from(`${lines.join("\n")}\n`, "utf8"));
}
function sampleEvent(ms, input, cacheRead, output) {
  return JSON.stringify({
    type: "assistant/message",
    time: ms,
    data: { turn: 1, step: 1, message: { role: "assistant", source: { kind: "model", model: "deepseek-flash" } }, usage: { inputTokens: input, cacheReadTokens: cacheRead, outputTokens: output, reasoningTokens: 0 } }
  });
}
const DAY = 86400 * 1000;
// 用「北京时间中午」的事件，避免跨日边界干扰
const todayMs = Date.now();
const todayNoon = Math.floor((todayMs + 8 * 3600 * 1000) / DAY) * DAY + 4 * 3600 * 1000 - 8 * 3600 * 1000;
const y1 = todayNoon - DAY;
const y2 = todayNoon - 2 * DAY;

const ws = join(root, "sessions", "--workspace--", "session-abc");
mkdirSync(ws, { recursive: true });
// 两个帧：第一帧 2 条事件，第二帧 1 条（多帧解析的要点）
const f1 = frame([sampleEvent(todayNoon, 1000, 2000000, 500), sampleEvent(y1, 2000, 1000000, 700)]);
const f2 = frame([sampleEvent(y2, 3000, 3000000, 900)]);
writeFileSync(join(ws, "session.v4.jsonl.zstd"), Buffer.concat([f1, f2]));
// 顺带放一个「历史命名」，确认也能扫到
const wsOld = join(root, "sessions", "--workspace2--", "session-old");
mkdirSync(wsOld, { recursive: true });
writeFileSync(join(wsOld, "session.jsonl.zstd"), frame([sampleEvent(todayNoon, 400, 0, 100)]));

// 账本：用已知单价造 4 天，验证反解能还原。
// 注意各列必须**线性无关**：如果 input 与 cacheRead 每天都同比放大，设计矩阵退化，
// 反解会（正确地）拒绝——所以这里故意让三列的每日形状各不相同。
const PRICE = { input: 2.0, cacheRead: 0.05, output: 8.0 };
const SHAPE = [
  [1.0, 1.0, 1.0],
  [2.0, 0.6, 3.0],
  [0.5, 2.4, 0.4],
  [1.7, 0.9, 2.2]
];
const days = {};
for (let i = 0; i < SHAPE.length; i++) {
  const [fi, fc, fo] = SHAPE[i];
  const input = 1e6 * fi;
  const cacheRead = 1e8 * fc;
  const output = 1e5 * fo;
  const cost = (input / 1e6) * PRICE.input + (cacheRead / 1e6) * PRICE.cacheRead + (output / 1e6) * PRICE.output;
  days[`2026-10-0${i + 1}`] = { "deepseek-official": { "deepseek-flash": { inputTokens: input, cacheReadTokens: cacheRead, outputTokens: output, cost } } };
}
mkdirSync(join(root, "dsh-usage"), { recursive: true });
writeFileSync(join(root, "dsh-usage", "usage-ledger.json"), JSON.stringify({ version: 1, days }));

// ---------------------------------------------------------------- 跑断言
const mod = await import(pathToFileURL(join(import.meta.dirname, "..", "lib", "index.js")).href);
const t = mod.__test__;

// 1) GMT+8 分日
check("GMT+8 分日：15:59:59Z 仍算当天", t.localDateOf(Date.parse("2026-10-16T15:59:59Z")) === "2026-10-16", t.localDateOf(Date.parse("2026-10-16T15:59:59Z")));
check("GMT+8 分日：16:00:00Z 进次日", t.localDateOf(Date.parse("2026-10-16T16:00:00Z")) === "2026-10-17", t.localDateOf(Date.parse("2026-10-16T16:00:00Z")));

// 2) 近 7 天窗口升序且含今天
const recent = t.recentDates(7);
check("近 7 天窗口长度", recent.length === 7, String(recent.length));
check("近 7 天窗口末位是今天", recent[6] === t.localDateOf(Date.now()), recent[6]);
check("近 7 天窗口升序", recent.every((d, i) => i === 0 || recent[i - 1] < d));

// 3) 多帧 zstd 解析（含历史命名）
const files = t.scanSessionLogs();
const scanRowToday = files.byDate.get(t.localDateOf(todayNoon));
check("多帧 zstd：今天两帧都读到了（1000+400 输入）", scanRowToday && scanRowToday.input === 1400, scanRowToday ? String(scanRowToday.input) : "无");
check("多帧 zstd：调用数 2", scanRowToday && scanRowToday.calls === 2, scanRowToday ? String(scanRowToday.calls) : "无");
check("跨天分桶：昨天 1 条", files.byDate.get(t.localDateOf(y1))?.calls === 1);
check("跨天分桶：前天 1 条", files.byDate.get(t.localDateOf(y2))?.calls === 1);

// 4) 账本反解
const fit = t.fitPricesFromLedger();
check("账本反解成功", !!fit && fit.kind === "fitted", fit ? fit.kind : "null");
if (fit) {
  check("反解 input 还原", Math.abs(fit.prices.input - PRICE.input) < 1e-6, String(fit.prices.input));
  check("反解 cacheRead 还原", Math.abs(fit.prices.cacheRead - PRICE.cacheRead) < 1e-6, String(fit.prices.cacheRead));
  check("反解 output 还原", Math.abs(fit.prices.output - PRICE.output) < 1e-6, String(fit.prices.output));
}

// 5) 峰谷判定（北京时间：工作日 09-12 / 14-18 为峰）
const monday10 = Date.parse("2026-10-19T02:00:00Z"); // 周一 10:00 北京
const monday20 = Date.parse("2026-10-19T12:00:00Z"); // 周一 20:00 北京
const saturday10 = Date.parse("2026-10-17T02:00:00Z"); // 周六 10:00 北京
const rule = { windows: [[9, 12], [14, 18]], weekdaysOnly: true, offPeakFactor: 0.5, holidays: ["2026-10-20"] };
check("峰：周一 10:00", t.isPeak(monday10, rule) === true);
check("谷：周一 20:00", t.isPeak(monday20, rule) === false);
check("谷：周六 10:00", t.isPeak(saturday10, rule) === false);
check("谷：节假日表里的周二 10:00", t.isPeak(Date.parse("2026-10-20T02:00:00Z"), rule) === false);
check("无 peakRule 时一律半价口径（isPeak=false）", t.isPeak(monday10, null) === false);

// 6) 成本聚合（显式峰谷）
const row = { input: 1e6, cacheRead: 0, output: 0, peakInput: 1e6, peakCacheRead: 0, peakOutput: 0, offInput: 0, offCacheRead: 0, offOutput: 0 };
const priced = t.costOfRow(row, { prices: { input: 2, cacheRead: 0, output: 0 }, peakRule: rule });
check("峰价：1M 输入 × ¥2 = ¥2", Math.abs(priced - 2) < 1e-9, String(priced));
const rowOff = { input: 1e6, cacheRead: 0, output: 0, peakInput: 0, peakCacheRead: 0, peakOutput: 0, offInput: 1e6, offCacheRead: 0, offOutput: 0 };
const pricedOff = t.costOfRow(rowOff, { prices: { input: 2, cacheRead: 0, output: 0 }, peakRule: rule });
check("谷价：1M 输入 × ¥2 × 0.5 = ¥1", Math.abs(pricedOff - 1) < 1e-9, String(pricedOff));

// 7) 没有快照时走会话日志 + 反解单价
const noSnap = t.build();
check("无快照 → source=session-log", noSnap.source === "session-log", noSnap.source);
check("无快照 → priceSource=fitted", noSnap.priceSource === "fitted", String(noSnap.priceSource));
check("今日成本 > 0", Number.isFinite(noSnap.today.cost) && noSnap.today.cost > 0, String(noSnap.today.cost));

// 8) 有快照时优先用快照（数字与侧边栏面板同源）
mkdirSync(join(root, "dsh-key-usage"), { recursive: true });
writeFileSync(
  join(root, "dsh-key-usage", "snapshot.json"),
  JSON.stringify({ version: 1, updatedAt: "2026-10-16T07:20:35.047Z", sections: { usage: { days: [{ date: t.localDateOf(Date.now()), calls: 172, inputTokens: 1235692, outputTokens: 230344, cacheReadTokens: 86439552, reasoningTokens: 0, cost: 7.77 }] } } })
);
const withSnap = t.build();
check("有快照 → source=dsh-key-usage", withSnap.source === "dsh-key-usage", withSnap.source);
check("有快照 → 今日成本取快照值 7.77", Math.abs(withSnap.today.cost - 7.77) < 1e-9, String(withSnap.today.cost));
check("有快照 → 近 7 天补零为 7 项", withSnap.days.length === 7, String(withSnap.days.length));

rmSync(root, { recursive: true, force: true });

// ---------------------------------------------------------------- 汇总
console.log(`  通过 ${passed} 项`);
if (failures.length) {
  console.log(`  失败 ${failures.length} 项：`);
  for (const f of failures) console.log(`    ✗ ${f}`);
  process.exit(1);
}
console.log("  全部通过 ✓");
