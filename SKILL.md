---
name: multi-agent-orchestrator
description: "多 Agent 编排：把复杂目标拆成 DAG 任务图，用并行 subagent 或 workflow 脚本按依赖波次调度、断点续跑、汇总结果。当用户要求并行处理/多 agent/多角度调研/跨文件审计/大规模迁移，或说「继续/接着跑/续跑上次编排」，或明确要求 workflow 编排时使用；一两项简单委派不要用。"
whenToUse: "目标可拆成 >=3 个相互独立或分层的子任务，且用户期待一个汇总结果时；或用户明确说「并行/同时/多个 agent/swarm/工作流」；或上次编排中断、用户说继续。"
user-invocable: true
metadata:
  version: 1.5.0
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
没有 `subagent` 工具（你就是被派出的子 agent，且深度已到 `resolveMaxDepth`）→ **不要启动编排**，退化为 `inline` 串行，首行说明「当前层级无法再派子 agent，已按单 agent 串行处理」。

**门禁 A：要不要编排？**
- 子任务 ≥3、彼此**不共享上下文**、可并行或分层 → 编排。
- 只有 1-2 件 → 直接做或一次 `subagent`，**不要**启动编排。
- 共享同一份上下文、或本质串行（改一个函数、答一个问题）→ 直接做。

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
任务数 >8，或涉及删除/发布/改公共 API/花钱 → 先用 `ask_user_question` 把任务表 + 验收标准给用户确认。**纯读取型且 ≤8 个任务不停**——研究类分支标 `light` 时通常只有 5-6 个任务，不该被打断。

---

## 1. 五阶段流程

```
① 场景识别 → ② DAG 设计 → ③ 落盘计划 → ④ 波次派发 → ⑤ 汇总交付
                                    ↑______________|
                                   失败/续跑时回到 ④
```

### ① 场景识别
从 `deep_research` / `code_dev` / `deploy_verify` / `general` 选一个，抄 `references/scenario-dags.md` 的形状，写进 checkpoint 的 `scenario`。

### ② DAG 设计
按 `references/dag-schema.md` 产出任务表。硬性要求：
- **3-10 个任务（含 verifier）**。超过 10 说明层次不够：先合并同构分支或加一层汇总。
- `blockedBy` 只能指向更早的任务、无环；**没有软依赖/合流**。
- 每个任务有 `role`（在角色池内）、`completion_criteria`（standard+ 必填）、`output` 路径。
- 给任务标 `verify` 后，**必须同时展开出 verifier 任务**（见 `references/verification-levels.md`）。

### ③ 落盘计划
1. 生成 `orchId`（`orch-YYYYMMDD-HHMMSS-<3位随机>`）。
2. 每个任务的**完整 prompt** 写进 `.dsh/orchestrator/plans/<orchId>.md`（一节一个任务）。
3. 一次性写 `.dsh/orchestrator/checkpoints/<orchId>.json`：`schema_version: 2`、`status: running`、`plan` 指向 plan 文件（**工作区相对路径**）。
4. 用 `todo_write` 建**面向用户**的进度清单（一任务一条），每波结束更新一次。

### ④ 波次派发
按 `wave` 从小到大：
- **同一波的任务在同一个消息里并发**（多个 `subagent` 并列，或一次 `workflow`）；派发后不要在同一条消息里读产物——产物还不存在。
- 等该波结束通知；不确定就 `list_agents` 确认全部 `inactive`。波次之间是硬屏障：下一波只能读上一波产物。
- **每波结束先校验产物再写 checkpoint**：逐个 `glob` 检查 `output`，缺失即 `failed` + `error: "output missing"`（这是 done 的判定依据，不是恢复时才做）。校验通过后一次性覆盖 checkpoint，重算 `waves`。

