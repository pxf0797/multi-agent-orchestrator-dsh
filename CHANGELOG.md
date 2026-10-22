# 变更记录

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
