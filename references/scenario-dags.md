# 场景 DAG 模板

四种场景的默认形状。先抄形状，再按目标替换 `subject`；**不要**为了「完整」把模板里用不到的任务加回来。

> 「推荐 mode」列只填枚举值（`wave`/`workflow`/`hybrid`）。它优先于全局默认；合成方式、串行约束等策略写在备注里。

## 1. `deep_research` — 调研 / 对比 / 出报告

推荐 mode：`hybrid`（先用 workflow 扇出广度，再对少数分支用 subagent 深挖）

```
T1 提取目标与已知约束（inline，父级自己写 research-brief.md）
 ├─ T2 分支 A 检索
 ├─ T3 分支 B 检索        ← 同构，优先 workflow 扇出，model=deepseek-flash
 ├─ T4 分支 C 检索
 └─ T5 反面证据/风险检索   ← 必须有，否则结论会一边倒
T2v..T5v 各分支验证（verify=standard 时自动生成，落在下一波）
T6 合成（inline，父级自己写；blockedBy 所有 verifier）
```

要点：
- 分支数量 **3-4**：`1 个 brief + 分支 + 对应 verifier + 1 个合成 ≤ 10`（见 `dag-schema.md` 的任务数上限）；确有 5-6 个主题就先合并成"主题簇"。
- 每个分支的 `completion_criteria` 要可检验（例：≥3 个一手来源，或 API 文档里的确切字段）。
- T5 不可省：只找支持性证据的调研不可信。
- 合成任务里显式要求**标注冲突**：「A 来源说 X，B 来源说 Y，差异原因未确认」。
- 合成默认 `inline`。只有在已有 workflow 的末级做合成时，才用 `agent(..., {model:'deepseek-reasoner'})`——`inline` 没有 model 参数。
- `hybrid` 时，扇出阶段一次 `workflow` 调用对应**同一波**的 N 个 lane 任务、共享同一个 `ref`；父级用脚本 `return.tasks[]` 逐条回填状态，再派出深挖的 `subagent` 任务。映射细节见本节末「hybrid 的 checkpoint 映射」。

## 2. `code_dev` — 实现 / 重构 / 修 bug

推荐 mode：`wave`

```
T1 摸清现状（inline 或单 subagent：目录结构、构建命令、测试入口）
T2 方案设计（architect）
T3 风险与兼容面（reviewer，blockedBy: ["T2"] ← 串行，不是"并行后合流"）
T4 实现（developer，**串行**，独占写权限）
T4v 验证（qa，独立跑构建/测试，不信 T4 自述）
T5 修复（developer，仅当 T4v 失败，最多 2 轮）
```

要点：
- **同一批文件只能有一个写入者**。写任务永不并行。
- T3 不能与 T2 同波：它要评的是 T2 的方案，不是 T1 的现状。要么 `blockedBy: ["T2"]`（晚一波），要么拆成 T3a（基于 T1 的风险清单）+ T3b（基于 T2 的方案评审）。
- 验证必须由不同 agent 做，prompt 里写「不要相信实现者的结论」。
- 每轮修复把 verifier 的 `issues` 原文塞进修复 prompt，不要转述。
- 涉及删除/迁移/改公共 API → T4 之前加 Gate 1。

## 3. `deploy_verify` — 发布 / 配置变更 / 上线检查

推荐 mode：`wave`

```
T1 变更清单与回滚预案（inline，必须落盘 rollback.md）
T2 变更前基线快照（subagent：抓当前版本/配置/健康状态）
T3 执行变更（**唯一写入者**，串行）
T4 变更后验证（subagent：健康检查、关键路径、日志无新错误）
T5 对比 T2/T4 出结论（inline）
```

要点：
- T3 前必须有 Gate 1（`ask_user_question`，把变更清单和回滚方式摆给用户）。
- 回滚预案缺失 → 直接不执行。
- 验证要么有可执行的检查命令，要么在 summary 里明确写「未执行，只能人工确认」，不要假装验证过。

## 4. `general` — 其他一切

推荐 mode：`wave`

最小可用形状，够用就别加层：

```
T1 明确输入与验收标准（inline）
T2..Tn 并行子任务（subagent / workflow，2-6 个）
T2v..Tnv 验证（按 verify 级别生成）
T(n+1) 合成与交付（inline，blockedBy 所有 verifier）
```

判据：如果 `T1` 写完后发现只剩 1 个子任务，**退出编排**，直接干活——编排本身有成本。

## 选型速查

| 用户说的话 | 场景 | 推荐 mode |
|---|---|---|
| 「帮我调研/对比/查清楚 X」 | `deep_research` | `hybrid` |
| 「实现/重构/修好 X」 | `code_dev` | `wave` |
| 「发布/部署/改配置并确认没问题」 | `deploy_verify` | `wave` |
| 「这些文件/这些仓库**只读**处理一下」（审计、扫描、总结） | `general` | `wave`（同构批量可改 `workflow` + `pipeline`） |
| 「这些文件/这些仓库都**改写**一遍」（批量迁移、批量重命名） | `code_dev` | `wave`，**串行单写入者**，不得用 `pipeline` 并发写 |
| 只有一两件事 | 不做编排 | 直接 `subagent` 或自己做 |

> `pipeline` 的「阶段间无屏障」是优点，但它的每一项都独立跑——**写回源文件的批处理不能用它**，否则 N 个 agent 并发改同一批文件。`pipeline` 只适合只读审计与生成到 output 目录的场景。

---

## hybrid 的 checkpoint 映射

`hybrid` 里 workflow 扇出与 checkpoint 不是一一对应的，按下面三条回填，否则恢复时会重派整段：

1. **一次 `workflow` 调用 = 同一波的 N 个任务**。计划阶段就要把这些 lane 写成正式任务（否则 `waves` 算不出来），它们共享同一个 `ref`（后台运行的 job id）。
2. 脚本 `return` 的 `{ tasks: [{ id, status, output, summary, error }] }` 是**唯一回填来源**；父级照 id 逐条写 `status/summary/error`，再 `glob` 校验 `output` 存在（缺失的改 `failed`，别信脚本自报的 done）。
3. 深挖阶段的 `subagent` 任务照常 `blockedBy` 对应 lane，落在后续波次；它们的 `ref` 是 agent id，与 lane 的 job id 不混用。

脚本内部**没有** checkpoint 能力：这一波断了，整段重跑，`attempts` 只 +1（一次调用算一次派发）。

