# dsh-cost-strip

给 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）用的一行消费显示：**输入框下方常驻「今日 ¥x.xx · 7 天 ¥y.yy」**，鼠标悬浮看近 7 天柱状图与按模型明细，点击强制刷新。

**纯本地只读、零联网、零凭据、零跨插件文件依赖。** 不读任何密钥，不发任何请求，也不去翻别的插件写下的文件——只从宿主提供的只读接口拿本机会话数据。

```
今日 ≈¥13.09 · 7 天 ≈¥88.76
```

![状态栏一行](docs/images/strip.png)

鼠标悬浮弹出近 7 天：

![悬浮面板](docs/images/panel.png)

> 上面两张是**示意图**（示例数字，由脚本渲染，不含任何真实账号数据）。真实界面里的位置是 `conversation.composer.dock`（输入框下方的状态带），紧跟官方的 token 用量之后。

## 安装

```bash
dsh plugin --profile desktop add dsh-cost-strip
# 其它 profile：dsh plugin --profile web add dsh-cost-strip
```

装完**完整退出 DSH 再重开**（宿主半边改了要重启进程；关窗口/刷新页面不算）。

桌面版 profile 若被 Electron 独占而拒绝命令行安装，用侧边栏 Plugins → Add plugin 填 `dsh-cost-strip`，或 `--profile web` 安装后重启 `dsh web`。

**兼容性**：已在 Windows 桌面版 DSH `0.2.0-rc.2` 上实测通过（宿主只读路由、输入框下方槽位注册、悬浮面板与数据来源标注均正常）。宿主需要 Node ≥ 22（用到内置 zstd 与 `sessionPersistence` 服务）。

## 数据从哪来

**会话数据**（按优先级两级，全都在本机）：

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1 | 宿主的 `ctx.sessionPersistence` 服务 | 官方只读 seam：`list()` 取每个已存会话的 header / revision / eventCount，`open(id, "read")` → `read(0)` 取事件流。存储格式、压缩布局与历史版本迁移都由宿主负责，插件不碰磁盘。 |
| 2 | `~/.dsh/sessions/**/session*.jsonl.zstd` | 宿主没挂会话服务时（老版本、精简装配）自己按帧解压：这些日志是**多帧拼接 zstd**，按魔数 `28 B5 2F FD` 逐帧切。 |

两条路径折出来的用量**与宿主自己的 token 投影同口径**（见下节）。7 天窗口只读窗口内改动过的会话，折叠结果按「元数据指纹 + 60 秒」缓存——宿主 `list()` 给的 revision 是它自己声明的**尽力而为**值，所以时间闸不能省。

服务路径还带三道对账，避免活跃会话在代际迁移/写入途中被漏算：

- 某个会话服务端一条用量都没给出 → 用**同一个会话**的持久日志补读；
- 某个会话压根不在宿主的会话列表里（宿主声明「不可读的 header 不参与发现」）→ 按它的持久日志读；
- 同一会话存在多代日志（`session.v3` / `session.v4`）时**只读最新一代**，同一条转录不会被算两遍。

悬浮面板会显示「会话 x/y · 磁盘补读 n」，哪条路在起作用一眼可见。

**计价**（同样两级）：

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1 | `~/.dsh/dsh-cost-strip/prices.json` | 你自己写的覆盖：可以只覆盖某几个模型，也可以给一张整表单价 |
| 2 | 随包 `data/prices.json` | DeepSeek 官方 CNY 价目（api-docs.deepseek.com 中文页）+ 错峰窗口。当前收录 `deepseek-flash` / `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` / `deepseek-v4-pro` |
| 3 | 表里没有的模型 | **只计 token 不计钱**，并在悬浮窗里点名说明（不拿别的模型的价格顶替） |

金额一律带 `≈`：它是「token × 价目」的折算值，不是平台账单。

## 用量口径

折叠规则跟宿主 token 投影一致，这也是数字能与官方账单对上的原因：

