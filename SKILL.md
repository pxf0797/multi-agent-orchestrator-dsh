---
name: multi-agent-orchestrator
version: 1.2.0
description: "多 Agent 编排：把复杂目标拆成 DAG 任务图，用并行 subagent 或 workflow 脚本按依赖波次调度、断点续跑、汇总结果。当用户要求并行处理/多 agent/多角度调研/跨文件审计/大规模迁移，或说「继续/接着跑/续跑上次编排」，或明确要求 workflow 编排时使用；一两项简单委派不要用。"
whenToUse: "目标可拆成 >=3 个相互独立或分层的子任务，且用户期待一个汇总结果时；或用户明确说「并行/同时/多个 agent/swarm/工作流」；或上次编排中断、用户说继续。"
user-invocable: true
---

# Multi-Agent Orchestrator（DSH 版）

把复杂目标变成 **DAG 任务图** → 按波次并行派发 → 落盘 → 汇总交付。你是 Coordinator：**只做拆解、调度、验收、缝合**，具体活交给子 agent。

## 60 秒快速路径

1. **门禁 A**：≥3 个互不共享上下文的子任务才编排；1-2 件、或一个 agent 顺序读一遍就能做完的，直接做。
2. **门禁 B**：默认 `wave`；同构 ≥4 且 prompt 可预先写死 → `workflow`；广度扇出 + 少数分支要深聊 → `hybrid`。
3. **拆** 3-10 个任务（含 verifier），每个都有 `role` / `completion_criteria` / `output`。
4. **落盘** `.dsh/orchestrator/plans/<orchId>.md`（完整 prompt）+ `.dsh/orchestrator/checkpoints/<orchId>.json`（状态），并建 `todo_write`。
5. **派发**：同波并发 → 等齐 → **校验产物存在** → 写 checkpoint → 下一波。终稿自己读产物写，不再派 agent。

详细规则按需读下表；**不要**一开始全读。

| 文件 | 内容 | 什么时候必须读 |
|---|---|---|
| `references/dag-schema.md` | 任务字段、波次公式、dispatch 选择、粒度 | 第一次拆 DAG 时 |
| `references/checkpoint-protocol.md` | 状态机 JSON、字段硬约定、七个写入时机、恢复与传播 | 写第一个 checkpoint / 恢复前 |
| `references/verification-levels.md` | 5 级验证强度、verifier 展开规则、Strict 的裁决语义 | 任务标 `verify` 时 |
| `references/workflow-recipes.md` | 6 个可复制脚本配方 + 硬约束 | 选 `workflow`/`hybrid` 时 |
| `references/scenario-dags.md` | 4 个场景的默认 DAG 形状与 mode 推荐 | 场景识别时 |
| `references/role-templates.md` | 9 核心 + 2 进阶角色的身份段与验收清单 | 拼 prompt 时 |
| `references/cc-to-dsh-mapping.md` | 与上游 Claude Code 版的逐项差异 | 迁移 / 排错时 |

---

## 0. 三道门禁 + 一个前置检查

**前置检查：现在能派子 agent 吗？**
运行时没有 `subagent` 工具（例如你自己就是被派出的子 agent，且委派深度已到 `resolveMaxDepth` 上限）→ **不要启动编排**，退化为 `inline` 串行执行，并在回复首行说明「当前层级无法再派子 agent，已按单 agent 串行处理」。

**门禁 A：要不要编排？**
- 子任务 ≥3、彼此**不共享上下文**、可并行或分层 → 编排。
- 只有 1-2 件 → 直接做或一次 `subagent`，**不要**启动编排。
- 子任务共享同一份上下文、一个 agent 顺序读一遍就能完成 → 直接做。
- 任务本质是串行的一条线（改一个函数、答一个问题）→ 直接做。

