// 离线测试：不需要 DSH，也不需要网络。
// 用法：node test/run-tests.mjs
//
// 覆盖：本地日历分日、峰谷窗口判定、三种用量事件形状的折叠与去重、
//       多帧 zstd 读取、宿主会话服务（假实现）读取与 revision 缓存、
//       价目解析（随包 / 按模型覆盖 / 旧格式整表）、成本聚合与来源标注。
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
  if (condition) passed++;
  else failures.push(label + (detail === undefined ? "" : " — " + detail));
}

const mod = await import(pathToFileURL(join(import.meta.dirname, "..", "lib", "index.js")).href);
const t = mod.__test__;

// ---------------------------------------------------------------- 造数据

const DAY = 86400 * 1000;
/** 2026-10-19 是周一。 */
function at(y, m, d, hour, minute) {
  return new Date(y, m, d, hour, minute || 0, 0, 0).getTime();
}
const MON_10AM = at(2026, 9, 19, 10, 0); // 周一 10:00（峰）
const MON_8PM = at(2026, 9, 19, 20, 0);  // 周一 20:00（谷）
const SAT_10AM = at(2026, 9, 17, 10, 0); // 周六 10:00（谷）
const NOW = at(2026, 9, 19, 21, 0);

function usage(input, output, cacheRead, cacheWrite) {
  return { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite || 0, totalTokens: input + output + cacheRead + (cacheWrite || 0) };
}
/** model 可以写 "deepseek-flash"，也可以写全 "moonshotai/kimi-k3"。 */
function msgEvent(time, turn, step, modelId, u) {
  const slash = modelId.indexOf("/");
  const provider = slash === -1 ? "deepseek-official" : modelId.slice(0, slash);
  const model = slash === -1 ? modelId : modelId.slice(slash + 1);
  return { type: "assistant/message", time, data: { turn, step, message: { role: "assistant", source: { kind: "model", provider, model } }, usage: u } };
}
/** 一帧 = 一批事件（对象会被 JSON 化）。 */
function frame(events) {
  const lines = events.map((event) => (typeof event === "string" ? event : JSON.stringify(event)));
  return zstdCompressSync(Buffer.from(lines.join("\n") + "\n", "utf8"));
}

const TABLE = {
  currency: "CNY",
  peakWindows: [{ from: "09:00", to: "12:00", days: [1, 2, 3, 4, 5] }, { from: "14:00", to: "18:00", days: [1, 2, 3, 4, 5] }],
  offPeakFactor: 0.5,
  holidays: [],
  default: { input: 2, cacheRead: 0.04, cacheWrite: 2, output: 8 },
  models: { "deepseek-official/deepseek-flash": { input: 2, cacheRead: 0.04, cacheWrite: 2, output: 8 } }
};

// ---------------------------------------------------------------- 断言

// 1) 本地日历分日
check("本地日历：当天 23:59 仍算当天", t.localDateOf(at(2026, 9, 16, 23, 59)) === "2026-10-16", t.localDateOf(at(2026, 9, 16, 23, 59)));
check("本地日历：次日 00:01 进次日", t.localDateOf(at(2026, 9, 17, 0, 1)) === "2026-10-17", t.localDateOf(at(2026, 9, 17, 0, 1)));
check("本地日历：月日补零", t.localDateOf(at(2026, 0, 5, 12, 0)) === "2026-01-05", t.localDateOf(at(2026, 0, 5, 12, 0)));

const recent = t.recentDates(7, NOW);
check("近 7 天窗口长度", recent.length === 7, String(recent.length));
check("近 7 天窗口末位是当天", recent[6] === "2026-10-19", recent[6]);
check("近 7 天窗口首位是 7 天前", recent[0] === "2026-10-13", recent[0]);
check("近 7 天窗口升序", recent.every((d, i) => i === 0 || recent[i - 1] < d));

// 2) 时间窗口解析与峰谷判定
check('parseClock("09:00")=540', t.parseClock("09:00") === 540, String(t.parseClock("09:00")));
check('parseClock("9:05")=545', t.parseClock("9:05") === 545, String(t.parseClock("9:05")));
check('parseClock("24:00") 归一成 0', t.parseClock("24:00") === 0, String(t.parseClock("24:00")));
check("parseClock 越界返回 null", t.parseClock("25:00") === null && t.parseClock("9:70") === null && t.parseClock("abc") === null);

