// dsh-cost-strip — 宿主半边
//
// 职责：算「今日消费 / 近 7 天消费」，通过一个只读路由给界面读。
// 原则：纯本地、零联网、零凭据，不读任何别的插件写下的文件。
//
// 数据从哪来（两级，取到为止）：
//   1) 宿主会话服务 ctx.sessionPersistence —— 官方只读 seam：
//      list() 拿每个已存会话的 header / revision / eventCount，open(id,"read") 再 read(0) 拿事件流。
//      存储格式与历史迁移都由宿主负责，插件不碰磁盘布局。
//   2) 宿主没挂会话服务（或还没暴露）时，退化为自己按帧解压
//      $DSH_HOME/sessions 下的 session(jsonl) 多帧 zstd（按魔数切帧）。
//
// 用量怎么折（对齐宿主 token 投影，与 dsh-key-usage 同口径，已用真实会话逐日对账）：
//   · 样本搭载在 assistant/chunk（data.chunk.type 为 usage）、assistant/message（data.usage）
//     或 assistant/attempt（data.stream[].chunk.usage）；
//   · 同一 (turn, step) 的重复上报「后到覆盖先到」；llm/retry-started 开启新的尝试槽，
//     新尝试与原尝试累加而不是覆盖；
//   · 模型归属取 data.message.source，缺失时回落最近一次 request/header 的 data.header.config；
//   · 分日按本地日历（宿主 token 投影的口径）。
//
// 计价：随包 data/prices.json 是 DeepSeek 官方 CNY 价目 + 错峰窗口；用户可在
//   $DSH_HOME/dsh-cost-strip/prices.json 覆盖（按模型覆盖，或用旧格式整表单价）。
//   价目表里没有的模型只计 token 不计钱并在 notes 里点名 —— 不猜价。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { zstdDecompressSync } from "node:zlib";

const name = "dsh-cost-strip";
// 只依赖 webServer：注册一个只读路由。不碰 credentials（本插件零凭据）。
const inject = ["webServer"];

const ROUTE = "/dsh-cost-strip/data.json";
const WINDOW_DAYS = 7;
const REFRESH_MS = 30_000;
/** 一次最多看的会话数（按更新时间倒序取），避免初次请求扫全量历史。 */
const MAX_SESSIONS = 300;
/** 同时在读的会话数；宿主 open/read 两步之间有容量 2 的解析 memo，2 路刚好把等待叠起来。 */
const READ_CONCURRENCY = 2;
/** 找文件时给窗口多留一天余量，避免跨日边界漏掉会话。 */
const WINDOW_MARGIN_MS = 36 * 3600 * 1000;
/**
 * 会话折叠结果的缓存寿命。
 * 宿主 list() 的 revision / eventCount 是「尽力而为」的（只读 header，不读事件行），
 * 正在写入的会话完全可能元数据不动、事件却在长——只按元数据做缓存会把当天的数字冻住。
 * 所以指纹之外再加一道时间闸：最多 60 秒（= 前端轮询间隔）就一定重读。
 */
const SESSION_CACHE_TTL_MS = 60 * 1000;
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const UNKNOWN_MODEL = "unknown/unknown";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const SESSIONS_ROOT = join(DSH_HOME, "sessions");
const CONFIG_DIR = join(DSH_HOME, "dsh-cost-strip");
const PRICES_FILE = join(CONFIG_DIR, "prices.json");
const BUNDLED_PRICES = join(MODULE_DIR, "..", "data", "prices.json");

const SOURCE_NOTES = {
  "session-store": "来自宿主会话服务（sessionPersistence，只读）",
  "session-log": "来自本机会话日志（宿主未挂会话服务时的回退解析）",
  none: "没有读到会话数据"
};

// ---------------------------------------------------------------- 工具

function toFinite(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return NaN;
}