> **跨文件一致性是例外**：如果判据是"多份文件之间是否自洽"，独立评审的价值来自**视角差异**（一致性 / 可执行性 / 反例），不来自并行读同一批文件。此时要么 1 个 agent 顺序审（默认），要么最多 3 个视角**不同**的评审——不要拆成 5 个都读同一批文件的 agent。

**门禁 B：哪种模式？**

| 模式 | 用什么 | 何时 |
|---|---|---|
| `wave`（默认） | 并行 `subagent` 调用 + 父级推进 | 任务异构、需要追问、可能要中途改计划 |
| `workflow` | `workflow` 脚本 | 同构批量（≥4）、DAG 可预先写死、需要 per-call 模型降本 |
| `hybrid` | 先 workflow 扇出，再 subagent 深挖 | 广度 ≥4 且只有少数分支要深聊 |

- `mode` 只能是这三个值；**场景模板给的推荐 mode 优先于全局默认**（见 `references/scenario-dags.md`）。
- `workflow` 门槛较高（一次调用跑完整个脚本、阻塞父级、内部无断点）。没有明确理由就用 `wave`。

**门禁 C（Gate 1）：写计划并确认。**
任务数 >6，或涉及删除/发布/改公共 API/花钱 → 先用 `ask_user_question` 把任务表 + 验收标准给用户确认。**纯读取型且 ≤6 个任务不停。**

---

## 1. 五阶段流程

```
① 场景识别 → ② DAG 设计 → ③ 落盘计划 → ④ 波次派发 → ⑤ 汇总交付
                                    ↑______________|
                                   失败/续跑时回到 ④
```

### ① 场景识别
从 `deep_research` / `code_dev` / `deploy_verify` / `general` 里选一个，抄 `references/scenario-dags.md` 对应形状，写进 checkpoint 的 `scenario`。

### ② DAG 设计
按 `references/dag-schema.md` 产出任务表。硬性要求：
- **3-10 个任务（含 verifier）**。超过 10 说明层次不够：先合并同构分支或加一层汇总，而不是继续加任务。
- `blockedBy` 只能指向更早的任务、无环；**没有软依赖/合流**。
- 每个任务有 `role`（必须在角色池内）、`completion_criteria`（standard 及以上必填）、`output` 路径。
- 给任务标 `verify` 后，**必须同时展开出 verifier 任务**（见 `references/verification-levels.md`）。

### ③ 落盘计划
1. 生成 `orchId`（`orch-YYYYMMDD-HHMMSS-<3位随机>`）。
2. 把每个任务的**完整 prompt** 写进 `.dsh/orchestrator/plans/<orchId>.md`（一节一个任务）。
3. 一次性写 `.dsh/orchestrator/checkpoints/<orchId>.json`：`schema_version: 1`、`status: running`、`plan` 指向上面的文件（**工作区相对路径**）。
4. 用 `todo_write` 建一份**面向用户**的进度清单（一个任务一条，波次顺序），每波结束更新一次。

### ④ 波次派发
按 `wave` 从小到大：

- **同一波内的独立任务，在同一个消息里并发调用**（多个 `subagent` 并列，或一次 `workflow`）。
- 派发后**不要在同一个消息里读产物**——产物还不存在。等该波所有子 agent 的结束通知；不确定就 `list_agents` 确认全部 `inactive` 再继续。
- 波次之间是硬屏障：下一波只能读上一波的产物。
- **每波结束先校验产物，再写 checkpoint**：逐个用 `glob`/`stat` 检查该波每个任务的 `output`；缺失即 `status: failed`、`error: "output missing"`（这是 done/failed 的判定依据，不是恢复时才做的检查）。
- 校验通过后一次性更新 checkpoint（`write` 覆盖），重算 `waves`。

