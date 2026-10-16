// dsh-cost-strip — 宿主半边
//
// 职责：算「今日消费 / 近 7 天消费」，通过一个只读路由给界面读。
// 原则：纯本地、零联网、零凭据。
//
// 数据来源（按优先级）：
//   1) 装了 dsh-key-usage（侧边栏「使用情况」）→ 复用它的快照
//      $DSH_HOME/dsh-key-usage/snapshot.json（官方价目 × 会话 token；
//      在某账号上实测与 platform.deepseek.com 账单差 <1%）
//   2) 自己扫会话日志 → 单价按 prices.json → 官方账本反解 → 无价目则只报 token
//   3) 都没有 → 只报 token，并在界面注明原因
//
// 设计要点（踩过的坑，写在这里省得别人再踩）：
//   · DSH 0.2.x 的会话文件名是 session.v4.jsonl.zstd（只认 session.jsonl.zstd 的实现会一个文件都扫不到）
//   · 会话日志是**多帧拼接** zstd：按魔数 28 B5 2F FD 切帧，逐帧 zstdDecompressSync
//     （不要依赖外部 zstd 可执行文件：多数 Windows 机器没有，且失败是静默的）
//   · 用量事件形状是 { type:"assistant/message", data:{ turn, step, usage, message } }
//   · 客户端槽位用 conversation.composer.dock（输入框下方的 list 槽）；
//     conversation.composer.bar 是输入框本体（single 槽，核心已注册，注册会冲突）
//   · peerDependencies 不要钉 @deepseek-ai/dsh-client-* 的旧版本，否则过不了 DSH 的兼容护栏
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { zstdDecompressSync } from "node:zlib";

const name = "dsh-cost-strip";
// 只依赖 webServer：注册一个只读路由。不碰 credentials（本插件零凭据）。
const inject = ["webServer"];

const ROUTE = "/dsh-cost-strip/data.json";
const WINDOW_DAYS = 7;
const REFRESH_MS = 30_000;
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const SESSIONS_ROOT = join(DSH_HOME, "sessions");
const KEY_USAGE_SNAPSHOT = join(DSH_HOME, "dsh-key-usage", "snapshot.json");
const LEDGER_FILE = join(DSH_HOME, "dsh-usage", "usage-ledger.json");
const CONFIG_DIR = join(DSH_HOME, "dsh-cost-strip");
const PRICES_FILE = join(CONFIG_DIR, "prices.json");

// ---------------------------------------------------------------- 工具

