# DAG 任务模型

## 任务对象

```json
{
  "id": "T2",
  "subject": "一句话职责（动宾结构，不带方案）",
  "role": "researcher",
  "blockedBy": ["T1"],
  "criticality": "normal",
  "verify": "standard",
  "completion_criteria": "≥3 个独立来源支持，且至少 1 个一手文档",
  "dispatch": "subagent",
  "output": ".dsh/orchestrator/output/<orchId>/T2-analysis.md"
}
```

| 字段 | 取值 | 约束 |
|---|---|---|
| `id` | `T1`…`T99` | 全局唯一；verifier 建议命名为 `<被验id>v` |
| `subject` | 短句 | 一个任务只做一件事；出现「并且/同时/以及」就拆 |
| `role` | 见 `references/role-templates.md` | 决定 prompt 的角色段与验收清单；**必须来自角色池** |
| `blockedBy` | 任务 id 数组 | 只能引用前面的任务；**禁止环**；无「合流」等软依赖语义 |
| `criticality` | `critical` / `normal` / `nice-to-have` | 决定失败几次后升级（见 `references/checkpoint-protocol.md`） |
| `verify` | `light`/`standard`/`strict`/`tournament`/`adversarial` | 声明验证强度；**同时要生成对应的 verifier 任务**，见 `references/verification-levels.md` |
| `verdict` | `pass`/`fail`/`null` | 只有 verifier 任务用；`fail` 是"判定不通过"，任务本身仍是 `done`（见 `checkpoint-protocol.md` §升级与传播） |
| `completion_criteria` | 一句可检验的条件 | `standard` 及以上必填 |
| `dispatch` | `subagent` / `workflow` / `inline` | 见下表 |
| `output` | `.dsh/orchestrator/output/<orchId>/<file>.md`（工作区相对路径） | 子 agent 必须写到这里；代码类任务可指向目录，并用 `artifacts: []` 列出改动的源文件（完整 prompt 放 `.dsh/orchestrator/plans/<orchId>.md`，不进 checkpoint） |

## dispatch 选择

| 取值 | 什么时候用 | 代价特征 |
|---|---|---|
| `inline` | 父级自己做更快（一次工具调用能完成的、需要本会话上下文的） | 0 额外 agent |
| `subagent` | 需要多轮追问、需要独立上下文、任务差异大 | 结果回到父级上下文，占 token |
| `workflow` | 同一波次 ≥4 个同构任务，且能预先写死 prompt | 结果只在脚本内流转，父级只收 JSON |

**判据**：同构 + 批量 → `workflow`；异构 + 需要深聊 → `subagent`；缝合与决策 → `inline`。

## 波次（wave）计算

```
wave(T) = 0                                 若 blockedBy 为空
wave(T) = 1 + max(wave(B) for B in blockedBy)
```

同一 `wave` 内的任务**全部并行派发**；`wave` 之间是硬屏障（下一波只能读上一波的产物）。

例：

```
T1 (extract)                        wave 0
T2 / T3 / T4 (analyze A/B/C)        wave 1   blockedBy T1
T2v (verify T2)                     wave 2   blockedBy T2   ← verifier 天然落在下一波
T5 (synthesize)                     wave 3   blockedBy T2v,T3,T4
```

**没有「软依赖」「合流」「边跑边等」**：想说「T3 要参考 T2 的方案」，就老老实实 `blockedBy: ["T2"]`——它会晚一波开始，但不会读到半成品。

## 并发上限

见 `SKILL.md` §3（并发表 + 运行时事实）。那里是唯一真源：同波上限是**自设策略**，且要与运行时 `maxParallelToolCalls`（本机 10）取小；workflow 的 `maxTotalAgents` / `maxItemsPerCall` 超限才会 fatal。

## 任务粒度

- 目标任务数 **3-10**（含 verifier 任务）。少于 3 个说明不需要编排，直接做；多于 10 个说明层次不够，先加一层汇总。分支类场景（`deep_research`）受同一条约束：`1 个 brief + 分支 + verifier + 1 个合成 ≤ 10`，所以分支实际上限是 4。
- 2 个任务不编排——省下的协调成本不如直接做两次。
- 每个任务的产物应能被**单独验收**：能指出「这份文件/这段结论对不对」。
- 一个任务如果预计 >15 分钟，再拆（或改 `workflow` + 后台）。

## 子 agent 的输出契约（最重要的规则）

子 agent 的返回值会进入父级上下文。**返回值只放摘要，正文一律落盘**：

```
你必须：
1. 把完整结论写到 <output 路径>（Markdown，带小标题）。
2. 只返回 ≤8 行：结论要点（≤5 条）、文件路径、关键来源（≥1 条，URL / 文件:行号）、未确认项（没有写 none）。
```

- 这条契约适用于 `subagent` 与自己写 `inline` 的产物。
- `workflow` 脚本内部的 `agent()` 返回值留在脚本里，**不需要 ≤8 行**——但它们落盘的规则一样，脚本 `return` 给父级的必须是结构化索引，不是正文。

## prompt 模板

**开头三句每个 prompt 都必须有**——子 agent 看不到主对话，也不会自己去翻 skill 目录：

```
你看不到主对话，本 prompt 就是全部信息；缺信息用工具查，查不到写「未确认」。
你不能派发子 agent，也不能调用 workflow。
大段内容写文件并给路径，回复不超过 200 字。
```

后面接：

```
角色：<role 段，来自 role-templates.md>
目标：<subject 的可执行版本>
输入：<上游产物路径 / 用户给的原始材料 / 无>
完成标准：<completion_criteria，逐条可检验>
边界：<不要做什么；不要臆造；不确定就写「未验证」；无 shell 时不要假装跑过命令>
产出：写到 <output 路径>（Markdown，带小标题）
返回：≤8 行摘要 + 路径 + 来源 + 未确认项
```

## 反模式

| 反模式 | 症状 | 修法 |
|---|---|---|
| 环依赖 | wave 算不出来 | 拆成「先定方案（T1）→ 并行执行（T2..Tn）」 |
| 软依赖/合流 | 「可与 T2 并行但需参考 T2」 | 改成 `blockedBy: ["T2"]`，或拆成两个任务 |
| 胖任务 | prompt 超过 30 行，包含 4 个交付物 | 按交付物拆 |
| 假并行 | 5 个任务都 blockedBy 同一个 T1，却把 T1 也算进并行 | T1 单独 wave 0 |
| 汇总再派 agent | 层级爆炸 | 汇总默认 `inline` 且不再派子 agent；只有在既有 workflow 的末级合成时例外 |
| 让子 agent「顺便修一下」 | 改动范围不可控 | 单独开 `code_dev` 任务并串行 |
| 依赖子 agent 返回长正文 | 父级上下文被挤爆 | 强制输出契约 |
| verifier 只写在字段里 | 「已验证」但没人真的验 | 展开成 verifier 任务，并让下游 blockedBy 它 |