1. **用量样本**搭载在三种事件上：`assistant/chunk`（`data.chunk.type === "usage"`）、`assistant/message`（`data.usage`）、`assistant/attempt`（`data.stream[].chunk.usage`）。只认 `assistant/message` 的写法会漏掉流式上报。
2. **同一 `(turn, step)` 的重复上报「后到覆盖先到」**，不重复计费；`llm/retry-started` 会开启新的尝试槽，新尝试与原尝试**累加**。
3. **模型归属**取 `data.message.source`，缺失时回落最近一次 `request/header` 的 `data.header.config`；都判不出来记 `unknown/unknown`（按默认价计并如实说明）。
4. **分日按本地日历**（宿主 token 投影的口径），不写死时区。
5. 错峰按**每一笔样本的时间**判定：高峰为北京时间周一至周五（不含中国法定节假日）09:00–12:00 与 14:00–18:00，其余时段（含周末全天）为谷价 = 峰价 × 0.5。

> 对账记录（2026-10-16）：同一台机器上，本插件折出的各日 token 与官方账本逐日**完全相同**；金额在 4 个有账本的样本日里，3 天相对偏差 < 0.001%（09-30、10-01、10-03），第 4 天（10-02）差异来自账本自身覆盖不全（账本 264 次调用 vs 会话日志 321 次）。

## 计价与校准

```bash
# 打印当前生效的价目表 + 近 7 天自检
node tools/calibrate-prices.mjs

# 用**你自己指定**的账本反解单价（预览）；账本路径必须显式给，工具不猜任何插件的存放位置
node tools/calibrate-prices.mjs --ledger D:\path\to\ledger.json
# 确认后写入 ~/.dsh/dsh-cost-strip/prices.json
node tools/calibrate-prices.mjs --ledger D:\path\to\ledger.json --write
```

账本格式：`{ "days": { "2026-10-01": { "provider": { "model": { inputTokens, cacheReadTokens, outputTokens, cost } } } } }`（≥3 天，拟合偏差 >25% 不采信）。

按模型覆盖单价（推荐，错峰窗口沿用随包表）：

```jsonc
{
  "models": {
    "deepseek-official/deepseek-flash": { "input": 2, "cacheRead": 0.04, "cacheWrite": 2, "output": 8 }
  },
  "default": { "input": 2, "cacheRead": 0.04, "cacheWrite": 2, "output": 8 },  // 可选：模型归属缺失时用
  "holidays": ["2026-10-01", "2026-10-02"]                                     // 可选：这些日期按谷价
}
```

旧的「整表单价」写法继续支持（所有模型同一价）：

```jsonc
{
  "currency": "CNY",
  "input": 2.0, "cacheRead": 0.5, "output": 8.0,
  "peakRule": { "windows": [[9, 12], [14, 18]], "weekdaysOnly": true, "offPeakFactor": 0.5, "holidays": [] }
}
```

`peakRule` 的 `windows` 是 `[起始小时, 结束小时]` 对；没有 `peakRule` 时按统一单价计。

## 已知限制