check("峰：周一 10:00", t.isPeakAt(MON_10AM, TABLE) === true);
check("谷：周一 13:00", t.isPeakAt(at(2026, 9, 19, 13, 0), TABLE) === false);
check("峰：周一 15:00", t.isPeakAt(at(2026, 9, 19, 15, 0), TABLE) === true);
check("谷：周一 20:00", t.isPeakAt(MON_8PM, TABLE) === false);
check("谷：周六 10:00", t.isPeakAt(SAT_10AM, TABLE) === false);
check("谷：节假日表里的周一 10:00", t.isPeakAt(MON_10AM, { ...TABLE, holidays: ["2026-10-19"] }) === false);
check("跨零点窗口 22:00-02:00 能命中 23:00", t.isPeakAt(at(2026, 9, 19, 23, 0), { ...TABLE, peakWindows: [{ from: "22:00", to: "02:00", days: [1] }] }) === true);
check("跨零点窗口 22:00-02:00 不命中 03:00", t.isPeakAt(at(2026, 9, 19, 3, 0), { ...TABLE, peakWindows: [{ from: "22:00", to: "02:00", days: [1] }] }) === false);

// 3) 折叠：三种事件形状
const fold = t.foldSession([
  { type: "request/header", time: MON_10AM, data: { header: { config: { provider: "deepseek-official", model: "deepseek-flash" } } } },
  msgEvent(MON_10AM, 1, 1, "deepseek-flash", usage(1000, 10, 20, 30)),
  { type: "assistant/chunk", time: MON_10AM, data: { turn: 1, step: 2, chunk: { type: "usage", usage: usage(2000, 20, 40, 0) } } },
  { type: "assistant/attempt", time: MON_10AM, data: { turn: 1, step: 3, stream: [{ type: "chunk", chunk: { type: "text" } }, { type: "chunk", chunk: { type: "usage", usage: usage(3000, 30, 60, 0) } }] } },
  { type: "assistant/chunk", time: MON_10AM, data: { turn: 1, step: 4, chunk: { type: "text" } } }
]);
check("折叠：3 个样本（文本 chunk 不算）", fold.length === 3, String(fold.length));
check("折叠：message 形状带 cacheWrite", fold[0].input === 1000 && fold[0].cacheWrite === 30, JSON.stringify(fold[0]));
check("折叠：chunk 形状", fold[1].input === 2000 && fold[1].cacheRead === 40, JSON.stringify(fold[1]));
check("折叠：attempt.stream 形状", fold[2].input === 3000 && fold[2].output === 30, JSON.stringify(fold[2]));

// 4) 折叠：同 (turn, step) 后到覆盖先到
const dedup = t.foldSession([
  msgEvent(MON_10AM, 7, 1, "deepseek-flash", usage(1000, 0, 0, 0)),
  { type: "assistant/chunk", time: MON_10AM, data: { turn: 7, step: 1, chunk: { type: "usage", usage: usage(5000, 50, 0, 0) } } }
]);
check("折叠：同 (turn,step) 只留一条", dedup.length === 1, String(dedup.length));
check("折叠：后到的覆盖先到的", dedup[0].input === 5000, JSON.stringify(dedup[0]));

// 5) 折叠：llm/retry-started 开新槽（累加而不是覆盖）
const retried = t.foldSession([
  msgEvent(MON_10AM, 9, 1, "deepseek-flash", usage(1000, 0, 0, 0)),
  { type: "llm/retry-started", time: MON_10AM, data: { turn: 9, step: 1 } },
  msgEvent(MON_10AM, 9, 1, "deepseek-flash", usage(2000, 0, 0, 0))
]);
check("折叠：重试后两条都在", retried.length === 2, String(retried.length));
check("折叠：重试后合计 3000", retried[0].input + retried[1].input === 3000, String(retried[0].input + retried[1].input));

