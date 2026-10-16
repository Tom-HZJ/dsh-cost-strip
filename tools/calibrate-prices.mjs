#!/usr/bin/env node
// 价目表工具：
//   node tools/calibrate-prices.mjs                          打印当前生效价目 + 近 7 天自检
//   node tools/calibrate-prices.mjs --ledger <账本.json>      用**你自己给的**账本反解单价（预览）
//   node tools/calibrate-prices.mjs --ledger <账本.json> --write   覆盖 ~/.dsh/dsh-cost-strip/prices.json
//
// 账本要自己指定路径（任何含 { days: { 日期: { provider: { model: { inputTokens, cacheReadTokens,
// outputTokens, cost } } } } } 形状的 JSON 都行）。本工具**不猜任何插件的存放位置**：
// 读哪个文件由你说了算。
//
// 口径提醒：反解出来的是平均价（把峰谷、模型差异、折扣都摊平了）。要严格峰谷计价，
// 直接用随包官方表，或在 prices.json 里按模型覆盖（见 README）。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const OUT_DIR = join(DSH_HOME, "dsh-cost-strip");
const OUT = join(OUT_DIR, "prices.json");

const argv = process.argv.slice(2);
const flagValue = (flag) => {
  const index = argv.indexOf(flag);
  return index === -1 ? null : argv[index + 1] || null;
};
const LEDGER = flagValue("--ledger");
const WRITE = argv.includes("--write");

const mod = await import(pathToFileURL(join(HERE, "..", "lib", "index.js")).href);
const t = mod.__test__;

const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

function describeTable() {
  const resolved = t.resolvePriceTable();
  const table = resolved.table;
  console.log("生效价目：" + resolved.note + (table.source ? " 来源 " + table.source : "") + (table.fetchedAt ? "（抓取于 " + table.fetchedAt + "）" : ""));
  const windows = (table.peakWindows || []).map((w) => w.from + "-" + w.to).join("、");
  console.log("  峰价窗口：" + (windows || "（无）") + "；谷价系数 " + table.offPeakFactor);
  console.log("  模型                                        输入   缓存读  缓存写   输出");
  const rows = Object.entries(table.models || {});
  for (const [model, rates] of rows) {
    const r = table.flat || rates;
    console.log(
      "  " +
        model.padEnd(52) +
        String(r.input).padStart(6) +
        String(r.cacheRead).padStart(8) +
        String(r.cacheWrite === undefined ? r.input : r.cacheWrite).padStart(8) +
        String(r.output).padStart(7)
    );
  }
  console.log("  （单位：元 / 百万 tokens；价目表里没有的模型只计 token 不计钱）");
}

async function selfCheck() {
  const data = await t.build({});
  console.log("\n近 " + data.days.length + " 天自检（读" + (data.source === "session-store" ? "宿主会话服务" : "本机会话日志") + "）：");
  console.log("  日期        token        金额");
  for (const day of data.days) {
    const cost = Number.isFinite(day.cost) ? day.cost.toFixed(4).padStart(10) : "  未计价".padStart(10);
    console.log("  " + day.date + "  " + String(day.tokens).padStart(11) + "  " + cost);
  }
  console.log("  合计                         " + data.total.toFixed(4));
  for (const note of data.notes || []) console.log("  · " + note);
}

function loadRows(file) {
  let ledger;
  try {
    ledger = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    console.error("读不到账本 " + file + "：" + error.message);
    process.exit(2);
  }
  const rows = [];
  for (const [date, providers] of Object.entries(ledger.days || {})) {
    let input = 0;
    let cacheRead = 0;
    let output = 0;
    let cost = 0;
    for (const provider of Object.values(providers || {})) {
      for (const model of Object.values(provider || {})) {
        input += num(model.inputTokens);
        cacheRead += num(model.cacheReadTokens);
        output += num(model.outputTokens);
        cost += num(model.cost);
      }
    }
    if (cost > 0 && input + cacheRead + output > 0) rows.push({ date, input, cacheRead, output, cost });
  }
  return rows.sort((first, second) => (first.date < second.date ? -1 : 1));
}