### ⑤ 汇总交付
- 汇总默认 `inline`（自己写），**不得再派一层 agent**；例外是它本来就是某个 workflow 的末级 agent。
- **必须 `read` 关键产物的结论段**：只读 8 行 `summary` 拼出来的报告没有信息量，`summary` 只用来筛选排序。
- 冲突裁决：一手来源 > 官方文档 > 二手报道 > 聚合站；质量相当比数量，数量相当比新近；都比不出 → `ask_user_question`。
- 口径：每个 verifier 的 `verdict` 与最高严重度问题必须进终稿证据段；`pass_with_issues` 的 blocker/major 单列「已知偏差」；其余按 `summary` 排序取前 3 深读。终稿末尾列「依据清单」。
- 终稿写 `.dsh/orchestrator/output/<orchId>/final-report.md`（结论 + 证据 + 未确认项 + 下一步）；有实体交付用 `present`，否则在回复里给结论和文件链接。

---

## 2. 并行派发的写法

同一波的任务**必须在同一个消息里发出**（多个 `subagent` 并列，或一次 `workflow`）——这是唯一的并行语义。

- `subagent` = 干净上下文、立刻返回 id；`subagent_fork` 继承**已完成**轮次、看不到当前这一轮。追问用 `send_message`，不要重开。
- `workflow`：`meta.phases` 标题与 `phase()` 逐字一致；`args` 传数据（脚本不能读盘）；`return` 只带索引；长跑加 `run_in_background`，`job_kill` 后照写 checkpoint。脚本照 `references/workflow-recipes.md` 抄。

---

## 3. 并发上限与运行时事实

同波次上限（**自设策略**，控制失败面；要与运行时 `maxParallelToolCalls`=10 取小，写更大的数只会排队）：

| 场景 | 同波次上限 |
|---|---|
| `deep_research` | 10 |
| `code_dev` | 6 |
| `deploy_verify` | 4 |
| `general` | 8 |

超限就**分批**（发一批、等回来再发下一批），不要串行化，也不要为了凑并发把任务拆得更碎。verifier 同样计数。

派发前对齐运行时事实（换部署要重测）：`maxParallelToolCalls`=10，超了排队、不失败；workflow 的 `maxConcurrentAgents`=0（按 CPU 解析）、`maxTotalAgents`=1000、`maxItemsPerCall`=4096——**后两个是脚本级 fatal**，超了整段重来。`agent()` 失败**不是** fatal，它返回 `null`，由脚本自己处理。

**触到就停手**：预计 >10 个 agent 先给「简化版 / 完整版」；单次 workflow >20 个拆批；耗时超预估 3 倍就停（后台 `job_kill`，前台等返回后停止派发并报告）。

---

## 4. 输出契约

每个子 agent 的 prompt 都要带：**正文写进 `<output>`，只回 ≤8 行摘要 + 路径 + 来源 + 未确认项**；摘要只放口径与结论，不复述正文。`workflow` 里的 `agent()` 不受行数限制，落盘规则一样。模板见 `references/dag-schema.md`。

---

## 5. 断点续跑

状态唯一真源是 `.dsh/orchestrator/checkpoints/<orchId>.json`。**已 done 的任务不重派**（唯一例外：产物真的丢了，且报告里要写「产物丢失，重新执行」）。

恢复顺序：按 `goal` 匹配 checkpoint（多候选列给用户选，别默认取最新）→ 校验 `schema_version` → 校验 done 的 `output` 还在 → `running` 降级 `pending` → 重算波次 → 重建 `todo_write`。

`workflow` 内部没有断点：一次调用 = 一个波次，断了整段重跑。细节见 `references/checkpoint-protocol.md`。

---

## 6. HITL：三个必停点

用 `ask_user_question` 停下，不要自然语言问「你看行吗」——容易漏；`at` 只取第一列。

| `at` | Gate | 触发条件 | 问什么 |
|---|---|---|---|
| `before_dispatch` | Gate 1 | 任务数 >8，或涉及删除/发布/改公共 API/花钱 | 任务表 + 验收标准 + 预计产出，让用户确认或改范围 |
| `blocked` | Gate 2 | `critical` 任务失败 2 次，或汇总出现无法裁决的冲突 | 三选一：换方案 / 缩小范围 / 放弃该分支 |
| `before_delivery` | Gate 3 | 产物不可逆或结论与预期相反 | 摆事实 + 建议，让用户决定是否落地 |

不需要停的情况：纯读取型任务且任务数 ≤8、可完全回滚的写操作。

---