// 6) 折叠：模型归属与缺失回落
const attributed = t.foldSession([
  { type: "request/header", time: MON_10AM, data: { header: { config: { provider: "deepseek-official", model: "deepseek-flash" } } } },
  { type: "assistant/message", time: MON_10AM, data: { turn: 1, step: 1, usage: usage(1000, 0, 0, 0) } },
  { type: "assistant/message", time: MON_10AM, data: { turn: 1, step: 2, message: { source: { provider: "moonshotai", model: "kimi-k3" } }, usage: usage(1000, 0, 0, 0) } }
]);
check("折叠：无 source 时回落 request/header 的模型", attributed[0].model === "deepseek-official/deepseek-flash", attributed[0].model);
check("折叠：有 source 时用 source 的模型", attributed[1].model === "moonshotai/kimi-k3", attributed[1].model);
check("折叠：完全判不出来落 unknown", t.foldSession([msgEvent(MON_10AM, 1, 1, "", usage(1000, 0, 0, 0))])[0].model === "unknown/unknown");

// 7) 计价：峰谷与未计价模型
const peakBucket = t.aggregate([{ time: MON_10AM, model: "deepseek-official/deepseek-flash", input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }], TABLE).values().next().value;
const offBucket = t.aggregate([{ time: MON_8PM, model: "deepseek-official/deepseek-flash", input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }], TABLE).values().next().value;
check("峰价：1M 输入 = ¥2", Math.abs(t.costOfBucket(peakBucket, TABLE).cost - 2) < 1e-9, String(t.costOfBucket(peakBucket, TABLE).cost));
check("谷价：1M 输入 = ¥1（半价）", Math.abs(t.costOfBucket(offBucket, TABLE).cost - 1) < 1e-9, String(t.costOfBucket(offBucket, TABLE).cost));
check("cacheWrite 按写入档计价", Math.abs(t.costOfBucket(t.aggregate([{ time: MON_10AM, model: "deepseek-official/deepseek-flash", input: 0, output: 0, cacheRead: 0, cacheWrite: 1e6 }], TABLE).values().next().value, TABLE).cost - 2) < 1e-9);
const unknownBucket = t.aggregate([{ time: MON_10AM, model: "moonshotai/kimi-k3", input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }], TABLE).values().next().value;
check("价目表没有的模型不计价", t.costOfBucket(unknownBucket, TABLE).cost === null);
check("未归属模型走 default 价", t.costOfBucket(t.aggregate([{ time: MON_10AM, model: "unknown/unknown", input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }], TABLE).values().next().value, TABLE).cost === 2);

// 8) 多帧 zstd 会话日志（文件回退路径）
/** 真实日志的第一行永远是会话 header（磁盘索引按它认会话 id）。 */
function headerLine(id) {
  return JSON.stringify({ type: "session", version: 4, id, cwd: "D:\\work", isSeeded: false, createdAt: NOW - 10000, delegationDepth: 0 });
}
const ws = join(root, "sessions", "--workspace--", "session-abc");
mkdirSync(ws, { recursive: true });
const f1 = frame([headerLine("session-abc"), msgEvent(MON_10AM, 1, 1, "deepseek-flash", usage(1000, 100, 0, 0))]);
const f2 = frame([msgEvent(MON_8PM, 1, 2, "deepseek-flash", usage(2000, 200, 0, 0))]);
writeFileSync(join(ws, "session.v4.jsonl.zstd"), Buffer.concat([f1, f2]));
const wsOld = join(root, "sessions", "--workspace2--", "session-old");
mkdirSync(wsOld, { recursive: true });
writeFileSync(join(wsOld, "session.jsonl.zstd"), frame([headerLine("session-old"), msgEvent(MON_10AM, 2, 1, "deepseek-flash", usage(400, 40, 0, 0))]));

const fileCache = new Map();
const fromFiles = t.collectFromFiles(NOW, fileCache);
check("文件回退：读到 3 个样本（两帧 + 历史命名各一）", fromFiles.samples.length === 3, String(fromFiles.samples.length));
check("文件回退：多帧都解出来了", fromFiles.samples.reduce((sum, s) => sum + s.input, 0) === 3400, String(fromFiles.samples.reduce((sum, s) => sum + s.input, 0)));
const again = t.collectFromFiles(NOW, fileCache);
check("文件回退：命中 mtime 缓存不重读", again.samples.length === 3 && fileCache.size === 2, String(fileCache.size));
// 这一节的夹具用完即撤：后面的端到端用例要能自己控制磁盘上有什么
rmSync(join(root, "sessions"), { recursive: true, force: true });