### ⑤ 汇总交付
- 汇总任务默认 `inline`（你自己写），**且不得再派一层 agent**；唯一例外是它本来就是某个 workflow 的末级 agent。
- 汇总**必须 `read` 关键产物的结论段**。只读 8 行 `summary` 拼出来的报告没有信息量——`summary` 是用来筛选和排序的，不是原料。
- 冲突处理：一手来源 > 官方文档 > 二手报道 > 聚合站；来源质量相当则比数量，数量相当则比时间新近；三条都比不出 → `ask_user_question`。
- **口径**：每个 verifier 的 `verdict` 与它标注的最高严重度问题，必须出现在终稿的证据段；其余产物按 `summary` 排序取前 3 深读。这条用来替代"全读"与"只读摘要"两个极端。
- 终稿写 `.dsh/orchestrator/output/<orchId>/final-report.md`，给出结论 + 证据 + 未确认项 + 下一步。
- 有实体交付物时用 `present` 挂文件；否则直接在回复里给结论和文件链接。

---

## 2. 并行派发的写法

**wave 模式**（同一消息内多个调用，天然并行）：

```
subagent(description="T2 分析A", prompt="<角色段>\n<目标>\n<输入>\n<完成标准>\n<输出契约>")
subagent(description="T3 分析B", prompt="...")
subagent(description="T4 分析C", prompt="...")
```

- 每个 `subagent` 立刻返回 id；它们同时跑；结束时结果自动回到你这里（不需要额外 `send_message` 轮询）。
- 需要追问/纠偏时用 `send_message(agent_id, ...)`，不要重开一个 agent。
- 子 agent **卡住不动**（长时间无结束通知）→ `list_agents` 确认状态 → `interrupt_agent(agent_id)` 中止 → 按失败处理。这是唯一的取消路径，协议里不要跳过它。
- `subagent` = 干净上下文；`subagent_fork` = 继承**已完成**的轮次，**看不到当前这一轮**——本轮内的侦察用 `subagent`，需要历史上下文的后续分析才用 `fork`。

**workflow 模式**：

```
workflow(meta={name, description, phases:[...]}, script="<JS 脚本>", args={orchId, ...})
```

- `meta.phases` 的标题必须与脚本里 `phase()` 的标题逐字一致，否则进度分组落空。
- `args` 传数据，**脚本不能读盘**。
- 子 agent 自己落盘；脚本 `return` 只带结构化索引（`{tasks:[{id,status,output,summary,error}]}`）。
- 长跑用 `run_in_background: true`，之后 `job_output` / `job_kill`；`job_kill` 后同样要写 checkpoint。

---

## 3. 并发上限与运行时事实

同波次上限（**自设策略**，用来控制失败面，不是引擎硬限制）：

| 场景 | 同波次上限 |
|---|---|
| `deep_research` | 12 |
| `code_dev` | 6 |
| `deploy_verify` | 4 |
| `general` | 8 |

超限就**分批**（第一批发出、等回来再发第二批），不要串行化，也不要为了凑并发把任务拆得更碎。verifier 同样计数。

派发前先对齐运行时事实（本机实测，换部署要重测）：

| 事实 | 值 | 对编排的含义 |
|---|---|---|
| 单 step 并行工具调用 `maxParallelToolCalls` | 10 | 同波 >10 个 subagent 会**排队**，不会失败；但"12 路真并行"是错觉 |
| workflow `maxConcurrentAgents` | `0` → 按 CPU 并行度解析 | 别假设固定并发；需要确定值时在 `meta` 前测一次 |
| workflow `maxTotalAgents` / `maxItemsPerCall` | 1000 / 4096 | **这两类是脚本级 fatal**，超了整段重来；大规模扇出要分批 |
| `fatal` 的触发面 | 钩子误用（参数/选项/schema）+ 上述总量上限 | 子 agent 失败**不是** fatal：`agent()` 返回 `null`，脚本自己处理 |

---

## 4. 输出契约（写进每个子 agent 的 prompt）