/** 毫秒时间戳 → GMT+8 的 YYYY-MM-DD（与 DSH 平台口径一致）。 */
function localDateOf(ms) {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 今天（GMT+8）。 */
function today() {
  return localDateOf(Date.now());
}

/** 最近 n 天（含今天）的日期数组，升序。 */
function recentDates(n) {
  const out = [];
  const base = Date.now();
  for (let i = n - 1; i >= 0; i--) out.push(localDateOf(base - i * 86400 * 1000));
  return out;
}

function toFinite(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

function num(v) {
  const n = toFinite(v);
  return Number.isFinite(n) ? n : 0;
}

// ------------------------------------------------- 来源 1：dsh-key-usage 快照

/**
 * 读 dsh-key-usage 的聚合快照。
 * 结构：{ sections: { usage: { days: [ { date, calls, inputTokens, outputTokens,
 *          cacheReadTokens, reasoningTokens, cost, costSource } ] } } }
 */
function readKeyUsageSnapshot() {
  try {
    const snap = JSON.parse(readFileSync(KEY_USAGE_SNAPSHOT, "utf8"));
    const raw = snap && snap.sections && snap.sections.usage && snap.sections.usage.days;
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const rows = [];
    for (const d of raw) {
      if (!d || typeof d.date !== "string") continue;
      rows.push({
        date: d.date,
        calls: num(d.calls),
        tokens: num(d.inputTokens) + num(d.outputTokens) + num(d.cacheReadTokens) + num(d.reasoningTokens),
        cost: Number.isFinite(toFinite(d.cost)) ? toFinite(d.cost) : null
      });
    }
    if (!rows.length) return null;
    rows.sort((a, b) => (a.date < b.date ? -1 : 1));
    return { rows, updatedAt: typeof snap.updatedAt === "string" ? snap.updatedAt : null };
  } catch {
    return null;
  }
}

// ------------------------------------------------- 来源 2：自己扫会话日志

/** DSH 0.2.x 的会话日志：session.jsonl.zstd / session.v3.jsonl.zstd / session.v4.jsonl.zstd */
function sessionFiles() {
  try {
    return readdirSync(SESSIONS_ROOT, { recursive: true })
      .filter((p) => typeof p === "string" && /session(\.v\d+)?\.jsonl\.zstd$/.test(p))
      .map((p) => join(SESSIONS_ROOT, p));
  } catch {
    return [];
  }
}

/** 逐行回调：把文件按 zstd 帧切开、逐帧解压（坏帧/半帧跳过，下次文件增长会重读）。 */
function forEachLogLine(file, onLine) {
  let buf;
  try {
    buf = readFileSync(file);
  } catch {
    return false;
  }
  let start = buf.indexOf(ZSTD_MAGIC, 0);
  if (start === -1) return false;
  while (start !== -1) {
    const next = buf.indexOf(ZSTD_MAGIC, start + 4);
    const end = next === -1 ? buf.length : next;
    let text = "";
    try {
      text = zstdDecompressSync(buf.subarray(start, end)).toString("utf8");
    } catch {
      // 半帧 / 坏帧：跳过
    }
    if (text) {
      for (const line of text.split("\n")) if (line) onLine(line);
    }
    start = next;
  }
  return true;
}

/**
 * 扫全部会话日志，按天累计 token 与调用数。
 * 只认 assistant/message 事件里的 data.usage（DSH 0.2.x 形状）。
 * 同时把每条事件的**时间**记录下来，供峰谷计价使用（顶点/谷点分开累计）。
 */
function scanSessionLogs() {
  const byDate = new Map();
  const bucket = (date) => {
    let row = byDate.get(date);
    if (!row) {
      row = { date, calls: 0, tokens: 0, input: 0, cacheRead: 0, output: 0, reasoning: 0, peakInput: 0, peakCacheRead: 0, peakOutput: 0, offInput: 0, offCacheRead: 0, offOutput: 0 };
      byDate.set(date, row);
    }
    return row;
  };
  for (const file of sessionFiles()) {
    forEachLogLine(file, (line) => {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (!ev || ev.type !== "assistant/message") return;
      const d = ev.data;
      const u = d && d.usage;
      if (!u || typeof u.inputTokens !== "number") return;
      const time = typeof ev.time === "number" ? ev.time : Date.now();
      const row = bucket(localDateOf(time));
      const input = num(u.inputTokens);
      const cacheRead = num(u.cacheReadTokens);
      const output = num(u.outputTokens);
      row.calls += 1;
      row.tokens += input + cacheRead + output + num(u.reasoningTokens);
      row.input += input;
      row.cacheRead += cacheRead;
      row.output += output;
      row.reasoning += num(u.reasoningTokens);
      return row;
    });
  }
  return { byDate };
}

// ------------------------------------------------------------------ 计价

/**
 * 解析单价。优先级：
 *   1. $DSH_HOME/dsh-cost-strip/prices.json（用户显式给出，可用 tools/calibrate-prices.mjs 生成）
 *   2. 官方账本 ~/.dsh/dsh-usage/usage-ledger.json 三参数最小二乘反解（≥3 天有账单才可信）
 *   3. 无 → 只报 token
 * 价格单位：元 / 百万 token。可选的 peakRule 支持峰谷（北京时间窗口内为峰价）。
 */
function resolvePrices() {
  // 1) 显式配置
  try {
    const cfg = JSON.parse(readFileSync(PRICES_FILE, "utf8"));
    if (Number.isFinite(toFinite(cfg.input)) && Number.isFinite(toFinite(cfg.cacheRead)) && Number.isFinite(toFinite(cfg.output))) {
      return {
        kind: "config",
        currency: typeof cfg.currency === "string" ? cfg.currency : "CNY",
        prices: { input: toFinite(cfg.input), cacheRead: toFinite(cfg.cacheRead), output: toFinite(cfg.output) },
        peakRule: cfg.peakRule ?? null,
        note: "单价来自 prices.json"
      };
    }
  } catch {
    // 没配置，往下走
  }
  // 2) 用官方账本反解
  const fit = fitPricesFromLedger();
  if (fit) return fit;
  return { kind: "none", currency: null, prices: null, peakRule: null, note: "没有价目来源；只报 token" };
}

/** 官方账本 → 三参数最小二乘（input / cacheRead / output 单价）。 */
function fitPricesFromLedger() {
  let ledger;
  try {
    ledger = JSON.parse(readFileSync(LEDGER_FILE, "utf8"));
  } catch {
    return null;
  }
  const A = [];
  const y = [];
  for (const provs of Object.values(ledger.days || {})) {
    let i = 0;
    let c = 0;
    let o = 0;
    let cost = 0;
    for (const p of Object.values(provs || {})) {
      for (const m of Object.values(p || {})) {
        i += num(m.inputTokens);
        c += num(m.cacheReadTokens);
        o += num(m.outputTokens);
        cost += num(m.cost);
      }
    }
    if (cost > 0 && i + c + o > 0) {
      A.push([i / 1e6, c / 1e6, o / 1e6]);
      y.push(cost);
    }
  }
  if (A.length < 3) return null;
  const M = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ];
  const v = [0, 0, 0];
  for (let r = 0; r < A.length; r++) {
    for (let p = 0; p < 3; p++) {
      v[p] += A[r][p] * y[r];
      for (let q = 0; q < 3; q++) M[p][q] += A[r][p] * A[r][q];
    }
  }
  const det =
    M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) -
    M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) +
    M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return null;
  const inv = [
    [(M[1][1] * M[2][2] - M[1][2] * M[2][1]) / det, (M[0][2] * M[2][1] - M[0][1] * M[2][2]) / det, (M[0][1] * M[1][2] - M[0][2] * M[1][1]) / det],
    [(M[1][2] * M[2][0] - M[1][0] * M[2][2]) / det, (M[0][0] * M[2][2] - M[0][2] * M[2][0]) / det, (M[0][2] * M[1][0] - M[0][0] * M[1][2]) / det],
    [(M[1][0] * M[2][1] - M[1][1] * M[2][0]) / det, (M[0][1] * M[2][0] - M[0][0] * M[2][1]) / det, (M[0][0] * M[1][1] - M[0][1] * M[1][0]) / det]
  ];
  const p = [0, 1, 2].map((r) => inv[r][0] * v[0] + inv[r][1] * v[1] + inv[r][2] * v[2]);
  // 反解出来的单价必须为正，且拟合总价与官方总价不能差太多（否则不采信）
  if (!p.every((x) => Number.isFinite(x) && x >= 0)) return null;
  let pred = 0;
  let actual = 0;
  for (let r = 0; r < A.length; r++) {
    pred += A[r][0] * p[0] + A[r][1] * p[1] + A[r][2] * p[2];
    actual += y[r];
  }
  if (actual <= 0) return null;
  const relErr = Math.abs(pred - actual) / actual;
  if (relErr > 0.25) return null;
  return {
    kind: "fitted",
    currency: "CNY",
    prices: { input: p[0], cacheRead: p[1], output: p[2] },
    peakRule: null,
    note: `单价由官方账本反解（${A.length} 天，拟合偏差 ${(relErr * 100).toFixed(1)}%）`,
    residualRel: relErr,
    days: A.length
  };
}