// 9) 宿主会话服务（假实现）
function makeFakeSessions(entries) {
  const store = new Map(entries);
  const state = { opens: 0 };
  return {
    state,
    store,
    service: {
      async list() {
        return [...store.entries()].map(([id, entry]) => ({ header: entry.header || { id }, revision: entry.revision, eventCount: entry.events.length }));
      },
      async open(id, mode) {
        state.opens += 1;
        const entry = store.get(id);
        if (!entry) throw new Error("no such session " + id);
        if (entry.fail) throw new Error("read failed");
        return {
          inheritedEventCount: entry.inherited || 0,
          async read(offset) {
            if (offset !== 0) throw new Error("unexpected offset " + offset);
            return { eventState: "shared-frozen", events: entry.events };
          },
          async close() {}
        };
      }
    }
  };
}

const fake = makeFakeSessions([
  ["s1", { revision: 10, header: { id: "s1", updatedAt: NOW }, events: [msgEvent(MON_10AM, 1, 1, "deepseek-flash", usage(1000, 0, 0, 0))] }],
  ["s2", { revision: 3, header: { id: "s2", updatedAt: NOW - 2 * DAY }, events: [msgEvent(MON_8PM, 1, 1, "deepseek-flash", usage(2000, 0, 0, 0))] }],
  ["old", { revision: 1, header: { id: "old", updatedAt: NOW - 30 * DAY }, events: [msgEvent(MON_10AM, 1, 1, "deepseek-flash", usage(9e9, 0, 0, 0))] }]
]);
const sessionCache = new Map();
const viaHost = await t.collectFromPersistence(fake.service, NOW, sessionCache);
check("宿主服务：窗口外的会话被跳过", viaHost.sessions === 2, String(viaHost.sessions));
check("宿主服务：样本数与窗口内一致", viaHost.samples.length === 2, String(viaHost.samples.length));
check("宿主服务：窗口外的 9e9 没被算进来", viaHost.samples.every((s) => s.input < 1e6));
const opensAfterFirst = fake.state.opens;
await t.collectFromPersistence(fake.service, NOW, sessionCache);
check("宿主服务：revision 未变时不重读", fake.state.opens === opensAfterFirst, String(fake.state.opens));
fake.store.get("s1").revision = 11;
await t.collectFromPersistence(fake.service, NOW, sessionCache);
check("宿主服务：revision 变了才重读那一个", fake.state.opens === opensAfterFirst + 1, String(fake.state.opens));

const inherited = await t.readSessionSamples({
  async open() {
    return { inheritedEventCount: 1, async read() { return { events: [{ type: "request/header", data: { header: { config: { provider: "deepseek-official", model: "deepseek-flash" } } } }, msgEvent(MON_10AM, 1, 1, "deepseek-flash", usage(1000, 0, 0, 0))] }; }, async close() {} };
  }
}, "x");
check("宿主服务：继承前缀用于模型归属但不计用量", inherited.samples.length === 1 && inherited.samples[0].input === 1000 && inherited.samples[0].model === "deepseek-official/deepseek-flash", JSON.stringify(inherited.samples));

const failing = makeFakeSessions([["bad", { revision: 1, header: { id: "bad", updatedAt: NOW }, events: [], fail: true }]]);
const failedRead = await t.collectFromPersistence(failing.service, NOW, new Map());
check("宿主服务：单个会话读失败不影响整体", failedRead.ok === true && failedRead.failures.length === 1, JSON.stringify(failedRead.failures));