```
你必须：
1. 把完整结论写到 <output 路径>（Markdown，带小标题）。
2. 只返回 ≤8 行：结论要点（≤5 条）、文件路径、关键来源（≥1 条）、未确认项（没有写 none）。
```

- 适用于 `subagent` 任务与你自己写 `inline` 的产物。
- `workflow` 脚本内部的 `agent()` 不受 ≤8 行约束（结果只回脚本），但**落盘规则一样**，脚本 `return` 给父级的必须是结构化索引。
- 原因：子 agent 的返回值占用你的上下文，而产物还要被下游任务 `read`。落盘 + 摘要能同时满足两者。
- 父级收到结果后**先校验文件存在**（见 §1④），再信任摘要。

---

## 5. 断点续跑

- 状态唯一真源：`.dsh/orchestrator/checkpoints/<orchId>.json`（字段与恢复流程见 `references/checkpoint-protocol.md`）。
- 写入时机七个：派发一波 / 每波结束 / 失败重试 / 问用户前 / 终稿后 / 放弃时 / DAG 变更。
- 恢复：按 `goal` 关键词匹配 checkpoint（多个候选就列给用户选，不要默认取最新）→ 校验 `schema_version` → 校验 done 任务的 `output` 是否存在 → `running` 一律降级 `pending` → 按 `blockedBy` 重算波次 → 重建 `todo_write` → 接着跑。
- **已 done 的任务不重派**，唯一例外是它的产物文件真的丢了（此时必须说明「产物丢失，重新执行」）。
- `workflow` 脚本内部**没有**断点能力：把一次脚本调用当作一个波次，断了就重跑这一波。

---

## 6. HITL：三个必停点

用 `ask_user_question` 停下，不要用自然语言「你看行吗」——那样用户容易漏掉。gate 的 `at` 取值固定为下表第一列。

| `at` | Gate | 触发条件 | 问什么 |
|---|---|---|---|
| `before_dispatch` | Gate 1 | 任务数 >6，或涉及删除/发布/改公共 API/花钱 | 任务表 + 验收标准 + 预计产出，让用户确认或改范围 |
| `blocked` | Gate 2 | `critical` 任务失败 2 次，或汇总出现无法裁决的冲突 | 三选一：换方案 / 缩小范围 / 放弃该分支 |
| `before_delivery` | Gate 3 | 产物不可逆（文件被覆盖/已发布）或结论与用户预期相反 | 摆事实 + 建议，让用户决定是否落地 |

不需要停的情况：纯读取型任务且任务数 ≤6、可完全回滚的写操作。

---

## 7. 失败与验证

### 7.1 失败处理（完整规则见 `references/checkpoint-protocol.md` §升级与传播）

- 子 agent 返回空 / 崩溃 / 产物缺失 → 带 `error` 上下文重派一次。
- 再失败：`critical` → **Gate 2** 问用户；`normal` → 标 `skipped`，终稿「未覆盖」里说明；`nice-to-have` → 直接 `skipped`。
- `blockedBy` 里有 `failed`/`skipped` → 本任务标 `skipped`（`error="upstream failed"`），不派发。
- 相邻两波都 0 进展 → 停止编排，报告「卡在哪一环、缺什么信息」；单波全灭不停止，按上面逐任务处理。

`attempts` = 已派发次数（初值 0，每次派发 +1；`inline` 任务完成记 1）；被 verifier 退回另记 `returns`，不混用。

### 7.2 验证强度（完整定义见 `references/verification-levels.md`）

- 检索/搬运 → **Light**：不展开任务，父级按 `completion_criteria` 自查。
- 常规 → **Standard**：1 个 verifier（代码用 `qa`，文档用 `reviewer`）。
- 安全/资金/不可逆/会被外部引用 → **Strict**：3 个 verifier，分工不同检查面（契约 / 事实 / 回归）。
- 选型、事实核查 → **Tournament / Adversarial**：**先问用户**再用（成本是常规路径的数倍）。

