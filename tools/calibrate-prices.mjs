#!/usr/bin/env node
// 用**你自己账号的官方账本**反解单价，写进 ~/.dsh/dsh-cost-strip/prices.json。
//
// 为什么需要它：dsh-cost-strip 在没装 dsh-key-usage 时，要用单价把 token 换成钱。
// 硬编码一份价目表迟早过期，而 DSH 自己的账本 ~/.dsh/dsh-usage/usage-ledger.json
// 里同时有「当天各类 token 数」和「当天官方消费」，正好可以三参数最小二乘反解出
// input / cacheRead / output 三个单价。
//
// 口径提醒：反解出来的是**平均价**（把峰谷、模型差异、折扣都摊平了）。如果你要
// 严格峰谷计价，自己写 prices.json 并带 peakRule（见 README）。
//
// 用法：node tools/calibrate-prices.mjs [--write]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const LEDGER = join(DSH_HOME, "dsh-usage", "usage-ledger.json");
const OUT_DIR = join(DSH_HOME, "dsh-cost-strip");
const OUT = join(OUT_DIR, "prices.json");
const WRITE = process.argv.includes("--write");

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function loadRows() {
  let ledger;
  try {
    ledger = JSON.parse(readFileSync(LEDGER, "utf8"));
  } catch (error) {
    console.error(`读不到账本 ${LEDGER}：${error.message}`);
    process.exit(2);
  }
  const rows = [];
  for (const [date, provs] of Object.entries(ledger.days || {})) {
    let input = 0;
    let cacheRead = 0;
    let output = 0;
    let cost = 0;
    for (const p of Object.values(provs || {})) {
      for (const m of Object.values(p || {})) {
        input += num(m.inputTokens);
        cacheRead += num(m.cacheReadTokens);
        output += num(m.outputTokens);
        cost += num(m.cost);
      }
    }
    if (cost > 0 && input + cacheRead + output > 0) rows.push({ date, input, cacheRead, output, cost });
  }
  return rows.sort((a, b) => (a.date < b.date ? -1 : 1));
}

function solve3(M, v) {
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
  return [0, 1, 2].map((r) => inv[r][0] * v[0] + inv[r][1] * v[1] + inv[r][2] * v[2]);
}

const rows = loadRows();
if (rows.length < 3) {
  console.error(`账本里只有 ${rows.length} 天带消费的样本，至少需要 3 天（越多越准）。`);
  process.exit(2);
}

const M = [
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0]
];
const v = [0, 0, 0];
for (const r of rows) {
  const a = [r.input / 1e6, r.cacheRead / 1e6, r.output / 1e6];
  for (let p = 0; p < 3; p++) {
    v[p] += a[p] * r.cost;
    for (let q = 0; q < 3; q++) M[p][q] += a[p] * a[q];
  }
}
const prices = solve3(M, v);
if (!prices || prices.some((x) => !Number.isFinite(x) || x < 0)) {
  console.error("反解失败（矩阵退化或出现负单价）——样本太少或各天 token 结构太相似。");
  process.exit(2);
}

const [pIn, pCache, pOut] = prices;
let pred = 0;
let actual = 0;
console.log(`  样本 ${rows.length} 天（${rows[0].date} … ${rows[rows.length - 1].date}）`);
console.log("  日期        输入(M)   缓存读(M)  输出(M)   官方¥    拟合¥");
for (const r of rows) {
  const p = (r.input / 1e6) * pIn + (r.cacheRead / 1e6) * pCache + (r.output / 1e6) * pOut;
  pred += p;
  actual += r.cost;
  console.log(
    `  ${r.date}  ${(r.input / 1e6).toFixed(2).padStart(8)}  ${(r.cacheRead / 1e6).toFixed(1).padStart(9)}  ${(r.output / 1e6).toFixed(2).padStart(7)}  ${r.cost.toFixed(2).padStart(7)}  ${p.toFixed(2).padStart(7)}`
  );
}
const relErr = Math.abs(pred - actual) / actual;
console.log(`  反解单价（元/百万 token）：input=${pIn.toFixed(4)}  cacheRead=${pCache.toFixed(4)}  output=${pOut.toFixed(4)}`);
console.log(`  拟合总价 ¥${pred.toFixed(2)} vs 官方总价 ¥${actual.toFixed(2)}（偏差 ${(relErr * 100).toFixed(1)}%）`);

if (relErr > 0.25) {
  console.error("  偏差过大（>25%），不写文件：说明各天结构差异大或模型/折扣变化，请改用显式 prices.json。");
  process.exit(3);
}

const payload = {
  currency: "CNY",
  unit: "perMillionTokens",
  input: Number(pIn.toFixed(4)),
  cacheRead: Number(pCache.toFixed(4)),
  output: Number(pOut.toFixed(4)),
  source: "fitted-from-ledger",
  fittedAt: new Date().toISOString(),
  days: rows.length,
  residualRel: Number(relErr.toFixed(4)),
  note: "由 tools/calibrate-prices.mjs 从 ~/.dsh/dsh-usage/usage-ledger.json 反解，为峰谷摊平后的平均价"
};

if (!WRITE) {
  console.log("\n  预览模式（没有写文件）。加 --write 写入：");
  console.log(`    ${OUT}`);
  process.exit(0);
}
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(`\n  ✓ 已写入 ${OUT}`);
