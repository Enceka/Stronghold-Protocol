# 可自定义 AI：分析与最小通用方案

## 现有机制

项目有两种不同的 AI。`server/sim/ai.js` 负责单位在战斗中的索敌、移动和攻击；战斗本身是自动进行的。玩家层 AI 在 `server/match/bot.js`，由 `Match` 在确认信息、策略选择、机变选择和休整期调度。机器人通过与玩家相同的 `PlayerState` 方法购物、升级、出售、装备、布阵及准备。

玩家层已经具备较强的启发式：按初始生命和可用羁绊选择策略，按收益与风险评价悬赏，保留合成对子，选择主副羁绊及阵容，处理经济特质，按实际敌人路线、攻击范围与朝向布阵，并用真实 `Battle` 排演几个候选布局。随机源按 setup/shop/waves/draft/bots/meta 分开；虚拟调度器和 `tools/matchrun.mjs` 已能重复执行整局游戏。它并非强化学习模型，也没有远程大模型服务。

当前主要限制是策略依赖可变的 Match/PlayerState 对象，没有稳定的用户策略接口；推荐与托管无法复用统一输出；排演主要优化当回合布局，没有对购物、策略选择及未知随机事件做通用前瞻。

## 最小接口与实施方案

沿用已有引擎，增加 `server/ai` 适配层，不另写游戏规则：

1. **Observation**：版本化、可 JSON 序列化的公共状态与本座位私有状态，以及当前可见地图；不向策略提供服务器种子、随机数状态、其他玩家的手牌或商店。
2. **Action**：直接返回现有 `g.*` 决策指令；`null` 表示委托现有机器人完成当前阶段。推荐与自动执行使用同一结果。提供合法动作枚举和动作检查，最终执行仍通过原处理器验证。
3. **Policy**：`decide(context)` 可读取 observation、保存座位独立 memory、调用 baseline、枚举动作和评估候选。默认机器人不变。JSON 配置提供偏好与搜索参数；本地 ES module 提供完整自定义能力。
4. **Forward model**：仅在玩家决策阶段创建隔离副本，重新连接玩家、共享卡池、效果分发器与虚拟调度器。副本没有真实网络回调或遗留计时器。合法性检查、推荐及推演均不得修改原局。
5. **随机搜索**：保留已揭示的地图、禁用羁绊、当前商店和敌人，给未来 shop/waves/draft/meta/battle 重新采样。用相同样本比较候选动作，随后委托 baseline 继续游戏。支持有限回合或直到结束的 rollout，报告实际采样数和预算截断；不能把服务器真实未来当作已知信息。
6. **玩家入口**：游戏内 AI 助手提供下一步推荐、手动执行、JSON 配置与托管。推荐带状态标识，状态变化后不能继续执行过期建议；旁观者无此权限。
7. **离线入口**：多种子评测支持 baseline、search 和自定义模块，输出胜率、存活回合、耗时、引擎错误及审计结果；失败的策略或非法动作回退 baseline，防止无限循环。

## 最优解的边界

未知商店、敌人、随机战斗及多人决策使问题成为随机的序贯决策问题。全局最优需要明确目标、完整状态/信念模型和远超过实时游戏预算的计算。此补丁的最高能力是可扩展、可复现的有限预算前瞻，不能保证所有随机局通关或证明全局最优。

默认目标优先通关、存活和推进回合，再考虑生命、羁绊层数及经济；权重允许用户调整。近期搜索只能改善它实际比较过的候选，baseline continuation 也会带来偏差。完整动作空间尤其布阵很大，在线搜索先使用少量候选；自定义模块可以扩展动作生成、beam/MCTS、风险目标或训练算法。

## 验收

- 默认机器人回归测试通过，未配置 AI 时保留原行为。
- 推荐、合法动作检查及 rollout 不改变原局、卡池、计时器、消息和 RNG。
- 合法动作涵盖策略、机变、奖励、购物、装备、移动与朝向；非法指令仍被拒绝。
- 未知随机事件按样本变化，同一样本确定性可复现；预算到达后结果明确标注未完成。
- 自定义策略可自动执行完整游戏，异常、非法动作或过多动作能回退；托管关闭后停止执行。
- 提供至少一个用户策略示例和多种子真实战斗评测，记录能力与性能限制。

## 已实现的使用入口

进入游戏后点击右上方「AI 助手」。可以获取下一步建议，阅读动作及理由，再点击「执行这一步」。推荐不会直接改变游戏；执行时服务器重新核对状态和原规则。自己的操作、策略轮次变化或队友布阵变化都会使旧建议失效。托管可通过「按当前配置托管」启动，通过现有「返回模拟」停止。

「设计 AI：偏好与搜索配置」允许编辑 JSON，保存并应用到本局；浏览器保留配置草稿，下局需要再点保存应用。提供三种策略：

