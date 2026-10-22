# Workflow 脚本配方（DSH 原生）

`workflow` 工具执行的是**纯 JavaScript 脚本体**：顶层 `await` 可用，最后必须 `return <JSON 值>`。
可用钩子只有 5 个：`agent(prompt, opts)`、`parallel(thunks)`、`pipeline(items, ...stages)`、`phase(title)`、`log(msg)`。

## 硬约束（违反会当场失败，不是可选项）

| 约束 | 后果 | 应对 |
|---|---|---|
| 脚本**没有**文件系统 / 网络 / 定时器 / Node API | 运行时报错 | 子 agent 自己用 write/read 落盘；父级再读 |
| 脚本**没有**递归 `workflow()` | 无法嵌套编排 | 一层脚本 + 分组 `phase()` |
| `agent()` 失败时兑现 `null`（不是抛异常） | 静默缺项 | 每个 stage 后必须 `filter(Boolean)` 并**显式检查长度与空值** |
| 钩子**误用**（拼错选项、schema 超出子集）或**总量上限**（`maxTotalAgents` 1000 / `maxItemsPerCall` 4096）会 `fatal` 终止整个脚本；**并发**超限（`maxConcurrentAgents`）只是排队，不会 fatal | 全盘重来 | 选项只用本文列出的字段；schema 只用于对象根；大规模扇出分批 |
| 运行**没有** checkpoint / 中途恢复 | 进程重启即丢失 | 断点由父级在脚本**外**落盘；见 `references/checkpoint-protocol.md` |
| `return` 的值会成为一次工具结果 | 正文既占父级上下文、又可能被工具结果裁剪 | 脚本只 `return` 索引/摘要，正文留在文件里 |
| 工具调用会**阻塞父级轮次**直到全部结束 | 长任务阻塞 | 需要边跑边干别的就传 `run_in_background: true`，再用 `job_output` |
| `agent()` 的 provider/model 覆盖是按调用生效的 | 选错模型浪费 token | 见下表「模型档位」 |

**脚本开头先校验 `args`**：`if (!args?.orchId) throw new Error('args.orchId required')`。少了它，产物路径会变成 `output/undefined/…`，而且失败点离原因很远。

### 模型档位（script 内，本机实测有效）

```js
agent(p, { model: 'deepseek-flash' })    // 低价档：检索、抽取、格式转换、批量分类
agent(p, { model: 'deepseek-v4-pro' })   // 高价档：架构决策、冲突裁决、最终写作
```

> 只有 `workflow` 里的 `agent()` 支持 per-call 模型覆盖；`subagent` 工具没有模型参数（走会话/部署默认路由）。
> model id **以部署的模型目录为准**（本机：`deepseek-flash` / `deepseek-v4-flash` / `deepseek-v4-pro`，两个 `v4` id 实测可用）。`deepseek-reasoner` 也能被接受，但它不在目录里、是否真路由到高档未核实——别拿它当"贵模型"的保证；换部署时先用 `agent('Reply with exactly: ok', {model:'<id>'})` 探一次。

### `meta.phases` 对照表（必须与脚本里的 `phase()` 标题逐字一致）

| 配方 | `meta.phases` 的 title |
|---|---|
| R1 扇出→汇总 | `breadth`, `synthesis` |
| R2 逐项流水线 | `audit`, `verify` |
| R3 对抗验证 | `attack`, `judge` |
| R4 代码改动 | `analyze`, `implement`, `verify` |
| R5 长跑后台 | 同所用配方的阶段 |
| R6 混合 | `breadth`（之后回父级用 subagent） |

### 返回值契约（父级要能回写 checkpoint）

脚本 `return` 必须是**结构化索引**，让父级能逐任务回写 `status`/`summary`/`error`：

```js
return { tasks: [{ id, status: 'done'|'failed'|'skipped', output, summary, error }], aborted? }
```

不要把正文塞进 `return`——父级只拿索引，正文去文件里读。

---

## R1 · 扇出→汇总（调研 / 审计 / 多视角）

适用：N 个互不依赖的子问题，最后合并成一份报告。

