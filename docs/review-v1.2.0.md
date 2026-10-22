# v1.2.0 评审

- 评审对象：本 skill 全部 9 个文件 + `tools/selfcheck.mjs`
- 评审方法：逐文件通读；把 SKILL.md 声明的运行时事实拿去 DSH 打包产物（`app.asar` 源码与默认配置）逐条核对；实跑 `selfcheck`；实测一次 `agent(..., {model})` 调用
- 评审日期：2026-10-22
- **修复状态：P1 全部 5 条、P2 全部 5 条已在 v1.3.0 修掉，详见 [CHANGELOG.md](../CHANGELOG.md)**。下文保留原始评审内容作为基线。

## 六维评分

| 维度 | 评分 | 依据 |
|---|---|---|
| 设计质量 | 9/10 | 门禁分层、verdict/status 双轴、输出契约、波次确定性 |
| 与运行时贴合度 | 8.5/10 | 4 个运行时常量实测一致，工具语义无误 |
| 跨平台可移植性 | 5/10 | 环境探测写死 `pwsh`，时间戳写死 `Get-Date` |
| 内部一致性 | 7/10 | 12>10 自相矛盾、自检项数说 5 实为 6、优先级表错位 |
| 生态共存 | 待定 | 与 `orchestrate` skill 触发条件同义、默认协议相反 |
| 可执行强制力 | 6/10 | 全靠散文约束；selfcheck 只查结构不查语义 |

## 已核实的事实

| 断言 | 核实结果 |
|---|---|
| `maxParallelToolCalls` = 10 | ✅ 默认 `10`（每 step 并行安全调用上限） |
| `maxConcurrentAgents` = 0 → 按 CPU | ✅ 注释即 "resolves from available CPU parallelism" |
| `maxTotalAgents` = 1000 | ✅ `z.natural().default(1e3)` |
| `maxItemsPerCall` = 4096 | ✅ 超限抛 `ITEM_CAP`（脚本级 fatal） |
| `agent()` 失败返回 `null` | ✅ 源码 `if (isFatalWorkflowError(e)) throw e; return null` |
| `subagent` 无 model 参数 | ✅ 工具 schema 仅 `description` / `prompt` / `cwd` |
| `selfcheck` 全通过 | ✅ 6 项 PASS |

## 问题清单

### P1 · 会造成真实降级或矛盾

| # | 位置 | 现象 | 影响 | 修法 |
|---|---|---|---|---|
| P1-1 | [SKILL.md:141](../SKILL.md#L141) / [:152](../SKILL.md#L152) | 同波上限给 `deep_research` 设 12，紧接着承认引擎 `maxParallelToolCalls` 只有 10 | 自设策略高过引擎上限，12 路并行是错觉 | 改成 10，删掉免责句 |
| P1-2 | [SKILL.md:218](../SKILL.md#L218)、[verification-levels.md:72](../references/verification-levels.md#L72) | 环境探测写死 `pwsh -Command 'echo ok'`，macOS/Linux 通常没有 `pwsh` | 探测必失败 → 所有命令类验收降级为静态核对，制造"假验证" | 探测 `bash -c 'echo ok'`，或检测可用 shell 列表 |
| P1-3 | [checkpoint-protocol.md:30](../references/checkpoint-protocol.md#L30) | 时间戳要求 `Get-Date -Format o`（PowerShell） | 非 Windows 环境无对应命令 | 改 `date -u +%Y-%m-%dT%H:%M:%S%z` 或写成工具无关 |
| P1-4 | [SKILL.md:60](../SKILL.md#L60)、[scenario-dags.md:22](../references/scenario-dags.md#L22) | Gate 1 在 >6 任务时强制确认，而 `deep_research` 默认形状是 8-10 任务 | 研究类默认 100% 触发确认，与「纯读取型 ≤6 不停」冲突 | 检索分支显式标 `light` 压回 6，或把阈值提到 8 |
| P1-5 | [workflow-recipes.md:119](../references/workflow-recipes.md#L119) | R2 逐文件生成 `T${i+2}` | 审计 50 个文件 = 50 个任务，违反「3-10 任务」；且 id 未必与 plan 对齐，回填会错位 | 一个 batch = 一个正式任务，`tasks[]` 只留聚合结果 |

### P2 · 卫生与文档漂移

| # | 位置 | 现象 |
|---|---|---|
| P2-1 | [SKILL.md:262](../SKILL.md#L262) | 说"检查 5 件事"，`selfcheck.mjs` 实际跑 6 项（多一项"文件引用"） |
| P2-2 | [cc-to-dsh-mapping.md:25](../references/cc-to-dsh-mapping.md#L25) | 优先级写 `100 > 200 > 500 > bundled(600)`；实际为 100 project-dsh / 200 project-agents / 300 custom / 400 user-dsh / 500 user-agents，bundled 不在 rank 表 |
| P2-3 | [SKILL.md:3](../SKILL.md#L3) | `version:` 不是受支持的 frontmatter 字段（支持 `name`/`description`/`whenToUse`/`metadata`/`disable-model-invocation`/`user-invocable`），应放 `metadata.version` |
| P2-4 | [SKILL.md:258](../SKILL.md#L258) | `node tools/selfcheck.mjs` 的代码块被标成 ```powershell |
| P2-5 | — | SKILL.md 9,990 字符，超过 DSH 官方出货 skill 的 ~8,192 字符预算；本次加载未截断，但余量已耗尽 |

## 结构性结论

**强项**：门禁 A/B/C 是这个 skill 最值钱的部分——它敢说"1-2 件事不要编排"。11 条反模式条条命中真实失败模式（假并行、把 `verify` 当形容词、只读摘要拼报告、子 agent 说完成就标 done）。

**缺口**：所有约束都是散文，没有运行时强制。`selfcheck` 只查"结构是否自洽"，查不出"12 > 10""`pwsh` 不存在"这类**语义**错误——它的 PASS 容易被误读成"协议正确"。

建议补一个 `tools/validate-checkpoint.mjs`：读实际 checkpoint，校验 done 任务的 `output` 存在、`waves` 可重算、verifier 与 `verify` 声明匹配。现在这些检查全靠模型在长 turn 里记得做，而长 turn 恰恰最容易忘。

## 下一步（按优先级）

1. ~~修 P1-2 / P1-3：跨平台探测与时间戳~~ ✅ v1.3.0
2. ~~修 P1-1 / P1-4 / P1-5：三处规则互相拆台~~ ✅ v1.3.0
3. ~~补运行时校验器 `validate-checkpoint.mjs`~~ ✅ v1.4.0（含 9 个用例）
4. ~~修 P2 五条文档漂移~~ ✅ v1.3.0
5. ~~明确与 `orchestrate` skill 的分工（或合并）~~ ✅ 已下线该 skill，可借鉴内容并入 [CHANGELOG](../CHANGELOG.md)