`standard` 及以上必须给 `completion_criteria`（一句可检验的通过条件），否则 verifier 只能凭感觉打分。**`verify` 只是声明，执行靠展开出来的 verifier 任务**——它有 id、有 `blockedBy`、占一个波次，所以能真正阻断交付、恢复时也不会消失。

**环境前提（先探测，再降级）**：编排开始时跑一次轻量探测（如 `pwsh -Command 'echo ok'`）。探测通过 → 命令类验收有效；不通过 → 所有"跑构建/测试并贴输出"的验收项降级为静态核对，且 summary 必须显式写「未执行，只能人工确认」，**不得**写"测试通过"。不要用某个固定错误码当判据。

---

## 8. 与上游 Claude Code 版的差异（速查）

| 上游 | DSH |
|---|---|
| `TaskCreate` / `claude_task_id` | `todo_write`（面向用户）+ checkpoint JSON（面向恢复） |
| `Agent` 工具 | `subagent` / `subagent_fork`（返回 id，可 `send_message` 追问、`interrupt_agent` 中止） |
| Agent Teams（worker 互聊） | 当前 profile 无 Teams 工具入口；Host 有 `agentTeams` 服务但未暴露。跨子通信由父级转述 |
| `/orchestrate`、`/swarm` 斜杠命令 | **有 `/name`**：`/multi-agent-orchestrator`（名字必须等于 skill 名）；短名 `/orch` 由别名 skill 提供 |
| `~/.claude/orchestrator/` | `<workspace>/.dsh/orchestrator/`（沙箱可写、会话重启仍在） |
| Coordinator/model 分档 | 仅 `workflow` 的 `agent()` 支持 per-call `model`；`subagent` 无此参数 |
| bash 脚本（checkpoint-resume.sh） | 全部改为工具调用（`glob`/`read`/`write`），无 shell 依赖 |

完整对照与逐项理由见 `references/cc-to-dsh-mapping.md`。

---

## 9. 反模式

- ❌ 为「看起来专业」而编排：1-2 件事就启动 5 个 agent。
- ❌ 把 `verify` 当成一个形容词：写了 `standard` 却没有 verifier 任务，等于没验证。
- ❌ 假并行：把有依赖的任务放进同一波，然后用「可与 X 并行但需参考 X」糊过去。
- ❌ 汇总时只读 8 行摘要：产出的是"看起来专业但没有信息量"的报告。
- ❌ 让子 agent 返回长正文：返回值只该是摘要。
- ❌ 用 `workflow` 做需要中途介入的任务：脚本跑起来后无法 steer。
- ❌ 重试超过 2 次：该问人了。
- ❌ 不落 checkpoint 就开跑：断了只能从头来。
- ❌ 子 agent 说完成就标 done：不校验 `output` 存在 = 把空产物当交付。
- ❌ 在无 shell 的环境里写「测试通过」：这是编造。
- ❌ 只改规则不改示例：示例与公式一旦漂移，规则就没人信了（改完跑 `tools/selfcheck.mjs`）。

---

## 10. 自检与变更记录

改完本 skill 的任意文件后，在 skill 目录跑一次自检：

```powershell
node tools/selfcheck.mjs
```

它检查 5 件事：waves 示例是否满足波次公式、`plan`/`output` 是否同基准且以 `.dsh/orchestrator/` 开头、枚举是否闭合（status / mode / role）、任务数是否在 3-10、`strict|tournament|adversarial` 是否都展开了 verifier。

**v1.2.0（2026-10-21）**：waves 示例纠正并与模板统一；`plan` 改工作区相对路径；Strict 判失败与执行失败分离（`verdict`）；done 增加产物校验；并发表补运行时事实、区分 fatal 类型；修正 `maxResultChars` 归属；R2 产物去重名、R4 不再把自述当证据；hybrid 的 checkpoint 映射；`attempts` 对 inline 的例外；删除与 references 重复的表。