// 9b) 缓存时间闸：服务端元数据停滞时，不能把当天数字冻住
const stale = makeFakeSessions([
  ["stale", { revision: 1, header: { id: "stale", updatedAt: NOW }, events: [msgEvent(MON_10AM, 1, 1, "deepseek-flash", usage(1000, 0, 0, 0))] }]
]);
const staleCache = new Map();
await t.collectFromPersistence(stale.service, NOW, staleCache, new Map());
const opensAfterStale = stale.state.opens;
await t.collectFromPersistence(stale.service, NOW + 1000, staleCache, new Map());
check("缓存：TTL 内且元数据没变 → 不重读", stale.state.opens === opensAfterStale, String(stale.state.opens));
stale.store.get("stale").events.push(msgEvent(MON_8PM, 1, 2, "deepseek-flash", usage(2000, 0, 0, 0)));
const afterTtl = await t.collectFromPersistence(stale.service, NOW + t.SESSION_CACHE_TTL_MS + 1000, staleCache, new Map());
check("缓存：超过 TTL → 即使 revision 不动也重读", stale.state.opens === opensAfterStale + 1, String(stale.state.opens));
check("缓存：重读后拿到新增事件", afterTtl.samples.length === 2, String(afterTtl.samples.length));
check("缓存：TTL 是 60 秒", t.SESSION_CACHE_TTL_MS === 60000, String(t.SESSION_CACHE_TTL_MS));

// 9c) 服务端给不出用量时，用同一会话的持久日志补读（只认最新一代）
const diskDir = join(root, "sessions", "--workspace3--", "session-disk");
mkdirSync(diskDir, { recursive: true });
const diskHeader = headerLine("session-disk");
writeFileSync(join(diskDir, "session.v3.jsonl.zstd"), frame([diskHeader, msgEvent(MON_10AM, 1, 1, "deepseek-flash", usage(5555, 0, 0, 0))]));
writeFileSync(join(diskDir, "session.v4.jsonl.zstd"), frame([diskHeader, msgEvent(MON_10AM, 1, 1, "deepseek-flash", usage(7777, 0, 0, 0))]));
const diskIndex = t.indexSessionFiles();
const indexed = diskIndex.get("session-disk") || {};
check("磁盘索引：同一会话取最新一代", typeof indexed.file === "string" && indexed.file.endsWith("session.v4.jsonl.zstd"), String(indexed.file));
check("代际排序：v4 > v3 > 无版本", t.generationRank("a/session.v4.jsonl.zstd") > t.generationRank("a/session.v3.jsonl.zstd") && t.generationRank("a/session.v3.jsonl.zstd") > t.generationRank("a/session.jsonl.zstd"));

const emptySvc = makeFakeSessions([["session-disk", { revision: 7, header: { id: "session-disk", updatedAt: NOW }, events: [] }]]);
const complemented = await t.collectFromPersistence(emptySvc.service, NOW, new Map(), diskIndex);
check("服务端空 → 磁盘补读", complemented.samples.length === 1 && complemented.samples[0].input === 7777, JSON.stringify(complemented.samples));
check("补读时不会把旧代际也算进来", complemented.samples.every((s) => s.input !== 5555), JSON.stringify(complemented.samples.map((s) => s.input)));
check("补读只算最新一代（不是 v3+v4）", complemented.samples.reduce((sum, s) => sum + s.input, 0) === 7777, String(complemented.samples.reduce((sum, s) => sum + s.input, 0)));
check("补读计数上报", complemented.diskComplements === 1 && complemented.emptyFromService === 1, JSON.stringify({ c: complemented.diskComplements, e: complemented.emptyFromService }));

// 9d) 宿主的 list() 里根本没有这个会话时，也要按磁盘日志读到
const listEmpty = makeFakeSessions([]);
const diskOnlyResult = await t.collectFromPersistence(listEmpty.service, NOW, new Map(), t.indexSessionFiles());
const diskInputs = diskOnlyResult.samples.map((s) => s.input).sort((a, b) => a - b);
check("宿主列表里没有的会话 → 按磁盘日志读", diskOnlyResult.diskOnlySessions === 1 && diskInputs.indexOf(7777) !== -1, JSON.stringify({ diskOnly: diskOnlyResult.diskOnlySessions, diskInputs }));
check("磁盘独有会话只读最新一代（v3 的 5555 不出现）", diskInputs.indexOf(5555) === -1, JSON.stringify(diskInputs));
check("磁盘独有会话不会被算两次", diskInputs.filter((value) => value === 7777).length === 1, JSON.stringify(diskInputs));
check("磁盘独有会话的来源是持久日志（不是服务端）", diskOnlyResult.emptyFromService === 0, String(diskOnlyResult.emptyFromService));
// 9c/9d 的磁盘夹具用完就撤，避免影响后面的端到端断言（那一段只应看到假服务里的会话）
rmSync(diskDir, { recursive: true, force: true });

