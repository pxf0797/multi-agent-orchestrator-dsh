# DSH Multi-Agent Orchestrator

> 把复杂目标拆成 **DAG 任务图** → 按依赖波次并行派发子 Agent → 产物落盘 → 独立验收 → 汇总交付。
> 面向 [DeepSeek Harness](https://github.com/deepseek-ai) 的编排 skill：带**断点续跑**、**验证即任务**、**产物存在性校验**。

[![selfcheck](https://github.com/pxf0797/multi-agent-orchestrator-dsh/actions/workflows/selfcheck.yml/badge.svg)](https://github.com/pxf0797/multi-agent-orchestrator-dsh/actions/workflows/selfcheck.yml)

---

## 这是什么

一个**调度协议**，不是一个工具。加载后，Agent 变成 Coordinator：只做拆解、调度、验收、缝合，具体活交给子 Agent。

它解决的是「多 Agent 编排」最常见的四种烂尾：

| 常见烂尾 | 这里的解法 |
|---|---|
| 为显得专业而编排，1-2 件事开 5 个 agent | 三道门禁，明确说「不要编排」 |
| 子 agent 说"完成了"，产物其实是空的 | 每波结束先 `glob` 校验产物，缺失直接判 `failed` |
| 上下文被 5 个 agent 的正文挤爆 | 返回 ≤8 行摘要，正文一律落盘 |
| 跑到一半断了，只能从头再来 | checkpoint JSON + 恢复协议，已 done 的不重派 |

## 安装

```bash
git clone https://github.com/pxf0797/multi-agent-orchestrator-dsh.git \
  ~/.dsh/skills/multi-agent-orchestrator
```

目录名建议保持 `multi-agent-orchestrator`（与 SKILL.md 的 `name` 一致，`/name` 唤起才无歧义）。

也可做成项目级 skill，优先级更高（rank 100）：

```bash
git clone https://github.com/pxf0797/multi-agent-orchestrator-dsh.git \
  <your-project>/.dsh/skills/multi-agent-orchestrator
```

装完即可用，无需重启会话。

## 使用

| 方式 | 写法 |
|---|---|
| 显式唤起 | `/multi-agent-orchestrator`（token 必须精确等于 skill 名） |
| 短名 | `/orch`（由配套的 `orch` 别名 skill 提供） |
| 自动触发 | "并行调研 X"、"多角度审计这个仓库"、"继续跑上次的编排" |
| 不该用 | 一两件事、一个 agent 顺读一遍就能做完、本质串行的一条线 |

典型开场：

```
用编排帮我把这份代码库的鉴权模块审一遍：分层、越权、令牌生命周期三个角度，
每个角度给证据，最后合成一份带风险定级的报告。
```

Agent 会先过门禁（该不该编排、用 `wave` 还是 `workflow`），再拆 3-10 个任务、落盘计划与 checkpoint，然后按波次派发。

## 它怎么工作

```
① 场景识别 → ② DAG 设计 → ③ 落盘计划 → ④ 波次派发 → ⑤ 汇总交付
                                    ↑______________|
                                   失败/续跑时回到 ④
```

```
wave 0   T1  提取目标与约束（inline）
wave 1   T2  T3  T4  T5      并行分支（subagent / workflow 扇出）
wave 2   T2v T3v T4v T5v     各自的 verifier（天然落在下一波）
wave 3   T6  合成（inline，父级自己写，blockedBy 所有 verifier）
```

波次之间是**硬屏障**：下一波只能读上一波的产物。没有「软依赖」「合流」「边跑边等」——想说"要参考 T2 的方案"，就老实写 `blockedBy: ["T2"]`。

### 四个设计赌注

1. **文件即信道** — 子 agent 只回 ≤8 行摘要，正文落盘到 `.dsh/orchestrator/output/<orchId>/`。同时解决"上下文爆炸"和"下游要读全文"。
2. **波次即调度** — 用确定性屏障替代事件循环。DSH 里 `workflow` 的子 agent 结果根本不回父级，事件驱动本来就不成立。
3. **验证即任务** — `verify` 只是声明，真正执行验证的是另一条有 id、有 `blockedBy`、占一个波次的 verifier 任务。所以验证能**阻断**交付。
4. **checkpoint 即唯一真源** — `todo_write` 是纯展示层，禁止反向同步。

第 4 个赌注里有个关键细节：**`status`（执行）与 `verdict`（判定）是两个轴**。verifier "判定不通过"时自己是 `done`、不触发失败传播，只让被验任务 `returns += 1`。否则 Strict 验证的「≥2 通过」会被自身传播规则吃掉。

## 目录结构

```
.
├── SKILL.md                       # 门禁 + 五阶段 + 反模式（常驻加载）
├── references/                    # 按需读，不一次全读
│   ├── dag-schema.md              # 任务字段、波次公式、dispatch 选择
│   ├── checkpoint-protocol.md     # 状态机、七次写入、恢复流程
│   ├── verification-levels.md     # 5 级验证、verdict 语义
│   ├── workflow-recipes.md        # R1-R6 可复制脚本
│   ├── scenario-dags.md           # 4 场景默认形状
│   ├── role-templates.md          # 11 个角色的身份段与验收清单
│   └── cc-to-dsh-mapping.md       # 与上游 Claude Code 版的逐项差异
├── templates/checkpoint.example.json
├── tools/
│   ├── selfcheck.mjs              # 8 项结构自检（文档 / 模板）
│   └── validate-checkpoint.mjs    # 运行时校验一份真实 checkpoint
├── test/validate.test.mjs         # validator 的 9 个正负例
└── docs/review-v1.2.0.md          # v1.2.0 评审：已核实事实 + 待修问题
```

运行时产物（建议写进业务仓库的 `.gitignore`）：

```
<workspace>/.dsh/orchestrator/
├── checkpoints/<orchId>.json   # 状态唯一真源
├── plans/<orchId>.md           # 每个任务的完整 prompt
└── output/<orchId>/            # 子 agent 的完整产物 + final-report.md
```

## 自检与校验

两套检查，分工不同：`selfcheck` 查**文档/模板**结构，`validate-checkpoint` 查**跑起来的编排状态**。

```bash
npm test                        # = selfcheck + validator 的 9 个用例
node tools/selfcheck.mjs        # 只查结构自洽

node tools/validate-checkpoint.mjs .dsh/orchestrator/checkpoints/<orchId>.json
```

`selfcheck` 查 8 项：waves 公式、`plan`/`output` 路径基准、枚举闭合、任务数与角色池、verifier 展开、文件引用、SKILL.md 字符预算、以及文档里声明的项数是否与实际一致。

`validate-checkpoint` 查的是真实状态：waves 能否从 `blockedBy` 重算、done 任务的产物是否真存在（空文件也算错）、`standard`/`strict` 的 verifier 是否真的展开且 `blockedBy` 指回被验任务、失败是否按协议传播、`attempts`/`summary`/`verdict` 是否自洽。它还管四件"只有跑过才知道会漏"的事：

- `counted` 三档必须守恒（`pass + fail + unverifiable = total`），且与 `summary` 里的数字一致
- `returns > 0` 必须有 `previous_outputs`——被 verifier 否掉的那一版不能覆盖丢失
- `verdict = fail` 必须真的触发返工（被验任务的 `returns ≥ 1`）
- `verdict = pass` 但带着 blocker/major 时，提示改标 `pass_with_issues`

`--fix-waves` 可以直接把重算结果写回文件，省掉手工改 JSON。`schema_version: 1` 的老编排只告警、不判错；新建编排请用 `2`。

| 退出码 | 含义 |
|---|---|
| `0` | 通过（可能有警告，例如 goal 还是模板占位符） |
| `1` | 有错误，逐条列出 |
| `2` | 用法错误 / JSON 解析失败 |

选项：`--root <workspace>` 指定工作区根（**默认从 checkpoint 路径反推**，推不出才用当前目录）、`--no-files` 跳过文件存在性、`--fix-waves` 回写 waves、`--json` 输出机器可读结果。

## 已在运行时核实的事实

在 DSH `0.2.1-rc.2` 上逐条核对过（`app.asar` 源码 + 实际调用）：

| 事实 | 值 | 对编排的含义 |
|---|---|---|
| `maxParallelToolCalls` | `10` | 同波 >10 个 subagent 会排队，不会失败 |
| `maxConcurrentAgents` | `0` → 按 CPU 并行度 | 别假设固定并发 |
| `maxTotalAgents` | `1000` | 超限 → 脚本级 fatal，整段重来 |
| `maxItemsPerCall` | `4096` | `parallel()`/`pipeline()` 单次条目上限 |
| `agent()` 失败 | 兑现 `null`，不抛异常 | 每个 stage 后必须 `filter(Boolean)` |
| `subagent` 的 model 参数 | 无 | 只有 workflow 的 `agent()` 能按调用分档 |

## 与兄弟版本的关系

| 仓库 | 平台 | 调度方式 |
|---|---|---|
| [multi-agent-orchestrator-skill](https://github.com/pxf0797/multi-agent-orchestrator-skill) | Claude Code | 后台 Agent + Task 实体 + Agent Teams |
| [multi-agent-orchestrator-codex](https://github.com/pxf0797/multi-agent-orchestrator-codex) | Codex CLI | Codex 原生子 Agent |
| **本项目** | **DeepSeek Harness** | **波次屏障 + checkpoint JSON + workflow 脚本** |

DSH 版不是照搬：上游的调度循环建立在「后台完成通知驱动 turn」「Task 实体 ↔ JSON 双写」「PID 判活」三根柱子上，DSH 一根都没有。逐项处置（39 个平台耦合点）见 [references/cc-to-dsh-mapping.md](references/cc-to-dsh-mapping.md)。DSH 上此前还有一个 workflow-first 的 `orchestrate` skill，其可用内容（判决 schema、PRE 前置、重试预算、成本护栏）已并入本项目，该 skill 已下线。

## 已知限制

见 [docs/review-v1.2.0.md](docs/review-v1.2.0.md) 与 [CHANGELOG.md](CHANGELOG.md)。v1.3.0 已修掉跨平台探测、并发上限、Gate 1 阈值、R2 任务映射等问题；仍存在的：

- `selfcheck` 只查结构、`validate-checkpoint` 只查状态，都查不出语义级矛盾（例如新增规则与旧规则互相拆台）。
- 模型档位依赖部署目录：`deepseek-reasoner` 能被接受，但不在本机模型目录里，是否真路由到高价档未经核实。
- `workflow` 脚本内部无断点，一次调用断了只能整段重跑。

## License

MIT © 2026 pxf0797