function num(value) {
  const parsed = toFinite(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 毫秒时间戳 → 本地日历 YYYY-MM-DD（与宿主 token 投影一致）。 */
function localDateOf(ms) {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return date.getFullYear() + "-" + month + "-" + day;
}

/** 最近 n 天（含今天）的本地日期数组，升序。 */
function recentDates(n, now = Date.now()) {
  const out = [];
  const base = new Date(now);
  base.setHours(0, 0, 0, 0);
  for (let i = n - 1; i >= 0; i--) {
    const day = new Date(base.getTime());
    day.setDate(day.getDate() - i);
    out.push(localDateOf(day.getTime()));
  }
  return out;
}

/** "HH:MM" → 当日分钟数；"24:00" 归一成 0（表示一天结束）。非法返回 null。 */
function parseClock(text) {
  if (typeof text !== "string") return null;
  const matched = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!matched) return null;
  const hours = Number(matched[1]);
  const minutes = Number(matched[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours > 24 || minutes > 59) return null;
  const total = hours * 60 + minutes;
  return total === 1440 ? 0 : total;
}

/** 该时刻是否落在价目表的峰价窗口内（窗口/节假日按本地时间判定）。 */
function isPeakAt(ms, table) {
  const windows = Array.isArray(table && table.peakWindows) ? table.peakWindows : [];
  if (windows.length === 0) return false;
  const date = new Date(ms);
  const weekday = date.getDay() === 0 ? 7 : date.getDay();
  const minutesOfDay = date.getHours() * 60 + date.getMinutes();
  const holidays = Array.isArray(table && table.holidays) ? table.holidays : [];
  if (holidays.includes(localDateOf(ms))) return false;
  for (const window of windows) {
    const days = Array.isArray(window && window.days) && window.days.length ? window.days : [1, 2, 3, 4, 5];
    if (!days.includes(weekday)) continue;
    const from = parseClock(window && window.from);
    const to = parseClock(window && window.to);
    if (from === null || to === null) continue;
    if (from === to) return true;
    const inside = from < to ? minutesOfDay >= from && minutesOfDay < to : minutesOfDay >= from || minutesOfDay < to;
    if (inside) return true;
  }
  return false;
}

function zeroTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// ------------------------------------------------- 折叠会话事件 → 用量样本

/** 事件携带的用量样本；与「哪些事件算样本」的口径一一对应。 */
function usageOfEvent(event) {
  const data = event && event.data;
  if (event.type === "assistant/chunk") {
    const chunk = data && data.chunk;
    return chunk && chunk.type === "usage" && chunk.usage !== undefined ? chunk.usage : null;
  }
  if (event.type !== "assistant/message" && event.type !== "assistant/attempt") return null;
  if (event.type === "assistant/message" && data && data.usage !== undefined) return data.usage;
  const stream = data && data.stream;
  if (!Array.isArray(stream)) return null;
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index];
    if (record && record.type === "chunk" && record.chunk && record.chunk.type === "usage" && record.chunk.usage !== undefined) {
      return record.chunk.usage;
    }
  }
  return null;
}

/** 模型归属：data.message.source 优先，其次 request/header 的 config。 */
function modelOfEvent(event) {
  const source = event && event.data && event.data.message && event.data.message.source;
  if (source !== undefined && typeof source.model === "string" && source.model !== "") {
    const provider = typeof source.provider === "string" && source.provider !== "" ? source.provider : "unknown";
    return provider + "/" + source.model;
  }
  const config = event && event.data && event.data.header && event.data.header.config;
  if (config !== undefined && typeof config.model === "string" && config.model !== "") {
    const provider = typeof config.provider === "string" && config.provider !== "" ? config.provider : "unknown";
    return provider + "/" + config.model;
  }
  return null;
}

function tokensOfUsage(usage) {
  return {
    input: num(usage && usage.inputTokens),
    output: num(usage && usage.outputTokens),
    cacheRead: num(usage && usage.cacheReadTokens),
    cacheWrite: num(usage && usage.cacheWriteTokens)
  };
}

/**
 * 折叠一段事件流 → 去重后的用量样本数组。
 * 同 (turn, step) 重复上报「后到覆盖先到」；llm/retry-started 另开一个尝试槽（累加）。
 */