// 10) 价目解析：随包 / 按模型覆盖 / 旧格式整表
const builtin = t.resolvePriceTable();
check("价目：默认来自随包表", builtin.source === "builtin", builtin.source);
check("价目：随包表里有 deepseek-flash", Math.abs(t.ratesForModel(builtin.table, "deepseek-official/deepseek-flash").rates.input - 2) < 1e-9);
check("价目：随包表的 cacheRead 是 0.04", Math.abs(t.ratesForModel(builtin.table, "deepseek-official/deepseek-flash").rates.cacheRead - 0.04) < 1e-9);

mkdirSync(join(root, "dsh-cost-strip"), { recursive: true });
writeFileSync(join(root, "dsh-cost-strip", "prices.json"), JSON.stringify({
  models: { "deepseek-official/deepseek-flash": { input: 5, cacheRead: 1, cacheWrite: 5, output: 20 } }
}));
const overridden = t.resolvePriceTable();
check("价目：用户表标记为 config", overridden.source === "config", overridden.source);
check("价目：按模型覆盖生效", Math.abs(t.ratesForModel(overridden.table, "deepseek-official/deepseek-flash").rates.input - 5) < 1e-9);
check("价目：没覆盖的模型仍来自随包表", Math.abs(t.ratesForModel(overridden.table, "deepseek-official/deepseek-v4-pro").rates.input - 9) < 1e-9);

writeFileSync(join(root, "dsh-cost-strip", "prices.json"), JSON.stringify({
  currency: "CNY",
  input: 3,
  cacheRead: 0.5,
  output: 12,
  peakRule: { windows: [[9, 12]], weekdaysOnly: true, offPeakFactor: 0.25, holidays: ["2026-10-19"] }
}));
const legacy = t.resolvePriceTable();
check("价目：旧格式整表单价生效", legacy.table.flat && Math.abs(legacy.table.flat.input - 3) < 1e-9, JSON.stringify(legacy.table.flat));
check("价目：旧格式所有模型都走同一价", Math.abs(t.ratesForModel(legacy.table, "moonshotai/kimi-k3").rates.input - 3) < 1e-9);
check("价目：旧格式 peakRule 窗口转换", legacy.table.peakWindows[0].from === "09:00" && legacy.table.peakWindows[0].to === "12:00", JSON.stringify(legacy.table.peakWindows));
check("价目：旧格式 offPeakFactor 生效", legacy.table.offPeakFactor === 0.25, String(legacy.table.offPeakFactor));
rmSync(join(root, "dsh-cost-strip", "prices.json"), { force: true });

// 11) 端到端：走宿主服务
const e2e = makeFakeSessions([
  ["s1", { revision: 1, header: { id: "s1", updatedAt: NOW }, events: [msgEvent(MON_10AM, 1, 1, "deepseek-flash", usage(1e6, 0, 0, 0))] }],
  ["s2", { revision: 1, header: { id: "s2", updatedAt: NOW }, events: [msgEvent(MON_8PM, 1, 1, "deepseek-flash", usage(1e6, 0, 0, 0))] }],
  ["s3", { revision: 1, header: { id: "s3", updatedAt: NOW }, events: [msgEvent(MON_10AM, 1, 1, "moonshotai/kimi-k3", usage(1e6, 0, 0, 0))] }]
]);
const built = await t.build({ get: (serviceName) => (serviceName === "sessionPersistence" ? e2e.service : undefined), now: NOW });
check("端到端：来源是宿主会话服务", built.source === "session-store", built.source);
check("端到端：今日金额 = 峰 ¥2 + 谷 ¥1（未计价模型不计钱）", Math.abs(built.today.cost - 3) < 1e-9, String(built.today.cost));
check("端到端：未计价模型被点名", built.notes.some((n) => n.includes("kimi-k3")), JSON.stringify(built.notes));
check("端到端：按模型合计存在且不含未计价的钱", built.models.length === 2 && built.models.find((m) => m.model === "moonshotai/kimi-k3").cost === null, JSON.stringify(built.models));
check("端到端：7 天窗口补齐", built.days.length === 7, String(built.days.length));
check("端到端：覆盖率记录会话数", built.coverage.sessions === 3 && built.coverage.failedSessions === 0, JSON.stringify(built.coverage));
check("端到端：货币是 CNY", built.currency === "CNY", String(built.currency));
check("端到端：没有用量的日期记 0（不是 null）", built.days.filter((d) => d.date !== "2026-10-19").every((d) => d.cost === 0), JSON.stringify(built.days.map((d) => [d.date, d.cost])));