```js
phase('breadth')
const lanes = [
  { id: 'frameworks', q: '对比 4 个主流 X 框架的定位与取舍' },
  { id: 'pricing',    q: '查清它们的定价与许可限制' },
  { id: 'ecosystem',  q: '查清社区活跃度与生产案例' },
]
const notes = await parallel(lanes.map(l => () => agent(
  `研究并落盘。任务：${l.q}\n` +
  `把完整结论（带小标题）写到 .dsh/orchestrator/output/${args.orchId}/${l.id}.md，` +
  `然后只回 ≤8 行：要点、路径、来源、未确认项。`,
  { label: l.id, phase: 'breadth', model: 'deepseek-flash' },
)))
// 关键：用 pairs 同时保住 lane 与其结果，避免下标错位
const pairs = lanes.map((l, i) => ({ l, n: notes[i] })).filter(p => p.n)
if (pairs.length < 2) return { tasks: pairs.map(p => ({ id: p.l.id, status: 'done', output: `.dsh/orchestrator/output/${args.orchId}/${p.l.id}.md`, summary: p.n })), aborted: '不足两条有效分支' }

phase('synthesis')
// 传完整路径，不是 id
const paths = pairs.map(p => `.dsh/orchestrator/output/${args.orchId}/${p.l.id}.md`)
const report = await agent(
  `合成最终报告。逐个读取这些文件并去重、标注冲突：${JSON.stringify(paths)}\n` +
  `写入 .dsh/orchestrator/output/${args.orchId}/final-report.md，` +
  `返回 {path, keyFindings[], openQuestions[]}。`,
  { label: 'synthesize', phase: 'synthesis', model: 'deepseek-v4-pro',
    schema: { type: 'object', properties: { path: { type: 'string' }, keyFindings: { type: 'array', items: { type: 'string' } }, openQuestions: { type: 'array', items: { type: 'string' } } }, required: ['path', 'keyFindings'], additionalProperties: false } },
)
return {
  tasks: pairs.map(p => ({ id: p.l.id, status: 'done', output: `.dsh/orchestrator/output/${args.orchId}/${p.l.id}.md`, summary: p.n })),
  report,
}
```

## R2 · 逐项流水线（跨文件**只读**审计）

用 `pipeline` 而不是 `parallel`：每一项**独立穿过**所有阶段，阶段间**没有屏障**，慢项不拖住快项。

> ⚠️ 只用于**只读**审计或"生成到 output 目录"。写回源文件的批量迁移**不能**用 pipeline：每一项都会并发写同一批文件。

```js
const all = args?.files            // 父级放进 args，脚本不读盘
if (!args?.orchId || !Array.isArray(all) || !all.length) throw new Error('args.orchId / args.files 缺失')
// 一个批次 = 一个正式任务。分批靠 offset 游标，`next` 非空就带回去续跑
const MAX = 10                     // 单批文件数：每文件 2 个 agent → 单次调用 20 个
const offset = typeof args?.offset === 'number' ? args.offset : 0
const files = all.slice(offset, offset + MAX)
if (!files.length) throw new Error(`offset ${offset} 超出范围（共 ${all.length} 项）`)
// 产物名必须唯一：把目录一起 slug，否则 a/index.ts 与 b/index.ts 会互相覆盖
const slug = (f) => f.replace(/^[A-Za-z]:/, '').replace(/[\\/]+/g, '__').replace(/[^\w.-]/g, '_')
phase('audit')
const results = await pipeline(
  files,
  (f) => {
    const out = `.dsh/orchestrator/output/${args.orchId}/${slug(f)}.audit.md`
    return agent(`审阅 ${f}（只读，不要改它）：找正确性缺陷，带小标题写到 ${out}，回 ≤8 行摘要 + 路径。`,
      { label: `audit:${f}`, phase: 'audit', model: 'deepseek-flash' })
  },
  async (prev, f) => {
    const out = `.dsh/orchestrator/output/${args.orchId}/${slug(f)}.audit.md`
    // 让 verifier 读产物全文，而不是只拿到 8 行摘要
    return prev ? agent(`核对这份审阅是否有误报。先读全文：${out}\n文件：${f}。回 ≤8 行：成立/误报清单。`,
      { label: `verify:${f}`, phase: 'verify', model: 'deepseek-flash' }) : null
  },
)
const ok = results.filter(Boolean)
const next = offset + files.length < all.length ? offset + files.length : null
return {
  // 只回一条聚合任务：逐项明细在 output 目录里，**不要**给每个文件造一个任务 id
  tasks: [{
    id: args.taskId ?? 'T2',
    status: ok.length ? 'done' : 'failed',
    output: `.dsh/orchestrator/output/${args.orchId}/`,
    summary: `审计 ${ok.length}/${files.length} 项（累计 ${offset + files.length}/${all.length}）`,
    error: ok.length ? null : 'pipeline item failed',
  }],
  counted: { total: all.length, processed: files.length, audited: ok.length },
  next,                            // 非 null → 父级用 args.offset=next 再调一次
}
```

**要点**：批次边界就是 checkpoint 任务边界——一次调用回一条 `tasks[]`。否则 50 个文件会变成 50 个任务，既违反 3-10 任务上限，也会让 `id` 与 plan 对不上号。`next` 非空就续跑下一批，别一次塞进全部文件。

## R3 · 对抗式验证（结论可信度）