- **节假日表不内置**：法定节假日按谷价这条要你自己在 `holidays` 里维护，否则算成峰价（方向：金额偏高）。
- **价目表会过期**：随包表是 2026-10-13 抓的官方价。调价后要么等插件更新，要么自己写 `prices.json`。
- **宿主会话服务的元数据是「尽力而为」的**：正在写入的会话可能 revision 不动、事件却在长，插件因此最多 60 秒重读一次；服务端的当前逻辑视图与磁盘日志不一致时，按上面的三道对账规则为准。
- **回退路径的解析假设**：会话服务不可用时，解析假设文件名 `session(.<vN>)?\.jsonl\.zstd`、多帧 zstd、事件形状如上。DSH 换版本后请先跑 `npm test`。
- 多帧切帧靠魔数 `28 B5 2F FD`：理论上压缩数据里恰好出现该四字节会把一帧切坏（该帧被跳过）。实测 86 个真实会话文件无此情况。
- 反解单价是**平均值**，把峰谷/模型/折扣都摊平了；要精确请按模型显式给 `prices.json`。
- **不含「官方全账号」口径**（所有 agent 合计的真实账单）：那需要平台令牌，属于 [dsh-key-usage](https://github.com/xyl886/dsh-key-usage) / 官方页面的范围。本插件刻意不碰凭据。

## 设计要点（踩过的坑，供同类插件参考）

1. **读会话的首选姿势是宿主服务，不是自己解压文件**：`ctx.get("sessionPersistence")` → `list()` / `open(id,"read")` → `handle.read(0)`。历史格式迁移与压缩布局都由宿主负责，插件自己解 zstd 只适合当回退。
2. **`open(id, "read")` 与随后的 `read(0)` 之间，宿主有容量 2 的解析 memo**：2 路并发正好把两次「找路径 + 读文件」的等待叠起来；3 路反而会把先到的会话挤出 memo，逼它整段重解压。
3. **会话文件名是 `session.v4.jsonl.zstd`**（还有 v3 / 无版本号的历史名）。只匹配 `session.jsonl.zstd` 的实现会一个文件都扫不到，且**静默**返回空。
4. **会话日志是多帧拼接 zstd**：一个文件里有成百上千个帧，每帧以 `28 B5 2F FD` 开头。用 `zstdDecompressSync` 必须逐帧切；不要依赖外部 `zstd` 可执行文件（多数 Windows 机器没有）。
5. **`inheritedEventCount` 是「不算用量」的前缀**：子代理会话会带上父会话的历史事件，折用量时要跳过；但其中的 `request/header` 仍要留着建立模型归属。
6. **客户端槽位**：输入框下方那条状态带是 `conversation.composer.dock`（list 槽）；`conversation.composer.bar` 是输入框本体（single 槽，核心已注册），往那里注册会冲突。
7. **`peerDependencies` 不要钉 `@deepseek-ai/dsh-client-*` 的旧版本**：DSH 的插件安装有兼容性护栏，钉 `^0.1.0-rc.x` 而宿主是 `0.2.x` 会直接被拒（本插件只声明 `@deepseek-ai/cordis`，把兼容性交给宿主判断）。

## 开发与测试

```bash
npm test        # 85 项离线断言：三种用量事件形状、去重与重试槽、本地日历分日、峰谷窗口、多帧 zstd、
                #             宿主会话服务（假实现）、缓存时间闸、磁盘补读与代际选择、价目解析、成本聚合、路由装配
```

测试不需要 DSH、不需要网络：自己造会话日志、假 `sessionPersistence` 与价目（`DSH_HOME` 指向临时目录）。

目录：

```
lib/index.js               宿主：读宿主会话服务 / 回退解会话日志 / 折叠用量 / 计价 / 一个只读路由
lib/client.js              界面：注册进 conversation.composer.dock
data/prices.json           随包的官方价目表（CNY + 错峰窗口）
tools/calibrate-prices.mjs 价目自检 / 用显式账本反解单价
tools/render-docs-images.mjs 重渲染 README 的两张示意图（Edge/Chrome 无头截图）
test/run-tests.mjs         离线测试
```

## 与同类插件的关系

- [dsh-key-usage](https://github.com/xyl886/dsh-key-usage)：侧边栏「使用情况」大面板（明细/热力图/项目/会话/官方余额）。两者**口径一致**（都按宿主 token 投影折叠会话、都按官方价目计价），但各读各的：本插件不依赖它，也不需要它装着才能算钱。
- `dsh-balance-status` / `dsh-session-cost` 等：同样是底栏消费显示。本插件从零实现（未复制其代码），差异是「零凭据 + 官方价目随包 + 错峰计时 + 只算能算钱的模型」；它们有的依赖平台令牌或写死单价。
- 本插件与上述项目无隶属关系。

## 许可

[MIT](./LICENSE)