function foldSession(events) {
  const samples = new Map();
  const attempts = new Map();
  let currentModel = null;
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const type = event.type;
    if (type === "request/header") {
      const model = modelOfEvent(event);
      if (model !== null) currentModel = model;
      continue;
    }
    if (type === "llm/retry-started") {
      const data = event.data || {};
      if (Number.isInteger(data.turn) && Number.isInteger(data.step)) {
        const key = data.turn + ":" + data.step;
        attempts.set(key, (attempts.get(key) || 0) + 1);
      }
      continue;
    }
    if (type !== "assistant/chunk" && type !== "assistant/message" && type !== "assistant/attempt") continue;
    const usage = usageOfEvent(event);
    const time = typeof event.time === "number" ? event.time : null;
    if (usage === null || time === null) continue;
    const data = event.data || {};
    const base = Number.isInteger(data.turn) && Number.isInteger(data.step) ? data.turn + ":" + data.step : "seq:" + event.seq;
    const attempt = attempts.get(base) || 0;
    samples.set(base + "#" + attempt, {
      time,
      model: modelOfEvent(event) || currentModel || UNKNOWN_MODEL,
      ...tokensOfUsage(usage)
    });
  }
  return [...samples.values()];
}

// --------------------------------------------------------------- 计价

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function normalizeRates(raw) {
  const input = num(raw && raw.input);
  const cacheRead = num(raw && raw.cacheRead);
  const cacheWrite = Number.isFinite(toFinite(raw && raw.cacheWrite)) ? toFinite(raw.cacheWrite) : input;
  return { input, cacheRead, cacheWrite, output: num(raw && raw.output) };
}

/** 旧格式 peakRule（[[9,12],[14,18]] + weekdaysOnly + holidays）→ 新窗口形状。 */
function windowsFromLegacyRule(rule) {
  if (!rule || typeof rule !== "object") return null;
  const pairs = Array.isArray(rule.windows) ? rule.windows : [[9, 12], [14, 18]];
  const days = rule.weekdaysOnly === false ? [1, 2, 3, 4, 5, 6, 7] : [1, 2, 3, 4, 5];
  const windows = [];
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const from = Number(pair[0]);
    const to = Number(pair[1]);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    windows.push({
      from: String(from).padStart(2, "0") + ":00",
      to: to >= 24 ? "24:00" : String(to).padStart(2, "0") + ":00",
      days
    });
  }
  return windows.length ? windows : null;
}

/**
 * 价目表 = 随包官方表 加 用户覆盖（$DSH_HOME/dsh-cost-strip/prices.json）。
 * 用户表有两种写法：
 *   · 新版：models: { "provider/model": { input, cacheRead, cacheWrite, output } }，可带 default / peakWindows / offPeakFactor / holidays
 *   · 旧版（继续支持）：{ input, cacheRead, output, peakRule } —— 整表单价
 */
function resolvePriceTable() {
  const bundled = readJsonFile(BUNDLED_PRICES);
  const base = bundled && typeof bundled === "object" ? bundled : { currency: "CNY", default: null, models: {} };
  const user = readJsonFile(PRICES_FILE);
  if (!user || typeof user !== "object") {
    return { table: base, source: "builtin", note: "单价来自随包的官方价目表" };
  }
  if (Number.isFinite(toFinite(user.input))) {
    const peakWindows = windowsFromLegacyRule(user.peakRule) || base.peakWindows;
    const factor = user.peakRule && Number.isFinite(toFinite(user.peakRule.offPeakFactor))
      ? toFinite(user.peakRule.offPeakFactor)
      : Number.isFinite(toFinite(user.offPeakFactor)) ? toFinite(user.offPeakFactor) : base.offPeakFactor;
    const holidays = user.peakRule && Array.isArray(user.peakRule.holidays) ? user.peakRule.holidays : base.holidays;
    return {
      table: { ...base, flat: normalizeRates(user), currency: typeof user.currency === "string" ? user.currency : base.currency, peakWindows, offPeakFactor: factor, holidays },
      source: "config",
      note: "单价来自 prices.json（整表单价）"
    };
  }
  const models = { ...(base.models || {}), ...(user.models && typeof user.models === "object" ? user.models : {}) };
  return {
    table: {
      ...base,
      models,
      default: user.default && typeof user.default === "object" ? user.default : base.default,
      currency: typeof user.currency === "string" ? user.currency : base.currency,
      peakWindows: Array.isArray(user.peakWindows) ? user.peakWindows : base.peakWindows,
      offPeakFactor: Number.isFinite(toFinite(user.offPeakFactor)) ? toFinite(user.offPeakFactor) : base.offPeakFactor,
      holidays: Array.isArray(user.holidays) ? user.holidays : base.holidays,
      source: typeof user.source === "string" ? user.source : base.source,
      fetchedAt: typeof user.fetchedAt === "string" ? user.fetchedAt : base.fetchedAt
    },
    source: "config",
    note: "单价来自 prices.json（按模型覆盖官方表）"
  };
}