## 7. 失败与验证

### 7.1 失败处理（完整规则见 `references/checkpoint-protocol.md` §升级与传播）

- 子 agent 返回空 / 崩溃 / 产物缺失 → 带 `error` 上下文重派一次；再失败：`critical` → **Gate 2**，`normal` → `skipped` 并在终稿「未覆盖」里说明，`nice-to-have` → 直接 `skipped`。
- `blockedBy` 里有 `failed`/`skipped` → 本任务 `skipped`（`error="upstream failed"`），不派发。
- **同一波 ≥2 个任务因同一原因失败** → 不是运气差，是拆法或契约错了：停止扇出，回 ② 重拆。
- **每次重试必须改变输入**（补上下文 / 缩小范围 / 换角色），同输入硬重试只是把同一个失败再买一遍。
- **返工回到原 agent**（`send_message` + issues 原文），`attempts += 1`、`ref` 不变；旧产物改名压进 `previous_outputs`，改完回原 verifier 复审。
- 相邻两波都 0 进展 → 停止编排并报告卡点；单波全灭不停止，按上面逐任务处理。
- 整轮 workflow 重跑上限 **1 次**，到顶换拆法或缩范围。

`attempts` = 已派发次数（初值 0，每次 +1；`inline` 完成记 1）；被 verifier 退回另记 `returns`，不混用。

### 7.2 验证强度（完整定义见 `references/verification-levels.md`）

- 检索/搬运 → **Light**：不展开任务，父级按 `completion_criteria` 自查。
- 常规 → **Standard**：1 个 verifier（代码 `qa`，文档 `reviewer`）。
- 安全/资金/不可逆/对外引用 → **Strict**：3 个 verifier 分工不同检查面（契约 / 事实 / 回归）。
- 选型、事实核查 → **Tournament / Adversarial**：**先问用户**再用（成本数倍）。

`standard` 及以上必须给 `completion_criteria`（一句可检验的条件），否则 verifier 只能凭感觉打分。**`verify` 只是声明，执行靠展开出来的 verifier 任务**——它有 id、有 `blockedBy`、占一个波次，所以能真正阻断交付、恢复时也不会消失。

**环境前提（先探测，再降级）**：开工先跑 `bash -c 'echo ok'`（Windows 无 bash 时用 `pwsh -Command 'echo ok'`），两个都不通才算无 shell。通了 → 命令类验收有效；不通 → 相关验收项降级为静态核对，summary 必须写「未执行，只能人工确认」，**不得**写"测试通过"。

---

## 8. 与上游 Claude Code 版的差异

上游压在三根柱子上（通知驱动 turn / Task 双写 / PID 判活），DSH 都没有，所以是**重写而非移植**：波次替代事件循环、checkpoint 替代 Task、状态字段替代判活。最常踩的两条：`subagent` 没有 model 参数；子 agent 互聊没有工具入口。39 项见 `references/cc-to-dsh-mapping.md`。

---

## 9. 反模式

- ❌ 为「显得专业」而编排：1-2 件事就开 5 个 agent。
- ❌ 把 `verify` 当成一个形容词：写了 `standard` 却没有 verifier 任务，等于没验证。
- ❌ 假并行：把有依赖的任务放进同一波，然后用「可与 X 并行但需参考 X」糊过去。
- ❌ 汇总只读 8 行摘要，或让子 agent 返回正文。
- ❌ 用 `workflow` 做需要中途介入的任务：脚本跑起来后无法 steer。
- ❌ 重试超过 2 次：该问人了。
- ❌ 子 agent 说完成就标 done：不校验 `output` 存在 = 把空产物当交付。
- ❌ 在无 shell 的环境里写「测试通过」：这是编造。

---

## 10. 自检与变更记录

改完任意文件后，在 skill 目录跑一次自检：

```bash
node tools/selfcheck.mjs
```

它检查 8 件事：waves 公式、`plan`/`output` 路径基准、枚举闭合、任务数与角色池、verifier 展开、文件引用、SKILL.md 字符预算，以及**这句话的项数与实际是否一致**。

变更记录见 [`CHANGELOG.md`](CHANGELOG.md)。
