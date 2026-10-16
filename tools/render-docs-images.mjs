#!/usr/bin/env node
// 渲染 docs/images 里的两张示意图（README 用）。
//
// 图里是**示例数字**，但版式与文案跟真实界面一致——特别是数据来源那一行
// （旧图还写着「来自 dsh-key-usage 的官方价目快照」，那是旧口径，必须跟着代码走）。
//
// 用法：
//   node tools/render-docs-images.mjs
//   EDGE=<可执行文件> node tools/render-docs-images.mjs
//
// 需要 Chromium 系浏览器（Edge / Chrome）截图；找不到就报错退出，不改任何文件。
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", "docs", "images");

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', sans-serif";
const TEXT = "#3b3b41";
const MUTED = "#8a8a90";
const BAR = "#6b6b73";

/** 与界面一致的示例数据（10/12 那根柱最短、10/13 最长）。 */
const DAYS = [
  ["10/12", 10, "¥0.42"],
  ["10/13", 330, "≈¥7.11"],
  ["10/14", 10, "¥0.35"],
  ["10/15", 34, "¥0.88"],
  ["10/16", 46, "≈¥1.23"]
];

function dayRow(date, width, amount) {
  return '      <div class="row"><span class="date">' + date + '</span>' +
    '<span class="bar" style="width:' + width + 'px"></span>' +
    '<span class="amount">' + amount + '</span></div>';
}

const STRIP_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; background: #ffffff; }
  body { font-family: ${FONT}; color: ${TEXT}; }
  .wrap { display: inline-flex; align-items: center; padding: 12px 14px; }
  .dock { display: inline-flex; align-items: center; gap: 10px; padding: 10px 18px; border-radius: 18px;
    border: 1px solid rgba(0,0,0,0.08); background: #fbfbfc; box-shadow: 0 1px 2px rgba(0,0,0,0.04);
    font-size: 28px; line-height: 34px; }
  .muted { color: ${MUTED}; font-size: 24px; }
</style></head>
<body><div class="wrap"><span class="dock">今日 ≈¥1.23 · 7 天 ≈¥8.40</span></div></body></html>`;

const PANEL_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; background: #ffffff; }
  body { font-family: ${FONT}; color: ${TEXT}; }
  .wrap { display: inline-block; padding: 12px; }
  .panel { width: 587px; box-sizing: border-box; padding: 16px 18px; border-radius: 16px;
    border: 1px solid rgba(0,0,0,0.10); background: #ffffff; box-shadow: 0 8px 24px rgba(0,0,0,0.12);
    font-size: 22px; line-height: 30px; }
  .head { color: ${MUTED}; margin-bottom: 10px; }
  .row { display: flex; align-items: center; gap: 12px; margin-bottom: 6px; }
  .date { width: 74px; color: ${MUTED}; }
  .bar { display: inline-block; height: 12px; border-radius: 6px; background: ${BAR}; opacity: 0.6; }
  .amount { margin-left: auto; }
  .sep { margin: 12px 0 0; padding-top: 10px; border-top: 1px solid rgba(0,0,0,0.12); }
  .title { color: ${MUTED}; margin-bottom: 4px; }
  .model { display: flex; }
  .model span { margin-left: auto; }
  .foot { color: ${MUTED}; font-size: 20px; line-height: 27px; }
</style></head>
<body><div class="wrap"><div class="panel">
  <div class="head">近 5 天（CNY）</div>
${DAYS.map(function (day) { return dayRow(day[0], day[1], day[2]); }).join("\n")}
  <div class="sep"><div class="title">按模型</div>
    <div class="model">deepseek-flash<span>≈¥8.40 · 4.1B tok</span></div></div>
  <div class="sep">
    <div class="foot">来自宿主会话服务（sessionPersistence，只读） · 12:34:56</div>
    <div class="foot">按模型单价（builtin）</div>
    <div class="foot">会话 20/20</div>
  </div>
</div></div></body></html>`;

function findBrowser() {
  const candidates = [
    process.env.EDGE,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "msedge",
    "google-chrome"
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate.indexOf("\\") !== -1 || candidate.indexOf("/") !== -1) {
      if (existsSync(candidate)) return candidate;
    } else {
      return candidate;
    }
  }
  return null;
}

const work = mkdtempSync(join(tmpdir(), "dsh-cost-strip-docs-"));
const stripHtml = join(work, "strip.html");
const panelHtml = join(work, "panel.html");
writeFileSync(stripHtml, STRIP_HTML, "utf8");
writeFileSync(panelHtml, PANEL_HTML, "utf8");

const browser = findBrowser();
if (browser === null) {
  console.error("没找到 Edge / Chrome：用 EDGE=<可执行文件> 指定后重跑。HTML 在 " + work);
  process.exit(2);
}
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const shots = [
  { html: stripHtml, out: join(OUT_DIR, "strip.png"), size: "620,74" },
  { html: panelHtml, out: join(OUT_DIR, "panel.png"), size: "640,470" }
];
for (const shot of shots) {
  const result = spawnSync(browser, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=2",
    "--window-size=" + shot.size,
    "--screenshot=" + shot.out,
    "file:///" + shot.html.replace(/\\/g, "/")
  ], { stdio: "inherit" });
  if (result.status !== 0) {
    console.error("渲染失败：" + shot.html + "（退出码 " + result.status + "）");
    process.exit(result.status === null ? 1 : result.status);
  }
  console.log("OK " + shot.out);
}
rmSync(work, { recursive: true, force: true });