/** 取某模型的单价；价目表里没有就不计价（不拿别的模型的价格顶替）。 */
function ratesForModel(table, model) {
  if (table.flat) return { rates: normalizeRates(table.flat), source: "config" };
  const entry = table.models && table.models[model];
  if (entry && Number.isFinite(toFinite(entry.input))) return { rates: normalizeRates(entry), source: "catalog" };
  if (model === UNKNOWN_MODEL && table.default && Number.isFinite(toFinite(table.default.input))) {
    return { rates: normalizeRates(table.default), source: "default" };
  }
  return { rates: null, source: "none" };
}

function tokensOfBucket(bucket) {
  const total = zeroTokens();
  for (const side of [bucket.peak, bucket.off]) {
    total.input += side.input;
    total.output += side.output;
    total.cacheRead += side.cacheRead;
    total.cacheWrite += side.cacheWrite;
  }
  return total;
}

/**
 * 一个 (日期, 模型) 桶的钱：峰段按峰价、谷段按谷价乘 offPeakFactor。
 * 没有价目 → cost 为 null（只报 token）。
 */
function costOfBucket(bucket, table) {
  const rates = ratesForModel(table, bucket.model).rates;
  if (!rates) return { cost: null, priced: false };
  const factor = Number.isFinite(toFinite(table.offPeakFactor)) ? toFinite(table.offPeakFactor) : 0.5;
  const money = (side, scale) =>
    ((side.input / 1e6) * rates.input + (side.cacheRead / 1e6) * rates.cacheRead + (side.cacheWrite / 1e6) * rates.cacheWrite + (side.output / 1e6) * rates.output) * scale;
  return { cost: money(bucket.peak, 1) + money(bucket.off, factor), priced: true };
}

// ------------------------------------------------- 来源 1：宿主会话服务

/** 日志文件代际：session.jsonl.zstd(0) < session.v1... < session.vN。 */
function generationRank(file) {
  const matched = /\.v(\d+)\.jsonl\.zstd$/.exec(file);
  return matched ? Number(matched[1]) : 0;
}

/** 只解第一帧拿会话 header 的 id（廉价的头部读取）。 */
function readSessionHeaderId(file) {
  let buffer;
  try {
    buffer = readFileSync(file);
  } catch {
    return null;
  }
  const start = buffer.indexOf(ZSTD_MAGIC, 0);
  if (start === -1) return null;
  const next = buffer.indexOf(ZSTD_MAGIC, start + 4);
  const end = next === -1 ? buffer.length : next;
  let text = "";
  try {
    text = zstdDecompressSync(buffer.subarray(start, end)).toString("utf8");
  } catch {
    return null;
  }
  const firstLine = text.split("\n").find((line) => line !== "");
  if (firstLine === undefined) return null;
  try {
    const header = JSON.parse(firstLine);
    return typeof header.id === "string" && header.id !== "" ? header.id : null;
  } catch {
    return null;
  }
}

/**
 * 会话 id → 磁盘上最新一代日志（按 header 里的 id 索引）。
 * 用于：会话服务没能给出这个会话的用量时，用同一会话的持久日志补齐。
 * cutoff 只影响成本：早于窗口的文件连 header 都不用解。
 */
function indexSessionFiles(cutoff) {
  const index = new Map();
  for (const file of sessionFiles()) {
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue;
    }
    if (cutoff !== undefined && stat.mtimeMs < cutoff) continue;
    const id = readSessionHeaderId(file);
    if (id === null) continue;
    const generation = generationRank(file);
    const previous = index.get(id);
    if (!previous || generation > previous.generation) index.set(id, { file, generation, stat });
  }
  return index;
}

/**
 * 读一个会话的事件流（官方 read handle：open 然后 read(0) 然后 close）。
 * 继承前缀只用来建立模型归属，不计入本次用量。
 */
