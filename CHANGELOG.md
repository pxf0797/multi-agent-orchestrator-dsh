# 变更记录

## v1.5.0（2026-10-22）

基线：`orch-20261022-224016-675` 这次真实编排（8 任务 / 6 agent / 2 次退回返工 / 15 分钟，产出 9 个文件）。下面 7 条都是那次跑出来的缺口，不是理论推演。

### 1. 返工派给谁，协议没说

**现象**：T2v 判 fail 后要改 3 处。新开 subagent 要重读 27 KB 产物 + 36 KB 原文 + 重跑取证；`send_message` 回原 agent 两分钟改完。协议只写"重派"。

**改法**：`SKILL.md` §7.1、`checkpoint-protocol.md` §升级与传播 明确——返工优先 `send_message(agent_id, issues 原文)` 复用原上下文，计一次派发（`attempts += 1`、`ref` 不变），改完回**原 verifier** 复审。

### 2. 被否掉的那一版没了

**现象**：T2 修正版覆盖了第一版，checkpoint 只有单个 `output`；若第二次仍 fail、要交人裁决，拿不出"被否的那一版"。

**改法**：新增 `previous_outputs[]`（`returns > 0` 时必填），产物另起名 `<id>-claims-r2.md`；validator 新增规则，schema 2 下缺失即报错。

### 3. `pass` 但带 major，然后就结束了

**现象**：T4v 给 `pass`，却列了 3 条 major（其中"#23 应判成立"是事实错误）。按旧协议 pass 即结束，错误结论被终稿继承。

**改法**：`verdict` 增加 `pass_with_issues`；合成规则要求把其中的 blocker/major 逐条列入终稿「已知偏差」；新增 `issue_counts` 字段，`pass` 却带 blocker/major 时 validator 提示改标。

### 4. 三档数字没人管守恒

**现象**：同一次运行错两回——我给 T2 的 "32/2/1" 少了 C29 那一条（应为 31/2/2）；T3v 首轮 "13/7/2" 漏算 #20（应为 13/6/3）。两次都靠 agent 顶回来才发现。

**改法**：新增 `counted: {total, pass, fail, unverifiable}`；validator 校验三档相加等于 `total`，且与 `summary` 里的数字一致。

### 5. waves 只能手改

**改法**：`validate-checkpoint --fix-waves` 把按 `blockedBy` 重算的 waves 直接写回文件；不开这个开关时，报错信息里会提示。

### 6. summary 装不下产物

**改法**：契约收紧为"摘要只放数字口径 + 一句结论 + 路径"，不复述正文（27 KB 的核对表塞进 8 行只会丢信息）。

### 7. 终稿没有"依据清单"

**改法**：终稿末尾必须列读了哪些产物/哪几段；validator 在 `status=done` 时软检查「未确认」「依据」两段是否存在。

### 兼容性

`schema_version` 升到 `2`。`1` 保持可读：上述新规则的违规只按**警告**处理，不判错，老编排不用改文件。模板同步为 2。

### 测试

`test/validate.test.mjs` 从 9 个用例扩到 **16 个**，新增：counted 不守恒、counted 与 summary 不一致、returns>0 缺 previous_outputs、判 fail 未返工、pass 带 major 的提示、`--fix-waves` 回写、终稿缺「依据」。

## v1.4.0（2026-10-22）

新增运行时校验器——补上 v1.3.0 评审指出的那句"所有约束都是散文"的洞：`selfcheck` 只能查文档与模板是否自洽，查不出一次真实编排里"done 了但产物没落盘"。

### 新增 `tools/validate-checkpoint.mjs`

输入一份真实 checkpoint，校验：

- 顶层：`schema_version`、`orchestrator_id` 格式、带时区的 ISO 时间戳、`scenario`/`mode`/顶层 `status` 枚举、`plan` 前缀、`goal` 非空
- 任务表：3-10 个、id 唯一且合规、`role` 在角色池内、`blockedBy` 只能指向**更早**的任务、`verify`/`dispatch`/`criticality`/任务 `status` 枚举、`completion_criteria` 在 standard 及以上必填
- **waves 可重算**：按 `blockedBy` 重算并与文件里的 `waves` 逐波比对，不一致直接报错并给出期望值
- **verifier 真的展开了**：`standard`→`<id>v`、`strict`→`v1..v3`、`tournament|adversarial`→至少一个 `*v`，且 verifier 的 `blockedBy` 必须包含被验任务
- **产物真的存在**：done 任务的 `output` 存在且非空；顶层 `done` 时还要求全部任务终态、`final-report.md` 存在
- **口径自洽**：done ⇒ `attempts ≥ 1` 且有 `summary`；`verdict` 只出现在 verifier 上；`upstream failed` 要真的有失败上游；verifier 判 `fail` 却下游已 `done` 会告警

退出码：`0` 通过（可有警告）/ `1` 有错误 / `2` 用法或解析错误。选项：`--root <ws>`、`--no-files`、`--json`。

### 新增测试