function solve3(M, v) {
  const det =
    M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) -
    M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) +
    M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return null;
  const inverse = [
    [(M[1][1] * M[2][2] - M[1][2] * M[2][1]) / det, (M[0][2] * M[2][1] - M[0][1] * M[2][2]) / det, (M[0][1] * M[1][2] - M[0][2] * M[1][1]) / det],
    [(M[1][2] * M[2][0] - M[1][0] * M[2][2]) / det, (M[0][0] * M[2][2] - M[0][2] * M[2][0]) / det, (M[0][2] * M[1][0] - M[0][0] * M[1][2]) / det],
    [(M[1][0] * M[2][1] - M[1][1] * M[2][0]) / det, (M[0][1] * M[2][0] - M[0][0] * M[2][1]) / det, (M[0][0] * M[1][1] - M[0][1] * M[1][0]) / det]
  ];
  return [0, 1, 2].map((row) => inverse[row][0] * v[0] + inverse[row][1] * v[1] + inverse[row][2] * v[2]);
}

if (LEDGER === null) {
  describeTable();
  await selfCheck();
  console.log("\n（要反解单价请显式传账本：--ledger <账本.json>）");
  process.exit(0);
}

const rows = loadRows(LEDGER);
if (rows.length < 3) {
  console.error("账本 " + LEDGER + " 里只有 " + rows.length + " 天带消费的样本，至少需要 3 天（越多越准）。");
  process.exit(2);
}

const M = [
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0]
];
const v = [0, 0, 0];
for (const row of rows) {
  const a = [row.input / 1e6, row.cacheRead / 1e6, row.output / 1e6];
  for (let p = 0; p < 3; p++) {
    v[p] += a[p] * row.cost;
    for (let q = 0; q < 3; q++) M[p][q] += a[p] * a[q];
  }
}
const prices = solve3(M, v);
if (!prices || prices.some((x) => !Number.isFinite(x) || x < 0)) {
  console.error("反解失败（矩阵退化或出现负单价）——样本太少，或各天 token 结构太相似。");
  process.exit(2);
}

const [priceIn, priceCache, priceOut] = prices;
let predicted = 0;
let actual = 0;
console.log("  样本 " + rows.length + " 天（" + rows[0].date + " … " + rows[rows.length - 1].date + "）");
console.log("  日期            输入(M)   缓存读(M)   输出(M)     账本¥     拟合¥");
for (const row of rows) {
  const value = (row.input / 1e6) * priceIn + (row.cacheRead / 1e6) * priceCache + (row.output / 1e6) * priceOut;
  predicted += value;
  actual += row.cost;
  console.log(
    "  " +
      row.date +
      "  " +
      (row.input / 1e6).toFixed(2).padStart(8) +
      "  " +
      (row.cacheRead / 1e6).toFixed(1).padStart(9) +
      "  " +
      (row.output / 1e6).toFixed(2).padStart(7) +
      "  " +
      row.cost.toFixed(2).padStart(8) +
      "  " +
      value.toFixed(2).padStart(8)
  );
}
const relErr = Math.abs(predicted - actual) / actual;
console.log("  反解单价（元/百万 token）：input=" + priceIn.toFixed(4) + "  cacheRead=" + priceCache.toFixed(4) + "  output=" + priceOut.toFixed(4));
console.log("  拟合总价 ¥" + predicted.toFixed(2) + " vs 账本总价 ¥" + actual.toFixed(2) + "（偏差 " + (relErr * 100).toFixed(1) + "%）");

if (relErr > 0.25) {
  console.error("  偏差过大（>25%），不写文件：说明各天结构差异大或模型/折扣变化，请改用显式 prices.json。");
  process.exit(3);
}

const payload = {
  currency: "CNY",
  unit: "perMillionTokens",
  input: Number(priceIn.toFixed(4)),
  cacheRead: Number(priceCache.toFixed(4)),
  output: Number(priceOut.toFixed(4)),
  source: "fitted-from-explicit-ledger",
  fittedAt: new Date().toISOString(),
  days: rows.length,
  residualRel: Number(relErr.toFixed(4)),
  note: "由 tools/calibrate-prices.mjs 从 " + LEDGER + " 反解，为峰谷摊平后的平均价"
};

if (!WRITE) {
  console.log("\n  预览模式（没有写文件）。加 --write 写入：");
  console.log("    " + OUT);
  process.exit(0);
}
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n", "utf8");
console.log("\n  ✓ 已写入 " + OUT);