async function readSessionSamples(persistence, id) {
  let handle;
  try {
    handle = await persistence.open(id, "read");
    if (handle === undefined || handle === null) return { failure: "宿主未提供 open(id, read)" };
    const result = await handle.read(0);
    const events = result && Array.isArray(result.events) ? result.events : [];
    const inherited = typeof handle.inheritedEventCount === "number" ? handle.inheritedEventCount : 0;
    if (Number.isSafeInteger(inherited) && inherited > 0 && inherited <= events.length) {
      const prefix = events.slice(0, inherited).filter((event) => event && event.type === "request/header");
      return { samples: foldSession([...prefix, ...events.slice(inherited)]) };
    }
    return { samples: foldSession(events) };
  } catch (error) {
    return { failure: errorMessage(error) };
  } finally {
    if (handle !== undefined && handle !== null) {
      try {
        await handle.close();
      } catch {
        // 关闭失败不影响已经读到的事件
      }
    }
  }
}

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.max(1, Math.min(limit, items.length))).fill(null).map(async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      out[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return out;
}

function updatedAtOf(header) {
  const updated = header && header.updatedAt;
  if (typeof updated === "number") return updated;
  const created = header && header.createdAt;
  return typeof created === "number" ? created : null;
}

/**
 * 通过宿主会话服务收集样本。
 * 只看更新时间落在窗口内的会话；折叠结果按「元数据指纹 + 60 秒时间闸」缓存
 * （指纹覆盖 revision / eventCount / sizeBytes / updatedAt，其中 revision 是宿主声明的
 * 「尽力而为」值，所以时间闸不能省）。
 *
 * 防御：某个会话服务端读回来一条用量样本都没有、但磁盘上同一会话的日志在窗口内，
 * 就补读那份日志——服务读的是当前逻辑视图，活跃会话在迁移/写入途中可能还没暴露完整事件，
 * 而持久日志是同一个会话自己的记录，补读不会串到别的会话上。
 */
async function collectFromPersistence(persistence, now, sessionCache, diskIndex) {
  const snapshots = await persistence.list();
  if (!Array.isArray(snapshots)) return { ok: false, note: "会话服务 list() 没有返回数组" };
  const cutoff = now - WINDOW_DAYS * 86400 * 1000 - WINDOW_MARGIN_MS;
  const picked = [];
  const seen = new Set();
  for (const snapshot of snapshots) {
    const header = (snapshot && snapshot.header) || {};
    const id = typeof header.id === "string" && header.id !== "" ? header.id : null;
    if (id === null || seen.has(id)) continue;
    const updatedAt = updatedAtOf(header);
    if (updatedAt !== null && updatedAt < cutoff) continue;
    seen.add(id);
    picked.push({
      id,
      updatedAt: updatedAt || 0,
      revision: snapshot.revision,
      eventCount: snapshot.eventCount,
      sizeBytes: snapshot.sizeBytes
    });
  }
  // 磁盘上有、宿主 list() 里没有的会话：按持久日志读（宿主声明「不可读的 header 不参与发现」，
  // 正在进行代际迁移或写入的活跃会话可能暂时不在列表里 —— 账不能因此少算）
  let diskOnlySessions = 0;
  if (diskIndex) {
    for (const [id, entry] of diskIndex) {
      if (seen.has(id) || entry.stat.mtimeMs < cutoff) continue;
      seen.add(id);
      diskOnlySessions += 1;
      picked.push({
        id,
        updatedAt: entry.stat.mtimeMs,
        revision: undefined,
        eventCount: undefined,
        sizeBytes: entry.stat.size,
        file: entry.file,
        diskOnly: true
      });
    }
  }
  picked.sort((first, second) => second.updatedAt - first.updatedAt);
  const limited = picked.slice(0, MAX_SESSIONS);
  const failures = [];
  let emptyFromService = 0;
  let diskComplements = 0;
  const results = await mapLimit(limited, READ_CONCURRENCY, async (item) => {
    const fingerprint = [item.diskOnly ? "disk" : "svc", item.revision, item.eventCount, item.sizeBytes, item.updatedAt].map((value) => String(value)).join("|");
    const cached = sessionCache.get(item.id);
    if (cached && cached.key === fingerprint && now - cached.at < SESSION_CACHE_TTL_MS) return cached.samples;
    if (item.diskOnly) {
      const events = readSessionLog(item.file);
      const samples = events === null ? [] : foldSession(events);
      sessionCache.set(item.id, { key: fingerprint, at: now, samples });
      return samples;
    }
    const read = await readSessionSamples(persistence, item.id);
    if (read.failure !== undefined) failures.push(item.id + ": " + read.failure);
    let samples = read.failure !== undefined ? [] : read.samples;
    if (samples.length === 0) {
      emptyFromService += 1;
      const disk = diskIndex ? diskIndex.get(item.id) : undefined;
      if (disk && disk.stat.mtimeMs >= cutoff) {
        const events = readSessionLog(disk.file);
        if (events !== null && events.length > 0) {
          samples = foldSession(events);
          diskComplements += 1;
        }
      }
    }
    sessionCache.set(item.id, { key: fingerprint, at: now, samples });
    return samples;
  });
  const samples = [];
  for (const list of results) samples.push(...list);
  return {
    ok: true,
    samples,
    sessions: limited.length,
    total: snapshots.length,
    failures,
    emptyFromService,
    diskComplements,
    diskOnlySessions
  };
}

// ------------------------------------------------- 来源 2：会话日志回退

/** DSH 会话日志：session.jsonl.zstd / session.v3.jsonl.zstd / session.v4.jsonl.zstd */
function sessionFiles() {
  try {
    return readdirSync(SESSIONS_ROOT, { recursive: true })
      .filter((entry) => typeof entry === "string" && /session(\.v\d+)?\.jsonl\.zstd$/.test(entry))
      .map((entry) => join(SESSIONS_ROOT, entry));
  } catch {
    return [];
  }
}

/** 逐帧解压一个多帧 zstd 日志 → 事件数组（坏帧/半帧跳过）。 */
function readSessionLog(file) {
  let buffer;
  try {
    buffer = readFileSync(file);
  } catch {
    return null;
  }
  const events = [];
  let start = buffer.indexOf(ZSTD_MAGIC, 0);
  if (start === -1) return events;
  while (start !== -1) {
    const next = buffer.indexOf(ZSTD_MAGIC, start + 4);
    const end = next === -1 ? buffer.length : next;
    let text = "";
    try {
      text = zstdDecompressSync(buffer.subarray(start, end)).toString("utf8");
    } catch {
      // 半帧 / 坏帧：跳过，下次文件增长会重读
    }
    if (text) {
      for (const line of text.split("\n")) {
        if (!line) continue;
        try {
          events.push(JSON.parse(line));
        } catch {
          // 非 JSON 行跳过
        }
      }
    }
    start = next;
  }
  return events;
}

/**
 * 回退路径：自己扫会话日志。
 * 每个会话只读**最新一代**（同一会话的 v3/v4 是同一条转录的不同代际，全读会重复计费），
 * 只看窗口内改动过的文件；万一一个 header 都解析不出来，才退回逐文件读。
 */
function collectFromFiles(now, fileCache) {
  const cutoff = now - WINDOW_DAYS * 86400 * 1000 - WINDOW_MARGIN_MS;
  const targets = [];
  const index = indexSessionFiles(cutoff);
  if (index.size > 0) {
    for (const entry of index.values()) targets.push({ file: entry.file, stat: entry.stat, sessionId: entry.file });
  } else {
    for (const file of sessionFiles()) {
      try {
        targets.push({ file, stat: statSync(file), sessionId: file });
      } catch {
        // 读不到的跳过
      }
    }
  }
  const samples = [];
  let read = 0;
  let candidates = 0;
  for (const target of targets) {
    const file = target.file;
    const stat = target.stat;
    if (stat.mtimeMs < cutoff) continue;
    candidates += 1;
    const key = String(stat.mtimeMs) + "|" + String(stat.size);
    const cached = fileCache.get(file);
    if (cached && cached.key === key) {
      samples.push(...cached.samples);
      read += 1;
      continue;
    }
    const events = readSessionLog(file);
    if (events === null) continue;
    const folded = foldSession(events);
    fileCache.set(file, { key, samples: folded });
    samples.push(...folded);
    read += 1;
  }
  return { samples, files: read, candidates };
}

// --------------------------------------------------------------- 组装

function aggregate(samples, table) {
  const buckets = new Map();
  for (const sample of samples) {
    const date = localDateOf(sample.time);
    const key = date + "|" + sample.model;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { date, model: sample.model, calls: 0, peak: zeroTokens(), off: zeroTokens() };
      buckets.set(key, bucket);
    }
    bucket.calls += 1;
    const side = isPeakAt(sample.time, table) ? bucket.peak : bucket.off;
    side.input += sample.input;
    side.output += sample.output;
    side.cacheRead += sample.cacheRead;
    side.cacheWrite += sample.cacheWrite;
  }
  return buckets;
}

