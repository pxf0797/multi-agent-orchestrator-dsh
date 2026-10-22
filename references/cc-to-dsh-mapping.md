# Claude Code → DSH 逐项映射

上游 `multi-agent-orchestrator-skill` v2.4.0 里有 **39 个平台耦合点**（Agent/Task/Agent Teams/Bash/python3/路径约定/模型枚举）。本文是它们的处置表，以及 **3 个无法等价替换、必须重写协议**的地方。

处置标记：**等价**（换个名字就行）/ **改写**（能力缺失，协议要变形）/ **删除**（DSH 不需要）/ **新增**（DSH 有、上游没有）。

---

## A. 平台能力原语

| # | 上游 | 想达成什么 | DSH 处置 | DSH 写法 |
|---|---|---|---|---|
| 1 | `Agent(description, prompt, subagent_type, model, run_in_background)` | 派发 worker | **改写** | `subagent(description, prompt, cwd?)`；无 `subagent_type` / `model` / `run_in_background` 参数 |
| 2 | **后台 Agent 完成自动通知**（通知即新 turn） | 调度循环的驱动源，避免忙轮询 | **改写 ★** | DSH 子 agent 结束也会通知父级，但**不保证携带结构化摘要**；且 `workflow` 的子 agent 结果**不回父级**。→ 调度不能再依赖"被通知唤醒"，改为「一波派发完就等结果，结果齐了再推下一波」 |
| 3 | `TaskCreate` → `claude_task_id` | 把 DAG 节点物化为平台任务实体 | **改写** | 无 Task 实体。两轨替代：`todo_write`（给人看的进度）+ checkpoint JSON（给恢复用的真源）。**两者不做双向映射**，JSON 是唯一真源 |
| 4 | `TaskUpdate(addBlockedBy / status)` | 设依赖、改状态、解锁下游 | **删除** | 依赖关系只存在于 checkpoint JSON 的 `blockedBy`；"解锁"= 波次计算，不需要平台 API |
| 5 | `TaskList` | 校验 Task 系统与会话一致 | **删除** | 无此问题（只有一份状态） |
| 6 | **Agent Teams**（TeamCreate + worker 互聊） | Worker 之间双向讨论（如代码评审辩论） | **改写 ★** | 当前 profile **没有 Teams 工具入口**（Host 有 `agentTeams` 服务：`spawnTeammate`/`sendMessage`/任务板，但未暴露成工具；一旦启用，本假设要重写）。现状：`send_message` 只能**相邻**（父↔直系子）；跨子讨论由**父级转述**（把 A 的结论塞进 B 的 prompt） |
| 7 | `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` | Teams 开关 | **删除** | 无 Teams |
| 8 | `ANTHROPIC_BASE_URL` 探测（判断能否用 Teams） | 非官方 API 时禁 Teams | **删除** | 无 Teams，无需探测 |
| 9 | `AskUserQuestion` | 歧义澄清 / HITL 门禁 | **等价** | `ask_user_question(questions:[{id,question,options,multi_select}])`；建议 2-4 个选项并把推荐项放第一位 |
| 10 | **slash command** `/orchestrate`、`/swarm` | 显式入口 | **等价（名字不同）** | DSH 支持 `/name`：用户输入里一个空白分隔的 `/multi-agent-orchestrator` 会把该 skill 的完整指令**直接注入当步**（不经过模型主动加载）。限制：token 必须精确等于 skill 名，`/orchestrate` 无效；短名 `/orch` 靠一个 `disable-model-invocation` 的别名 skill 提供。另有 `/` 菜单按名字模糊匹配 |
| 11 | `~/.claude/orchestrator/` | 唯一状态根目录 | **改写** | `<workspace>/.dsh/orchestrator/`。理由：沙箱只允许写工作区；且会话重启后工作区仍在，家目录隐式状态反而不可发现 |
| 12 | `~/.claude/skills/<name>/references/{roles,sops}/*.md` 自动扫描（新增文件即注册） | 角色/SOP 可扩展 | **删除** | DSH skill 的 `references/` 只是被 `read` 的普通文件，无自动发现。要扩展角色就直接编辑 `role-templates.md` |
| 13 | `~/.claude/skills/<name>/` 安装路径 | skill 本体位置 | **等价** | 优先级（数字越小越优先）：`<projectRoot>/.dsh/skills/` (100) > `<projectRoot>/.agents/skills/` (200) > `customSkillDirs` (300) > `<dshHome>/skills/` (400) > `<agentsHome>/skills/` (500)；内置 skill 由独立 provider 提供，不在这个 rank 表里。目录名必须 kebab-case，文件必须叫 `SKILL.md` |
| 14 | 模型枚举 `haiku/sonnet/opus/fable` | 分配算力 | **改写 ★** | 只有 `workflow` 的 `agent(prompt, {model})` 支持 per-call 覆盖；`subagent` 工具无模型参数（走会话/部署默认路由）。**这是"选 workflow 还是选并行 subagent"的关键判据之一** |