- `builtin`：原来的机器人，包括其真实战斗布局排演。
- `preferences`：优先选择 `preferredBands` 中可用的策略、购买 `preferredChess` 中可买的干员，其余委托原机器人；偏好顺序按数组先后。
- `search`：先处理显式偏好，再比较 baseline 及少量选策略、机变、奖励、购物、升级或刷新动作。每阶段搜索一次，之后让原机器人完成整备与布局。

配置示例见 `examples/ai/preferences.json` 和 `examples/ai/search.json`。ID 来自 `data/bands.json` 的 `bandId` 与 `data/chess.json` 的 `chessId`，干员偏好使用普通版本 ID。界面会拒绝无效 JSON，服务器会拒绝未知 ID。

```json
{
  "policy": "search",
  "preferredBands": [],
  "preferredChess": [],
  "weights": { "victory": 100000, "survival": 10000, "rounds": 1000, "lp": 10, "layers": 0.1, "funds": 1 },
  "search": { "candidates": 3, "samples": 2, "rounds": 1, "budgetMs": 200 }
}
```

搜索参数范围：`candidates` 1–16，`samples` 1–16，`rounds` 1–32，`budgetMs` 10–2000。在线默认 200 ms；评测示例为 1000 ms。32 回合的 horizon 可以把当前决策推演到游戏结束，但会更容易耗尽预算。权重均需非负，最大 1e6；这里是加权目标，不是严格的字典序最优。

## 自定义 JavaScript 策略

本地 ES module 导出 `decide(context)` 或默认函数。策略输出一个现有决策指令，也可以输出 `{ action, reason }`，返回 `null` 就交还原机器人。支持同步生成器，以便较长的搜索主动 `yield`。示例 `examples/ai/my-policy.mjs` 优先选可用策略中初始生命最高的一个，其余沿用现有机器人。

```js
export function decide({ observation, actions, memory }) {
  if (observation.public.phase !== 'PREP') return null;
  if (memory.lastRound === observation.public.round) return null;
  memory.lastRound = observation.public.round;
  return actions({ placements: false }).find(a => a.t === 'g.levelUp') || null;
}
```

`context` 接口：

| 成员 | 用途 |
|---|---|
| `observation` | 冻结的 JSON：`version`、`public`、`self`、可侦察的 `teammates` 棋盘、`map`、`stateKey`、`modelKey` |
| `config` | 本座位冻结的 JSON 配置 |
| `memory` | 座位独立的持久记忆；使用可 JSON 序列化的值。推荐使用其副本，不影响托管记忆 |
| `baseline()` | 原机器人在当前状态建议的下一条指令；不修改原局 |
| `actions({ placements })` | 所有通过现有处理器校验的普通决策指令；默认包含布阵、朝向、交换、装备替换和画卷，`false` 可减少枚举成本 |
| `test(action)` | 在副本中校验一个动作，返回 `{ok:true}` 或 `{error,detail}` |
| `record(kind,id)` | 游戏静态数据的副本，例如 `record('chess', id)`、`record('bands', id)` |
| `evaluate(actionOrPlan, options)` | 同步推演单动作或动作序列，然后委托 baseline 继续；建议只用于离线计算 |
| `evaluateSteps(actionOrPlan, options)` | 相同推演的生成器接口，在线策略应优先 `yield*` 该接口 |

评估选项为 `{ sampleSeed, rounds, weights, maxSteps, deadline }`。`deadline` 是 `performance.now()` 时钟上的绝对时间。返回 `{ complete, score, round, alive, victory, errors, sampleSeed }`；非法计划额外返回 `error` 和失败动作的 `index`。到达预算、步骤上限或调度队列未能继续时，`complete:false, score:null`，不能拿这个未完成的分数和完成推演比较。固定样本、足够预算下结果可复现；按墙钟预算中止时完成样本数可能随机器负载变化。

通用模型实现位于 `server/ai/model.js`：`observe`、`forkDecision`、`applyAIAction`、`legalActions`、`rolloutSteps`、`evaluateAction`。其中 `forkDecision` / `applyAIAction` 可用于离线构建分支搜索环境。副本复用 Match、PlayerState、共享卡池及真实 Battle 的规则，不支持在已经进行的战斗中创建决策快照。它跳过实例上的调试/审计方法包装器，避免闭包把推演计入真实对局。

在线接入本地模块时可以编写自己的启动入口：

```js
import { startServer } from './server/index.js';
import { decide } from './examples/ai/my-policy.mjs';
await startServer({ port: 3000, aiPolicy: decide });
```