function summarize(samples, table, priceSource, priceNote, now, meta) {
  const dates = recentDates(WINDOW_DAYS, now);
  const buckets = aggregate(samples, table);
  const notes = [];
  if (priceNote) notes.push(priceNote);

  const unpricedModels = new Set();
  const modelsOf = (bucketList) =>
    bucketList
      .map((bucket) => {
        const tokens = tokensOfBucket(bucket);
        const priced = costOfBucket(bucket, table);
        if (!priced.priced) unpricedModels.add(bucket.model);
        return {
          model: bucket.model,
          calls: bucket.calls,
          tokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
          inputTokens: tokens.input,
          outputTokens: tokens.output,
          cacheReadTokens: tokens.cacheRead,
          cacheWriteTokens: tokens.cacheWrite,
          cost: priced.cost,
          priced: priced.priced
        };
      })
      .sort((first, second) => second.tokens - first.tokens);

  const days = dates.map((date) => {
    const dayBuckets = [...buckets.values()].filter((bucket) => bucket.date === date);
    const models = modelsOf(dayBuckets);
    const priced = models.filter((model) => model.priced);
    return {
      date,
      calls: models.reduce((sum, model) => sum + model.calls, 0),
      tokens: models.reduce((sum, model) => sum + model.tokens, 0),
      // 没有样本的日期是「当天没花钱」= 0；只有未计价模型时才是 null（算不出来）
      cost: priced.length ? priced.reduce((sum, model) => sum + model.cost, 0) : models.length ? null : 0,
      partial: priced.length > 0 && priced.length !== models.length,
      models
    };
  });

  // 按模型合计（buckets 是「日期 × 模型」粒度，这里再折成模型粒度）
  const byModel = new Map();
  for (const bucket of buckets.values()) {
    let merged = byModel.get(bucket.model);
    if (!merged) {
      merged = { date: "", model: bucket.model, calls: 0, peak: zeroTokens(), off: zeroTokens() };
      byModel.set(bucket.model, merged);
    }
    merged.calls += bucket.calls;
    for (const side of ["peak", "off"]) {
      for (const key of ["input", "output", "cacheRead", "cacheWrite"]) merged[side][key] += bucket[side][key];
    }
  }
  const allModels = modelsOf([...byModel.values()]);
  const pricedModels = allModels.filter((model) => model.priced);
  const todayDate = localDateOf(now);
  const today = days.find((day) => day.date === todayDate) || { date: todayDate, calls: 0, tokens: 0, cost: null, partial: false, models: [] };
  const currency = pricedModels.length ? table.currency || "CNY" : null;

  if (unpricedModels.size > 0) {
    notes.push("价目表里没有这些模型，只计 token 不计钱：" + [...unpricedModels].join("、") + "（可在 prices.json 里补）");
  }
  if (meta.source === "session-log") notes.push("宿主未提供会话服务，当前走会话日志回退解析");
  if (meta.failures && meta.failures.length) notes.push(meta.failures.length + " 个会话读取失败（已跳过）");
  if (meta.diskComplements) notes.push(meta.diskComplements + " 个会话服务端没给出用量，已用同一会话的持久日志补齐");
  if (meta.diskOnlySessions) notes.push(meta.diskOnlySessions + " 个会话不在宿主的会话列表里，已按磁盘日志读取");
  if (pricedModels.length > 0 && today.partial) notes.push("今日金额不含未计价模型的 token");

  return {
    ok: true,
    updatedAt: new Date(now).toISOString(),
    source: meta.source,
    sourceNote: SOURCE_NOTES[meta.source] || SOURCE_NOTES.none,
    currency,
    priceSource,
    priceScope: table.flat ? "flat" : "per-model",
    today: { date: today.date, cost: today.cost, tokens: today.tokens, calls: today.calls, models: today.models },
    days,
    total: days.reduce((sum, day) => sum + (Number.isFinite(day.cost) ? day.cost : 0), 0),
    models: allModels,
    notes,
    coverage: {
      sessions: meta.sessions || 0,
      knownSessions: meta.total || 0,
      failedSessions: (meta.failures || []).length,
      emptyFromService: meta.emptyFromService || 0,
      diskComplements: meta.diskComplements || 0,
      diskOnlySessions: meta.diskOnlySessions || 0,
      windowDays: WINDOW_DAYS
    }
  };
}