## B. 工具权限原语

| # | 上游 | DSH 处置 | 说明 |
|---|---|---|---|
| 15 | 禁止 Coordinator 用 `Read/Glob/Grep` | **删除** | DSH 里 Coordinator 可以且**应该**读 checkpoint、读产物摘要。上游那条"元数据-only"约束是为了省 coordinator 的上下文，DSH 用「只读 summary + 按需 read 正文」达到同样效果 |
| 16 | 禁止 `Edit/Write` | **改写** | Coordinator 必须自己写 checkpoint / 终稿 / 计划文件。真正的边界是「**不要替子 agent 干活**」，不是"不许写盘" |
| 17 | `Bash` 仅允许 `mkdir/cp/echo` | **删除** | 无 shell 依赖：`write` 自动建父目录，`glob` 代替 `ls`，`grep` 代替 `grep` |
| 18 | `WebSearch/WebFetch` 只给 Researcher | **等价** | 子 agent 同样是完整 agent，有 `web_search`/`web_fetch`；在 prompt 里限定"只做检索、不改盘" |
| 19 | 读 `verdict-<task>.json` 的顶层 `pass/score` | **改写** | DSH 无固定 verdict 约定。两个替代：① 子 agent 用 `output` 契约把 `{pass, issues}` 写进 JSON 文件；② 在 `workflow` 里用 `schema` 直接拿到校验过的 `{pass, issues}`（**更可靠，优先**） |
| 20 | 子 Agent 独立上下文（脑/手解耦） | **等价** | `subagent` = 干净上下文；`subagent_fork` = 继承父级已完成轮次 |

## C. Shell / 系统原语（全部要重写）

| # | 上游命令 | 用途 | DSH 替代 |
|---|---|---|---|
| 21 | `ORCH_ID="orch-$(date +%Y%m%d-%H%M%S)-$$"` | 生成编排 id | 父级自己拼字符串（时间戳 + 3 位随机） |
| 22 | `mkdir -p` ×6 | 建目录 | `write` 自动建父目录；或在第一次 `write` 时一并创建 |
| 23 | `echo $$ > <id>.pid` | 伴生 PID 文件 | **删除**（无进程语义，见 §硬依赖 3） |
| 24 | `kill -0 $PID` | 存活检测 | **删除** |
| 25 | `ps -o comm= -p $PID` | 防 PID 回收误判 | **删除** |
| 26 | `wc -l` + `tail -n +N` | 事件流增量消费 | **改写**：不用行号游标。恢复靠 checkpoint 的 `status` 字段；进度靠 `todo_write` |
| 27 | `echo '...' >> events.jsonl` | 文件系统当 IPC（Agent→Coordinator 单向事件） | **改写**：子 agent 的返回值本身就是事件。需要结构化就用 `workflow` + `schema`，或让子 agent 写 JSON 到 `output/` |
| 28 | `touch teams_disabled` | 永久禁用 Teams | **删除** |
| 29 | `cp` / `rm` / `mv -n` 归档 | 归档不覆盖 | **删除/改写**：归档需要移动/删除文件时用 shell（若可用）；不可用就换个新 id，不归档 |
| 30 | `python3 -c` / `jq` | 解析检查点 JSON | **删除**：模型自己读写 JSON，不需要外部解析器 |
| 31 | `cat <id>.pid` | 读 PID | **删除** |
| 32 | `ls orch-*.json` | 扫描待恢复检查点 | `glob .dsh/orchestrator/checkpoints/*.json` + `read` 比较 `updated_at` |
| 33 | `tail -10 shared.jsonl` | 下游读共享上下文 | **改写**：把"上游 summary"直接拼进下游 prompt（显式、可控，不依赖文件时序） |
| 34 | `find ... -mtime +7 -delete` | 清理归档 | **改写**：`glob` 列目录，**只提示不自动删**（工具集没有删除能力，也不做"是否仍被引用"的判定） |

## D. 提示词 / 文档约定

| # | 上游 | DSH 处置 |
|---|---|---|
| 35 | 引用仓库 `CLAUDE.md` 做自审查 | **等价**：DSH 读工作区的 `AGENTS.md`（若存在）；没有就跳过，不要假装读过 |
| 36 | `subagent_type: "general-purpose"` | **删除**：无类型参数 |
| 37 | 兄弟 skill `workflow-manager`（多阶段项目移交 `/workflow run`） | **删除**：**不要**跨 skill 依赖。DSH 里多阶段就是多次调用本 skill |
| 38 | `PIPE_BUF 512` → 单条事件 ≤500 字节 | **删除**：无管道原子写问题。约束换成「子 agent 返回值 ≤8 行」 |
| 39 | `DW #69551` 内部决策编号 | **删除**：无对应语境 |