/** 北京时间的小时（0-23）与星期（0=周日）。 */
function beijingParts(ms) {
  const t = new Date(ms + 8 * 3600 * 1000);
  return { hour: t.getUTCHours(), weekday: t.getUTCDay(), date: t.toISOString().slice(0, 10) };
}

/** 是否处于峰价时段（默认：工作日 09:00-12:00 与 14:00-18:00，北京时间）。 */
function isPeak(ms, rule) {
  if (!rule) return false;
  const holidays = Array.isArray(rule.holidays) ? rule.holidays : [];
  const { hour, weekday, date } = beijingParts(ms);
  if (holidays.includes(date)) return false;
  if (rule.weekdaysOnly !== false && (weekday === 0 || weekday === 6)) return false;
  const windows = Array.isArray(rule.windows) ? rule.windows : [[9, 12], [14, 18]];
  for (const [from, to] of windows) {
    if (Number.isFinite(from) && Number.isFinite(to) && hour >= from && hour < to) return true;
  }
  return false;
}

/** 给一天算钱：优先用峰谷分别累计，没有 peakRule 时用统一单价。 */
function costOfRow(row, price) {
  if (!price.prices) return null;
  const { input, cacheRead, output } = price.prices;
  if (!price.peakRule) {
    return (row.input / 1e6) * input + (row.cacheRead / 1e6) * cacheRead + (row.output / 1e6) * output;
  }
  const factor = Number.isFinite(toFinite(price.peakRule.offPeakFactor)) ? toFinite(price.peakRule.offPeakFactor) : 0.5;
  const peak = (row.peakInput / 1e6) * input + (row.peakCacheRead / 1e6) * cacheRead + (row.peakOutput / 1e6) * output;
  const off = ((row.offInput / 1e6) * input + (row.offCacheRead / 1e6) * cacheRead + (row.offOutput / 1e6) * output) * factor;
  return peak + off;
}