let cache = { at: 0, data: null };
const sessionCache = new Map();
const fileCache = new Map();

/** 汇总一次（async：宿主会话服务是异步的）。 */
async function build(options = {}) {
  const now = options.now || Date.now();
  const get = options.get;
  const resolved = resolvePriceTable();
  let samples = [];
  let meta = { source: "none", sessions: 0, total: 0, failures: [] };

  const persistence = typeof get === "function" ? get("sessionPersistence") : undefined;
  if (persistence && typeof persistence.list === "function" && typeof persistence.open === "function") {
    try {
      const diskIndex = indexSessionFiles(now - WINDOW_DAYS * 86400 * 1000 - WINDOW_MARGIN_MS);
      const collected = await collectFromPersistence(persistence, now, sessionCache, diskIndex);
      if (collected.ok) {
        samples = collected.samples;
        meta = {
          source: "session-store",
          sessions: collected.sessions,
          total: collected.total,
          failures: collected.failures,
          emptyFromService: collected.emptyFromService,
          diskComplements: collected.diskComplements,
          diskOnlySessions: collected.diskOnlySessions
        };
      }
    } catch (error) {
      meta = { source: "none", sessions: 0, total: 0, failures: [errorMessage(error)] };
    }
  }
  if (samples.length === 0 && meta.sessions === 0) {
    const collected = collectFromFiles(now, fileCache);
    samples = collected.samples;
    meta = { source: "session-log", sessions: collected.files, total: collected.candidates, failures: [] };
  }
  return summarize(samples, resolved.table, resolved.source, resolved.note, now, meta);
}

