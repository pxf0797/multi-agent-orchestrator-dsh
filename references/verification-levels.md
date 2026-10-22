# 验证强度（5 级）

**核心规则：验证不是一个形容词，是一个 DAG 任务。** 任务的 `verify` 字段只声明强度，真正执行验证的是 checkpoint 里另一条 `role: qa|reviewer` 的任务——它有 id、有 `blockedBy`、有 `output`、计入波次与并发。这样验证才能阻断交付、才能在恢复时不被跳过。

## 五级定义

| 级别 | 用在什么任务 | 展开成什么任务 | 退回上限 |
|---|---|---|---|
| **Light** | 检索、收集、格式转换 | 不展开。父级按输出契约自查（文件存在 / 有来源 / 没把「未验证」写成结论） | n/a（无 verifier） |
| **Standard**（缺省） | 常规开发、写作、分析 | 1 个 verifier 任务：`role` 按交付物选 `qa`（代码/可执行产物）或 `reviewer`（文档/结论） | 2 |
| **Strict** | 安全、资金、不可逆、会被外部引用的交付物 | 3 个 verifier 任务，**分工不同检查面**（契约/事实/回归），≥2 个 `verdict: pass` 才算过 | 2 |
| **Tournament** | 架构选型、关键算法（**opt-in，先问用户**） | 3 个方案任务 + 1 个两两对比任务 + 1 个融合任务 + 1 个 Light 复验 | 1 |
| **Adversarial** | 事实核查、安全评审（**opt-in，先问用户**） | 3 个 refute-first 任务（固定三个视角）+ 1 个裁决任务 | 2 |

## 展开规则（写计划时必须执行）

给任务 `T5` 标 `verify: "standard"`，则 DAG 里必须同时出现：

```json
{ "id": "T5v", "subject": "验证 T5", "role": "qa", "blockedBy": ["T5"],
  "criticality": "critical", "verify": "light", "dispatch": "subagent",
  "output": ".dsh/orchestrator/output/<orchId>/verify-T5.md",
  "completion_criteria": "逐条对照 T5 的 completion_criteria 给出 pass/issues" }
```

并且**任何以 T5 产物为输入的后续任务（尤其是汇总）必须 `blockedBy: ["T5v"]`**，不能只依赖 `T5`。

- `verify: light` → 不生成任务（父级自查）。
- `verify: strict` → 生成 `T5v1/T5v2/T5v3`，`completion_criteria` 分别锚定契约、事实、回归三个面；合成任务 `blockedBy` 三个 verifier，并自己按"≥2 pass"裁决。
- `verify: tournament/adversarial` → 按上表展开，且**必须在 Gate 1 问过用户**。
- **计数**：verifier 是正式任务，计入 3-10 任务数、并发上限、Gate 1 的「任务数 >8」。
- **可合并**：同一波里多个**同构且 verify=light** 的任务，允许合并成 1 个 verifier 任务（`blockedBy` 写全部被验任务）。合并后该 verifier 的 `verify` 取被合并任务中的最高档，且 `completion_criteria` 必须逐条覆盖每个被验任务。

## 判定 → 状态：`verdict` 与 `status` 是两个轴

这是 Strict 能工作的前提：

| 情形 | `status` | `verdict` | 下游 |
|---|---|---|---|
| verifier 正常完成且判定通过 | `done` | `pass` | 可以继续 |
| verifier 正常完成但判定不通过 | `done` | `fail` | **不触发失败传播**；被验任务 `returns += 1`，父级决定重做还是升级 |
| verifier 没跑起来 / 没落盘 | `failed` | `null` | 按 critical 规则重派；2 次仍 failed → Gate 2 |
| 被放弃 | `skipped` | `null` | 触发下游 `upstream failed` |

把"判定失败"和"执行失败"混成一个 `failed`，会让 Strict 的「≥2 通过」永远被自身的传播规则吃掉（3 个 verifier 挂 1 个，合成就被标 skipped）。

## 判据从哪来：`completion_criteria`

Standard 及以上**必填** `completion_criteria`（一句话可检验的通过条件）。没有它，verifier 只能凭感觉打分——这是最容易产生"看起来验证过"的环节。

好判据：「3 个来源都支持该结论，且至少 1 个是一手文档」
坏判据：「报告要专业、完整」

## 关键规则

- **Verifier 必须独立**：新开 `subagent`，prompt 里写「不要相信实现者的自述，自己复核」。让同一个 agent 自查等于没查。R4 这类"实现者返回摘要"的情况，verifier 的输入必须是**改动文件与命令**，不是那段摘要。
- **refute-first**：Adversarial 的 prompt 必须禁止「顺便提供建设性建议」——一旦允许，模型会滑向"总体不错，几点小建议"，失去对抗性。
- **判「不可核验」的门槛**：必须先试过 ≥2 条独立证据路径（源文件 / 会话归档 / 服务契约 / 安装包 / 命令输出），并在产物里写明"放弃了哪些路径、为什么都不行"。**单次工具失败不等于证据不存在**——实测有 verifier 逐帧解码会话归档，把另一位研究员判"不可核验"的历史事件证成了"成立"。
- **退回不计入 `attempts`**：`returns` 单独计数（初值 0，Strict 一轮多票合计 +1）；`attempts` 记的是「这个任务被派发了几次」。
- **退回上限到了就升级**：Strict 退回 2 次仍不过 → `ask_user_question`（换方案 / 降范围 / 接受现状并标注风险）。
- **验证强度写进 checkpoint 的 `tasks[].verify`**，恢复时保持一致，不许中途降级。
- **成本要能说清**：Tournament/Adversarial 是常规路径的数倍，用它之前先问用户（Gate 1）。

## 判决怎么收：用 schema，不要自由文本

verifier 的判决固定为 `{pass, score, issues[], summary}`，`issues[]` 每条 `{severity, where, problem, fix}`，`severity` 只取 `critical|major|minor`。`workflow` 里用 `agent(..., {schema})` 让引擎校验；`subagent` 任务则把同样的 JSON 写进 `output`。

**退回必须把 issues 原文回灌给产出者，不要二次概括**：

```
上一轮验收未通过，逐条修完再交付：
1. [critical] src/auth/token.ts:42 — ttlSec=0 时 exp 早于签发时间；修法：≤0 直接抛 INVALID_TTL
2. [major] 测试缺少负数 ttl 用例；修法：补 2 个参数化用例
不要改动范围外的文件。
```

**四条纪律**：产出者不自评；verifier 不改产物（一旦允许它顺手改，它就会倾向宣布「已修复」）；融合交给 writer，别让 verifier 综合多份判决（最容易长出原文没有的结论）；能跑就别只读。

**验证成本要算**：给「读一个文件」这种动作配 verifier 是净亏。连续 2 次因同一标准被退回，问题在标准或拆法，回 ② 重拆，不要原样再验。

## 与波次的配合

verifier 的 `blockedBy` 指向被验任务，所以它**天然落在下一波**——不需要额外规则。合成任务的 `blockedBy` 同时包含被验任务与其 verifier，于是"验证没过就不合成"由 DAG 结构保证，而不是靠父级记性。

## 环境前提

交付物无法跑命令时（无 shell、无构建入口）：

> 先探测一次环境（`bash -c 'echo ok'`；Windows 无 bash 时用 `pwsh -Command 'echo ok'`；两个都跑不通才算无 shell）。探测不通过才降级：验证改为静态核对，verifier 的 summary **必须**显式写「未执行，只能人工确认」，不得写"测试通过"。探测通过却写"未执行"同样是缺陷——该跑没跑。