const onlyUnpriced = await t.build({ get: () => ({ async list() { return [{ header: { id: "u1", updatedAt: NOW }, revision: 1, eventCount: 1 }]; }, async open() { return { async read() { return { events: [msgEvent(MON_10AM, 1, 1, "moonshotai/kimi-k3", usage(1e6, 0, 0, 0))] }; }, async close() {} }; } }), now: NOW });
check("端到端：只有未计价模型时当天金额是 null", onlyUnpriced.today.cost === null, String(onlyUnpriced.today.cost));
check("端到端：只有未计价模型时仍报 token", onlyUnpriced.today.tokens === 1e6, String(onlyUnpriced.today.tokens));

// 12) 端到端：没有会话服务时走文件回退
const fbDir = join(root, "sessions", "--fb--", "session-fb");
mkdirSync(fbDir, { recursive: true });
writeFileSync(
  join(fbDir, "session.v4.jsonl.zstd"),
  frame([
    headerLine("session-fb"),
    msgEvent(MON_10AM, 1, 1, "deepseek-flash", usage(1000, 0, 0, 0)),
    msgEvent(MON_8PM, 1, 2, "deepseek-flash", usage(1000, 0, 0, 0))
  ])
);
const fallback = await t.build({ get: () => undefined, now: NOW });
check("回退：来源是会话日志", fallback.source === "session-log", fallback.source);
check("回退：读到会话日志里的用量", fallback.today.calls >= 2, String(fallback.today.calls));
check("回退：notes 说明当前是回退解析", fallback.notes.some((n) => n.includes("回退")), JSON.stringify(fallback.notes));
rmSync(join(root, "sessions"), { recursive: true, force: true });

// 13) 路由装配：apply() 注册只读路由，handler 同步/异步都要能回 JSON
const registered = [];
const fakeCtx = {
  get: (serviceName) => (serviceName === "sessionPersistence" ? e2e.service : undefined),
  effect: (callback) => callback(),
  webServer: { register: (route) => { registered.push(route); return () => {}; } },
  logger: { info: () => {}, warn: () => {} }
};
mod.apply(fakeCtx);
check("路由：注册了一条 exact 路由", registered.length === 1 && registered[0].kind === "exact" && registered[0].path === "/dsh-cost-strip/data.json", JSON.stringify(registered.map((r) => r.path)));
const response = await new Promise((resolve) => {
  const meta = { status: 0, headers: {} };
  registered[0].handler({ url: "/dsh-cost-strip/data.json?refresh=1" }, {
    writeHead: (status, headers) => { meta.status = status; meta.headers = headers; },
    end: (body) => resolve({ meta, body })
  });
});
const parsed = JSON.parse(response.body);
check("路由：返回 200 + no-store + JSON", response.meta.status === 200 && /no-store/.test(response.meta.headers["cache-control"] || ""), JSON.stringify(response.meta));
check("路由：payload 里有 days / source / coverage", Array.isArray(parsed.days) && parsed.ok === true && parsed.source === "session-store" && typeof parsed.coverage === "object", JSON.stringify({ source: parsed.source, days: parsed.days.length }));

rmSync(root, { recursive: true, force: true });

// ---------------------------------------------------------------- 汇总
console.log("  通过 " + passed + " 项");
if (failures.length) {
  console.log("  失败 " + failures.length + " 项：");
  for (const failure of failures) console.log("    ✗ " + failure);
  process.exit(1);
}
console.log("  全部通过 ✓");