async function snapshot(getService, force) {
  if (!force && cache.data && Date.now() - cache.at < REFRESH_MS) return cache.data;
  const data = await build({ get: getService });
  cache = { at: Date.now(), data };
  return data;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

function apply(ctx) {
  // 惰性取服务：会话服务是可选依赖，缺失时自动走会话日志回退
  const getService = (serviceName) => (typeof ctx.get === "function" ? ctx.get(serviceName) : undefined);
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: ROUTE,
        handler: (req, res) => {
          const force = typeof req.url === "string" && req.url.includes("refresh=1");
          snapshot(getService, force).then(
            (data) => {
              res.writeHead(200, JSON_HEADERS);
              res.end(JSON.stringify(data));
            },
            (error) => {
              const message = errorMessage(error);
              if (ctx.logger && typeof ctx.logger.warn === "function") ctx.logger.warn(name + ": 统计失败：" + message);
              res.writeHead(500, JSON_HEADERS);
              res.end(JSON.stringify({ ok: false, error: message }));
            }
          );
        }
      }),
    name + ": data route"
  );
  if (ctx.logger && typeof ctx.logger.info === "function") ctx.logger.info(name + ": 已挂载 " + ROUTE);
}

export { name, inject, apply };
// 供离线测试使用（DSH 运行时不会读这些额外导出）
export const __test__ = {
  localDateOf,
  recentDates,
  parseClock,
  isPeakAt,
  foldSession,
  aggregate,
  costOfBucket,
  tokensOfBucket,
  resolvePriceTable,
  ratesForModel,
  readSessionLog,
  collectFromFiles,
  collectFromPersistence,
  readSessionSamples,
  indexSessionFiles,
  generationRank,
  readSessionHeaderId,
  sessionFiles,
  SESSION_CACHE_TTL_MS,
  build,
  summarize,
  sessionCache,
  fileCache,
  ZSTD_MAGIC,
  SESSIONS_ROOT,
  PRICES_FILE,
  BUNDLED_PRICES,
  WINDOW_DAYS
};