一个主张 → 3 个独立怀疑者 → 1 个裁决者。比让同一个 agent「自查」可靠得多。

```js
// 视角措辞与 role-templates.md 的 adversarial-verifier 逐字一致
const angles = ['反例与边界条件', '证据是否支撑', '有无更简单的解释']
phase('attack')
const attacks = await parallel(angles.map((a, i) => () => agent(
  `你是怀疑者。视角：${a}。只找出该主张的漏洞，给出可检验的反驳（带证据）。\n` +
  `把完整反驳写到 .dsh/orchestrator/output/${args.orchId}/attack-${i}.md，回 ≤8 行摘要 + 路径。\n` +
  `主张：${args.claim}`,
  { label: a, phase: 'attack', model: 'deepseek-flash' },
)))
phase('judge')
// 只把摘要与证据交给裁决者，正文留在文件里，避免上下文与截断问题
return await agent(
  `裁决以下攻击是否成立。每条给出：成立/不成立 + 理由。可用全文：` +
  `${JSON.stringify(angles.map((_, i) => `.dsh/orchestrator/output/${args.orchId}/attack-${i}.md`))}\n` +
  `攻击摘要：${JSON.stringify(attacks.filter(Boolean))}`,
  { label: 'judge', phase: 'judge', model: 'deepseek-v4-pro',
    schema: { type: 'object', properties: { verdict: { type: 'string' }, confidence: { type: 'number' }, reasons: { type: 'array', items: { type: 'string' } } }, required: ['verdict', 'confidence'], additionalProperties: false } },
)
```

## R4 · 代码改动（必须串行写入 + 独立验证）

写同一份代码的 agent 不能并行。扇出只用在「读」上。

```js
phase('analyze')
const out = `.dsh/orchestrator/output/${args.orchId}`
const [arch, tests] = await parallel([
  () => agent(`读代码并给出改动方案（不改代码），写到 ${out}/plan.md，回 ≤8 行摘要。`, { label: 'arch', phase: 'analyze', model: 'deepseek-v4-pro' }),
  () => agent(`找出覆盖该模块的现有测试与缺口，写到 ${out}/test-gaps.md，回 ≤8 行摘要。`, { label: 'tests', phase: 'analyze', model: 'deepseek-flash' }),
])
if (!arch || !tests) return { tasks: [{ id: 'T2', status: 'failed', error: '分析阶段缺失' }], aborted: '分析阶段缺失' }

phase('implement')
const impl = await agent(`按 ${out}/plan.md 与 ${out}/test-gaps.md 实施改动，逐文件写盘；把改动文件清单写到 ${out}/changed-files.json（{"files":[...]}）；跑测试。回 ≤8 行：changedFiles、testResult。`,
  { label: 'implement', phase: 'implement', model: 'deepseek-v4-pro' })
if (!impl) return { tasks: [{ id: 'T3', status: 'failed', error: '实现阶段无返回' }], aborted: '实现阶段无返回' }

phase('verify')
// 关键：把改动清单交给 verifier，而不是把实现者的自述当证据
const verdict = await agent(`独立验证这次改动。先读改动清单 ${out}/changed-files.json，再自己读被改文件、跑检查；不要用实现者的说法当证据（无 shell 时改为静态核对并写明「未执行」）。回 {pass, issues[]}`,
  { label: 'verify', phase: 'verify',
    schema: { type: 'object', properties: { pass: { type: 'boolean' }, issues: { type: 'array', items: { type: 'string' } } }, required: ['pass'], additionalProperties: false } })
return { tasks: [{ id: 'T3', status: 'done', summary: impl }, { id: 'T3v', status: verdict?.pass ? 'done' : 'failed', summary: JSON.stringify(verdict) }] }
```

**修复回路**：验证不通过时不要在脚本里递归重试，直接 `return { verdict }` 回到父级，由父级决定「再派一次」还是「停下来问用户」——重试需要新的信息（issue 列表）和人类裁决，而脚本里拿不到人。

## R5 · 长跑后台

```js
// 父级调用时：run_in_background: true → 立刻拿 jobId
// 之后：job_output(jobId) 看进度，job_kill(jobId) 中止
// 注意：后台运行在结算前的 job_output 只给状态，不给中间值
```

适合：>10 分钟的大规模审计、多仓库迁移。不适合需要中途介入的任务（脚本跑起来就无法 steer，`send_message` 也够不到脚本里的子 agent）。

## R6 · 混合模式

`hybrid`：先用一次 `workflow` 做广度扇出（便宜、并行、有结构化输出），回到父级后对**最有价值的 2-3 条**用 `subagent` 深挖（可 `send_message` 追问），最后父级自己写终稿。

这是 DSH 上性价比最高的形态：广度交给脚本，深度留在可对话的层级。
