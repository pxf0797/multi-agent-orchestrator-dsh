# Checkpoint 协议（断点续跑）

上游把状态存在 `~/.claude/orchestrator/`。DSH 版存进工作区——文件沙箱只允许写工作区，而且会话重启后工作区还在，家目录里的隐式状态反而不可发现。

**一个基准，两个字段**：`plan` 与 `output` **都用工作区相对路径**，且分别以 `.dsh/orchestrator/plans/` 和 `.dsh/orchestrator/output/<orchId>/` 开头。不要写 `plans/…`、`output/…` 或绝对路径——恢复时用这两个值去 `glob`，少一层就 0 命中，done 任务会被降级重派。

## 目录布局

```
<workspace>/.dsh/orchestrator/
├── checkpoints/<orchId>.json     # 唯一真源：任务状态机
├── plans/<orchId>.md             # 每个任务的完整 prompt（见 §prompt 存哪）
└── output/<orchId>/              # 每个子 agent 的完整产物
    ├── T1-extract.md
    ├── verify-T1.md
    └── final-report.md
```

`orchId`（= checkpoint 的 `orchestrator_id`）= `orch-YYYYMMDD-HHMMSS-<3位随机>`，例 `orch-20261020-165324-482`。

> 建议把 `.dsh/orchestrator/` 加进仓库的 `.gitignore`：它是运行态，不是源码。

## 状态机文件

完整可复制样例：`templates/checkpoint.example.json`（其中的 `waves` 与 `tasks` **是算过的**，改结构后跑 `tools/selfcheck.mjs` 复验）。字段硬约定：

| 字段 | 约定 |
|---|---|
| `schema_version` | 当前 `1`。恢复时先比对；不认识的版本先降级为只读（报告结论、不自动续跑） |
| `orchestrator_id` / `created_at` / `updated_at` | ISO 时间戳带时区；**写之前取真实时间**（`date -u +%Y-%m-%dT%H:%M:%S%z`；Windows 用 `Get-Date -Format o`；也可直接读 `Time sampled` 之类的运行时时间），不要凭估算（凭估算会写出未来时间，恢复时的"取最新"就会错） |
| `scenario` | `deep_research` / `code_dev` / `deploy_verify` / `general` |
| `goal` | 用户原话，一字不改（恢复时靠它匹配意图） |
| `mode` | 只能是 `wave` / `workflow` / `hybrid`。场景模板给的推荐值优先于全局默认 |
| `status`（顶层） | 落盘只有**五种**：`running` / `awaiting_human` / `done` / `failed` / `aborted`。`planning` 只是内存态，**不落盘** |
| `status`（任务） | `pending` / `running` / `done` / `failed` / `skipped` |
| `verdict`（任务） | 仅 verifier 有：`pass` / `fail` / `null`。**判定失败 ≠ 执行失败**（见 §升级与传播） |
| `verify` | `light` / `standard` / `strict` / `tournament` / `adversarial`，缺省 `standard`；检索类显式标 `light` |
| `completion_criteria` | Standard 及以上必填：一句可检验的通过条件 |
| `attempts` | **已派发次数**：初值 0，每次派发/重派 +1；`done` 时 ≥1（`inline` 任务完成记 1） |
| `returns` | 被 verifier 退回的次数：初值 0，只有「验证不通过、重做」才 +1（Strict 一轮多票合计 +1） |
| `ref` | `subagent` 返回的 agent id（UUID）；后台 workflow 的 job id（**同波多任务可共享同一 ref**）；`inline` 时为 null |
| `output` | 工作区相对路径，必须以 `.dsh/orchestrator/output/<orchId>/` 开头；代码类任务可指向目录，另用 `artifacts: []` 列出改动的源文件 |
| `summary` | 完成时必填：≤8 行，其中结论要点 ≤5 条，至少 1 条来源 |
| `waves` | **派生字段**：每次写盘时按 `blockedBy` 重算并整字段覆盖，不手工维护 |
| `hitl_gates[].at` | `before_dispatch` / `blocked` / `before_delivery`（对应 SKILL 的 Gate 1/2/3） |
| `hitl_gates[].at_time` | ISO 时间戳 |

## summary 的两种用途

1. **筛选与排序**（父级只看 summary 决定哪些产物值得深读）。
2. **不**是汇总的原料。汇总必须 `read` 关键产物的结论段——只读 summary 拼出来的报告，就是"看起来专业但没有信息量"的那种。

## prompt 存哪

checkpoint **不放**每个任务的完整 prompt（体积大且难读）。计划阶段把每个任务的完整 prompt 写进 `.dsh/orchestrator/plans/<orchId>.md`（一节一个任务），checkpoint 只存 `plan` 路径。恢复时读 plan 文件重建 prompt——这是唯一能让"重派"用回原文的办法。

## 写入时机（七个）