---

## ★ 三个硬依赖：不能替换，只能改协议

上游的调度循环建立在三根柱子上。DSH 一根都没有一模一样的东西——**这也是"直接拷 SKILL.md 过来会失灵"的根本原因**。

### 硬依赖 1：后台完成通知驱动 turn

- 上游：`run_in_background: true` 派 agent → 完成时**主动唤醒** Coordinator 并带上结构化摘要 → Coordinator 在新 turn 里处理完成事件。
- DSH：子 agent 结束确实会通知父级，但父级不是"被唤醒进新 turn"的无限循环；`workflow` 里的子 agent 结果**根本不回父级**（只回脚本）。
- 处置：**用"波次"替代"事件循环"**。派发一波 → 等所有结果 → 更新 checkpoint → 派下一波。宁可少一点并发度，换来确定性。这也是 DSH 版比上游**更简单**的原因：不需要事件流、不需要游标、不需要心跳。

### 硬依赖 2：Task 实体 ↔ checkpoint 双写

- 上游：DAG 同时存在于 Claude Task 系统（`claude_task_id` + `addBlockedBy`）和 checkpoint JSON，靠 `task_map` 映射，无对账协议（漂移后谁为准未定义）。
- DSH：只有一份真源（checkpoint JSON）。`todo_write` 是**纯展示层**，允许它与 JSON 短暂不一致，但禁止反向同步（不要在 JSON 里存 todo id）。
- 处置：**删掉双写**。这直接消灭了上游的一整类 bug。

### 硬依赖 3：PID + `ps comm` 判活

- 上游：用 `kill -0` + `ps -o comm=` 判断"另一个窗口是不是还在跑同一个编排"。
- DSH：无进程语义，且 `checkpoint-resume.sh` 实测对 `failed` 任务和 `full` 模式的 `in_progress` 任务**静默丢弃**（上游已知缺陷）。
- 处置：**用状态字段判活**。`running` 一律视为被中断（不做"多少个波次未更新"这类判定——checkpoint 没有波次计数器，那种判据不可判定），恢复时降级为 `pending`。多窗口并发由用户负责（同一 workspace 同时开两个编排时，在报告里提示风险）。

---

## 上游内部矛盾：DSH 版取哪边

上游文本有 7 处自相矛盾（完整清单见工作区 `multi-agent-orchestrator-skill-分析报告.md` §10.3）。移植时必须二选一，本 skill 的取值：

| 矛盾 | 上游 A | 上游 B | 本 skill 取值 |
|---|---|---|---|
| "任务可执行"判定 | `blockedBy` 全 completed | `blockedBy` 为空 | **B**：波次内所有 `blockedBy` 均 `done` 即执行（等价于"上一波完成"，但允许跨波依赖） |
| HITL 是否阻塞并行 | 暂停整个调度 | 其他任务继续 | **暂停整个调度**（Gate 2 卡住时继续派发只会放大浪费） |
| 并发口径 | 按任务类型 12/6/8 | 按模型档位 haiku12/sonnet8/opus≤6 | **按任务类型**（DSH 里 subagent 无模型档位，按模型分档不可执行） |
| 检查点字段 | schema 缺 `agent_output_summary`/`budget` | 正文在用 | **合并为 `summary`**（一个字段，同时服务恢复与汇总） |
| 事件大小上限 | 500 字节（POSIX 管道） | — | **替换为「返回值 ≤8 行」**（可读、可检查） |
| 验证强度成本 | 6x | ~5x | 不写具体倍数（无法核实），只写"Tournament/Adversarial 只在 opt-in 时用" |
| 检查点目录树 | SKILL §5.5 "唯一权威" | design 另有 `snapshots/`+`index.json` | **只保留一种**（见 `checkpoint-protocol.md`），不引入 snapshots |

## DSH 有、上游没有的能力（新增项）

| 能力 | 用法 |
|---|---|
| `workflow` 脚本（`agent`/`parallel`/`pipeline`/`phase`/`log`） | 同构批量扇出；`pipeline` 的阶段间**无屏障**，比上游"波次"更适合逐项流水线 |
| `agent(..., {schema})` 结构化输出 | 替代上游的 verdict JSON 约定，**校验由引擎做**，不会拿到半截 JSON |
| `agent(..., {model})` per-call 模型分档 | 唯一能实现上游"Token 高效模型分配"的地方 |
| `run_in_background` + `job_output`/`job_kill` | 长跑编排后台化 |
| `present` | 交付物以文件卡片形式呈现给用户 |
| `send_message` 追问 / `interrupt_agent` 中止 | 上游 Teams 想做的"双向交互"，在**父子维度**上是原生支持的 |
| `create_goal` / `update_goal` | 跨多轮的长目标编排（上游没有的持久目标概念） |