// ------------------------------------------------------------------ 组装

let cache = { at: 0, data: null };

function build() {
  const notes = [];
  const dates = recentDates(WINDOW_DAYS);

  // 1) 先试 dsh-key-usage 快照（数字与侧边栏面板同源）
  const snap = readKeyUsageSnapshot();
  if (snap) {
    const map = new Map(snap.rows.map((r) => [r.date, r]));
    const days = dates.map((date) => {
      const r = map.get(date);
      return r ? { date, cost: r.cost, tokens: r.tokens, calls: r.calls } : { date, cost: 0, tokens: 0, calls: 0 };
    });
    const t = map.get(today());
    return {
      ok: true,
      updatedAt: new Date().toISOString(),
      source: "dsh-key-usage",
      sourceNote: "来自 dsh-key-usage 的官方价目快照（与侧边栏「使用情况」一致）",
      currency: "CNY",
      today: t ? { date: t.date, cost: t.cost, tokens: t.tokens, calls: t.calls } : { date: today(), cost: 0, tokens: 0, calls: 0 },
      days,
      total: days.reduce((s, d) => s + (Number.isFinite(d.cost) ? d.cost : 0), 0),
      notes
    };
  }

  // 2) 自己扫会话日志
  const { byDate } = scanSessionLogs();
  const price = resolvePrices();
  const days = dates.map((date) => {
    const row = byDate.get(date);
    if (!row) return { date, cost: price.prices ? 0 : null, tokens: 0, calls: 0 };
    return { date, cost: costOfRow(row, price), tokens: row.tokens, calls: row.calls };
  });
  const tRow = byDate.get(today());
  notes.push(price.note);
  if (price.kind === "none") notes.push("未找到价目来源：装 dsh-key-usage，或运行 npm run calibrate 生成单价，或手写 prices.json");
  if (price.kind === "fitted") notes.push("反解单价是「平均价」，未区分峰谷");

  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    source: "session-log",
    sourceNote: "来自本机会话日志（DSH 0.2.x，多帧 zstd）",
    currency: price.currency,
    priceSource: price.kind,
    today: tRow
      ? { date: tRow.date, cost: costOfRow(tRow, price), tokens: tRow.tokens, calls: tRow.calls }
      : { date: today(), cost: price.prices ? 0 : null, tokens: 0, calls: 0 },
    days,
    total: days.reduce((s, d) => s + (Number.isFinite(d.cost) ? d.cost : 0), 0),
    notes
  };
}

function snapshot(force) {
  if (!force && cache.data && Date.now() - cache.at < REFRESH_MS) return cache.data;
  const data = build();
  cache = { at: Date.now(), data };
  return data;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: ROUTE,
        handler: (req, res) => {
          try {
            const force = typeof req.url === "string" && req.url.includes("refresh=1");
            res.writeHead(200, JSON_HEADERS);
            res.end(JSON.stringify(snapshot(force)));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            ctx.logger?.warn?.(`${name}: 统计失败：${message}`);
            res.writeHead(500, JSON_HEADERS);
            res.end(JSON.stringify({ ok: false, error: message }));
          }
        }
      }),
    `${name}: data route`
  );
  ctx.logger?.info?.(`${name}: 已挂载 ${ROUTE}`);
}

export { name, inject, apply };
// 供离线测试使用（DSH 运行时不会读这些额外导出）
export const __test__ = { localDateOf, recentDates, forEachLogLine, scanSessionLogs, fitPricesFromLedger, isPeak, costOfRow, resolvePrices, build, ZSTD_MAGIC, SESSIONS_ROOT, PRICES_FILE, LEDGER_FILE, KEY_USAGE_SNAPSHOT };