`test/validate.test.mjs`（`node:test`，9 个用例）：模板通过、waves 改坏、缺 verifier、前向依赖（并断言不栈溢出）、done 无产物、done 但 attempts=0、坏时间戳/枚举、完整 workspace 通过、缺参数 exit 2。

`npm test` 现在是 `selfcheck + validate 用例`，CI 改跑 `npm test`。

### 其他

- `checkpoint-protocol.md` 恢复流程后补一句：手边有 checkpoint 时先跑 validator，把"产物在不在 / waves 对不对 / verifier 有没有展开"一次查完。
- README 增加「自检与校验」分工说明与退出码表。

## v1.3.0（2026-10-22）

基线：[v1.2.0 评审](docs/review-v1.2.0.md)。本轮修完 P1 全部 5 条、P2 全部 5 条，并吸收了已下线的 `orchestrate` skill 中值得保留的部分。

### P1 修复（影响行为）

| # | 改动 | 位置 |
|---|---|---|
| P1-1 | `deep_research` 同波上限 12 → **10**，与运行时 `maxParallelToolCalls` 对齐；删掉"12 路并行是错觉"的免责句 | `SKILL.md` §3 |
| P1-2 | 环境探测改为 **`bash` 优先**（`bash -c 'echo ok'`，Windows 无 bash 才用 `pwsh`），两个都不通才算无 shell。原写法在 macOS/Linux 上必然探测失败，会把所有命令类验收降级成静态核对 | `SKILL.md` §7.2、`verification-levels.md` |
| P1-3 | 时间戳从 `Get-Date -Format o` 改为 `date -u +%Y-%m-%dT%H:%M:%S%z`（Windows 保留备选） | `checkpoint-protocol.md` |
| P1-4 | Gate 1 阈值 **>6 → >8**，并说明研究类 `light` 分支（5-6 任务）不触发确认；Gate 表同步 | `SKILL.md` 门禁 C、§6、`scenario-dags.md` |
| P1-5 | R2 从"每个文件一条 task"改为**批次 = 一个任务**，新增 `MAX=10` 分批与 `offset`/`next` 游标；逐项明细留在 `output/` 目录，不进 checkpoint | `workflow-recipes.md` R2 |

### P2 修复（文档一致性）

- 自检项数声明 5 → **8**，与 `selfcheck.mjs` 实际项数一致。
- skill 根目录优先级表补上 300（`customSkillDirs`）与 400（`<dshHome>/skills`），移除不存在的 "bundled (600)"。
- `version` 从 frontmatter 顶层移入 `metadata.version`（顶层不是受支持字段）。
- `node tools/selfcheck.mjs` 的代码块语言 `powershell` → `bash`。
- `SKILL.md` **9,990 → 8,187 字符**，回到 8,192 预算内（§2/§3/§4/§5/§8 去掉与 references 重复的内容，信号保留、复述删除）。

### 新增自检（防止同类漂移）

- **check 7 · 字符预算**：`SKILL.md` 超 8,192 字符即 FAIL。
- **check 8 · 项数声明**：文档里「检查 N 件事」的 N 必须等于实际检查数。

### 借鉴自已下线的 `orchestrate` skill

| 内容 | 落到哪 |
|---|---|
| 判决 schema：`{pass, score, issues[{severity,where,problem,fix}], summary}`；severity 只取 `critical/major/minor` | `verification-levels.md` |
| 退回时 **issues 原文回灌**给产出者的模板（不做二次概括） | `verification-levels.md` |
| 四条纪律：产出者不自评 / verifier 不改产物 / 融合交给 writer / 能跑就别只读 | `verification-levels.md` |
| prompt 三句通用前置（看不到主对话 / 不能派发 / 大段写文件） | `dag-schema.md` prompt 模板、`role-templates.md` |
| 三类重试预算不混用（`returns` / `attempts` / 整轮重跑=1）+ 每次重试必须改变输入 | `SKILL.md` §7.1、`checkpoint-protocol.md` |
| 结构性失败信号：同一波 ≥2 个任务因**同一原因**失败 → 停止扇出、回 DAG 重拆 | `SKILL.md` §7.1、`checkpoint-protocol.md` |
| 成本护栏：>10 agent 先给选项 / 单次 workflow >20 拆批 / 耗时超预估 3 倍停手 | `SKILL.md` §3 |

### 未采纳（连同 skill 一起下线）

- 无 checkpoint 的 workflow-first 默认路径 —— 与本项目"可续跑"的定位冲突。
- `.orchestrate/<slug>/state.json` —— 已被 `checkpoint JSON` 取代。
- 4 级验证、`haiku/sonnet/opus` 分档 —— 本项目 5 级验证是其超集；DSH 无模型分档。

## v1.2.0（2026-10-21）

- waves 示例纠正并与模板统一；`plan` 改工作区相对路径。
- Strict 判失败与执行失败分离（`verdict` 与 `status` 两个轴）。
- done 增加产物校验（`output` 缺失 → `failed`）。
- 并发表补运行时事实、区分 fatal 类型；修正 `maxResultChars` 归属。
- R2 产物去重名、R4 不再把自述当证据。
- hybrid 的 checkpoint 映射；`attempts` 对 inline 的例外；删除与 references 重复的表。