服务端安装的 `aiPolicy` 优先于 JSON 策略，对由它控制的所有座位生效，可按 `observation.self.playerId` 分流。浏览器的 JSON 配置不运行 JavaScript。自定义模块是本地可信代码；副本提供游戏状态隔离，不是任意代码的安全沙箱。同步函数必须有界，生成器应定期让出执行；无法抢占一个永不返回的同步函数。生成器每次决策默认最多 2000 ms（可用 `config.search.budgetMs` 缩短）、最多 100000 次 yield。每个休整期最多执行 32 条自定义动作，超预算、无进展、异常或非法指令会退回 baseline。

## 随机前瞻的实际行为

保留当前可见商店、已选策略、已揭示敌人/地图/禁用项；未来商店、机变、波次、效果和战斗随机数全部由采样种子决定。内置搜索种子来自可见状态哈希和样本编号，不读取真实 RNG 的未来。候选使用共同随机样本；只有所有候选均完成的一整组样本才参与排名，预算不足时采用 baseline。后续的 baseline 不再嵌套搜索，并关闭布局排演来降低成本；真正执行时仍保留玩家原有的布局排演设置。

多人推演保留可侦察的棋盘，移除其他座位不可见的手牌、奖励和商店，按当前回合基础收入估计资金并重新抽店；这是简化的队友状态模型，不是完整的贝叶斯信念模型。队友的战术行为、可见效果之外的历史计数等仍不能被精确预测。未来波次的抽取及合作联防仍使用原引擎。

驱动器约每 8 ms 让出事件循环，取消托管/过期阶段会关闭生成器和副本。预算在虚拟回调之间检查，不是严格的 CPU 抢占上限；一次原子游戏操作可能略超预算。`g.advice` 每座位最多每秒一次。推荐状态标识忽略传输消息类型和时钟；服务端另外检查包含队友棋盘的 `modelKey`，客户端尚未看见队友变化时也不能执行过期建议。

## 离线评测与复现

```sh
# 原机器人
node tools/matchrun.mjs --mode solo --difficulty ALL --seed 1 --seeds 5 --rehearsal 3 --ai builtin --check --json
# JSON 搜索配置
node tools/matchrun.mjs --mode solo --difficulty ALL --seed 1 --seeds 5 --rehearsal 3 --ai-config examples/ai/search.json --check --json
# 用户模块
node tools/matchrun.mjs --mode solo --difficulty ALL --seed 1 --seeds 5 --rehearsal 3 --ai examples/ai/my-policy.mjs --check --json
# 合作局、人类座位托管路径
node tools/matchrun.mjs --mode coop --difficulty HARD --players 2 --humans 1 --seeds 3 --ai search --check
```

`--json` 的 stdout 是完整 JSON，审计/错误/概率说明写 stderr，方便重定向或训练脚本读取。记录包含胜负、存活回合、每回合状态、`ms`、`aiFailures`、`aiSearch`（决策数、完整样本数、实际评估次数、预算中止次数）及审计异常。

2026-10-05 的真实战斗对比：独立模拟、每难度种子 1–5、默认 tuning/full 内容、实际执行排演 3 个布局，无生命或层数加成。搜索使用示例配置（候选 3、样本 2、horizon 1、预算 1000 ms）。逐种子结果保存在 `docs/ai-benchmark.json`。

| 难度 | baseline 通关 / 平均回合 | 用户示例通关 / 平均回合 | search 通关 / 平均回合 |
|---|---|---|---|
| 标准 FUNNY | 5/5 · 9.00 | 5/5 · 9.00 | 5/5 · 9.00 |
| 险境 NORMAL | 5/5 · 14.00 | 5/5 · 14.00 | 5/5 · 14.00 |
| 绝境 HARD | 4/5 · 13.80 | 3/5 · 13.60 | 4/5 · 13.80 |
| 终极 ABYSS | 0/5 · 11.40 | 0/5 · 12.00 | 1/5 · 12.80 |

60 局引擎、效果、战斗错误和审计异常均为 0。search 每局约 1.7–4.5 秒，baseline 约 0.5–1.3 秒；耗时随设备和负载变化。这是接口可用性与小样本能力验证，不能据此声称搜索稳定优于 baseline。真正优化通关率应扩大种子集、固定训练/验证集，调整 horizon、候选生成与目标，特别检验尾部风险及多人协作。

验证命令：

```sh
node --test test/match/ai.test.js test/ui/aiAssistant.test.js test/match/fuzz.test.js
SP_E2E=1 node --test test/ui/ai.e2e.test.js
npm test
```

新增测试覆盖原局与 RNG 不变、审计隔离、随机样本复现、全局通关推演、动作合法性、协议配置、过期建议（包括队友同羁绊换位）、托管取消、异常回退、默认结果一致与真实整局；浏览器测试使用隔离的 headless Chrome 或已安装 Firefox，覆盖建议、执行、JSON 保存、托管和手机尺寸可读性。全量测试中本地 `public/assets` 缺少部分清单素材，使既有 `test/assets.test.js` 的文件完整性断言失败；此补丁没有修改素材清单或绕过该检查。