1. **派发一波时**：该波每个任务的 `status: running` + `ref`。
2. **每波结束时**：先逐个校验 `output` 是否存在（缺失 → `failed` + `error="output missing"`），再一起更新 `status` / `summary` / `verdict` / `error` / `attempts`，并重算 `waves`。
3. **失败或重试时**：记 `error`、`attempts`、`returns`。
4. **问用户之前**：顶层 `awaiting_human`；拿到答复后追加 `hitl_gates` 并改回 `running`。
5. **终稿写完后**：顶层 `done`。
6. **放弃编排时**：顶层 `aborted`，写明原因（含 `job_kill` / `interrupt_agent` 的处置）。
7. **DAG 结构变化时**：追加 `dag_snapshots`（v1 初始、v2 加任务、v3 删任务/改依赖）。

同一波内并行任务的结果本来就同时回来，**一波只写一次**，不要每完成一个就写。

## 恢复流程（会话重启 / 用户说「继续」）

```
1. glob .dsh/orchestrator/checkpoints/*.json，先按 goal 与用户这句话的意图匹配；
   匹配到多个（或无法判断）→ 列出候选（id / goal / status / updated_at）让用户选，
   不要默认取 updated_at 最新的那个。
2. 校验 schema_version；不认识的版本只报告结论，不自动续跑。
3. 顶层 status：
   - done / aborted → 报告既有结论，问是否需要重跑（不要自动重跑）。
   - awaiting_human → 看 hitl_gates 最后一条，把待决问题重新抛给用户。
   - running → 进入 4。
4. 逐个校验 done 任务的 output 文件是否存在（glob）。
   - 存在 → 保留 done。
   - 不存在 → 降级为 pending，error="output missing"（这是唯一允许"重派 done"的情形，
     且必须在报告里说明「产物已丢失，重新执行」）。
5. running 的任务一律视为被中断：改回 pending，attempts 不变（重派时 +1）。
   —— 不做「多少个波次未更新」这类判定：checkpoint 没有波次计数器，那种判据不可判定。
6. 按 blockedBy 重算 waves，对"上游已终结为 skipped/failed"的任务补标 skipped
   （error="upstream failed"，见 §升级与传播），然后从第一个仍有 pending 的波次继续。
7. 按 tasks/waves 重建 todo_write（否则会话重启后用户看到的进度是空的/过期的）。
8. 读 plans/<orchId>.md 取回该任务的 prompt；plan 缺失时不要即兴重写，先问用户。
```

## 升级与传播

**顺序很重要**：先按 criticality 处置失败任务，**终态确定后**才向下游传播。

| 条件 | 动作 |
|---|---|
| 任务 `failed`（含产物缺失），`attempts < 2` | 带 error 上下文重派，`attempts += 1` |
| `critical` 任务失败 2 次 | 不重派，进 Gate 2：换方案 / 缩小范围 / 放弃该分支 |
| `normal` 任务失败 2 次 | 标 `skipped`，在终稿「未覆盖」里说明 |
| `nice-to-have` 任务失败 1 次 | 直接标 `skipped` |
| 相邻两个波次都 0 进展（全部失败） | 停止编排，报告「卡在哪一环、缺什么信息」 |
| 单波全部失败 | 不停止，按上面的失败规则逐任务处理（重试或升级） |
| 上游**终态**为 `skipped`/`failed`（已放弃） | 下游标 `skipped`，`error="upstream failed"`，**不派发** |
| verifier `verdict = fail` | verifier 自己 `status: done`（不算执行失败，**不触发传播**）；被验任务 `returns += 1`，未达退回上限则重派，达到则按上表升级 |
| Strict 的 3 个 verifier 有 1 个执行失败（failed） | 先按 critical 规则重派该 verifier；2 次仍 failed → Gate 2。**不要**因此自动跳过合成 |

**推论**：Strict 的"≥2 通过"由合成任务读 `verdict` 自行裁决；只要 verifier 是 `done`，下游就不会因为它投了 `fail` 而被标 skipped。

**三类预算不要混用**（改文档时盯住这三条，别在不同文件里给出不同数）：`returns` 修正轮次（判定不过 → 改 → 再判，上限 2）、`attempts` 同任务重试（上限 2）、整轮 workflow 重跑（上限 1）。**每次重试必须改变输入**——补上下文、缩小范围或换角色；同输入硬重试只是在重复同一个失败。

**结构性失败信号**：同一波 ≥2 个任务因**同一原因**失败，不是运气差，是拆法或契约错了 → 停止扇出，回 DAG 设计重拆；重拆后仍同一原因 → Gate 2。

## 清理

只**提示**，不自动删：列出 `status=done` 且 `updated_at` 超过 30 天的编排，让用户决定。不做"是否仍被引用"的自动判定（工具集里没有删除能力，也没有引用清单）。
