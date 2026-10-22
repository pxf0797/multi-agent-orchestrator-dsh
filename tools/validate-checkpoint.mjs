#!/usr/bin/env node
// tools/validate-checkpoint.mjs — 校验一份**真实**的编排 checkpoint
//
// selfcheck.mjs 校验的是"文档与模板的结构"，本脚本校验的是"跑起来的编排状态":
// waves 能否重算、done 的产物是否真存在、verifier 是否真的展开了、失败是否按协议传播。
//
// Usage:
//   node tools/validate-checkpoint.mjs <checkpoint.json> [--root <workspace>] [--no-files] [--json]
//
// Exit: 0 = 通过（可以有警告） 1 = 有错误 2 = 用法/解析错误

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const skillRoot = path.resolve(here, '..')

// ---------- CLI ----------
const opts = { file: null, root: null, rootExplicit: false, files: true, json: false, fixWaves: false }
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--root') { opts.root = path.resolve(argv[++i] ?? '.'); opts.rootExplicit = true }
  else if (a === '--no-files') opts.files = false
  else if (a === '--fix-waves') opts.fixWaves = true
  else if (a === '--json') opts.json = true
  else if (a === '-h' || a === '--help') { usage(); process.exit(0) }
  else if (a.startsWith('-')) { console.error(`未知参数: ${a}`); usage(); process.exit(2) }
  else if (!opts.file) opts.file = a
  else { console.error(`多余的参数: ${a}`); process.exit(2) }
}
if (!opts.file) { usage(); process.exit(2) }

// --root 没给就按 checkpoint 的位置反推工作区（.../.dsh/orchestrator/checkpoints/x.json）
if (!opts.rootExplicit) {
  const abs = path.resolve(opts.file)
  const marker = `${path.sep}.dsh${path.sep}orchestrator${path.sep}checkpoints${path.sep}`
  const i = abs.lastIndexOf(marker)
  opts.root = i > 0 ? abs.slice(0, i) : process.cwd()
}

function usage() {
  console.error(`用法: node tools/validate-checkpoint.mjs <checkpoint.json> [--root <workspace>] [--no-files] [--json]

  --root <dir>   工作区根目录。默认从 checkpoint 路径反推（.../.dsh/orchestrator/checkpoints/x.json），推不出才用当前目录。
  --no-files     跳过文件存在性校验（用于校验尚未产生产物的模板）。
  --fix-waves    把按 blockedBy 重算出的 waves 直接写回文件（其余校验照跑）。
  --json         以 JSON 输出结果。`)
}

// ---------- 基础 ----------
const ORCH_ID = /^orch-\d{8}-\d{6}-\d{3}$/
const TASK_ID = /^T\d{1,2}v?\d?$/
const VERIFIER_ID = /^T\d{1,2}v\d*$/
const ISO_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

const MODES = new Set(['wave', 'workflow', 'hybrid'])
const SCENARIOS = new Set(['deep_research', 'code_dev', 'deploy_verify', 'general'])
const TOP_STATUS = new Set(['running', 'awaiting_human', 'done', 'failed', 'aborted'])
const TASK_STATUS = new Set(['pending', 'running', 'done', 'failed', 'skipped'])
const VERIFY = new Set(['light', 'standard', 'strict', 'tournament', 'adversarial'])
const DISPATCH = new Set(['subagent', 'workflow', 'inline'])
const CRITICALITY = new Set(['critical', 'normal', 'nice-to-have'])
const VERDICT = new Set(['pass', 'fail', 'pass_with_issues'])
const GATE_AT = new Set(['before_dispatch', 'blocked', 'before_delivery'])
const PLAN_PREFIX = '.dsh/orchestrator/plans/'
const OUTPUT_PREFIX = '.dsh/orchestrator/output/'
const PLACEHOLDER_GOAL = /替换为用户原话/

const errors = []
const warnings = []
const E = (code, msg) => errors.push({ code, msg })
const W = (code, msg) => warnings.push({ code, msg })

// 角色池从 role-templates.md 的标题里取，和 selfcheck 同一口径
const rolePool = new Set(
  [...fs.readFileSync(path.join(skillRoot, 'references/role-templates.md'), 'utf8')
    .matchAll(/^#{2,3}\s*\d+\.\s*`([a-z-]+)`/gm)].map((m) => m[1]),
)

// ---------- 读入 ----------
let cp
try {
  cp = JSON.parse(fs.readFileSync(opts.file, 'utf8').replace(/^\uFEFF/, ''))
} catch (e) {
  console.error(`无法读取或解析 ${opts.file}: ${e.message}`)
  process.exit(2)
}
if (!cp || typeof cp !== 'object' || Array.isArray(cp)) {
  console.error('checkpoint 顶层必须是 JSON 对象')
  process.exit(2)
}

const isStr = (v) => typeof v === 'string' && v.trim() !== ''
const isInt = (v) => Number.isInteger(v)
const ts = (v) => isStr(v) && ISO_TZ.test(v) && !Number.isNaN(Date.parse(v))

const V2 = cp.schema_version === 2
// schema 1 的老编排没有新字段，这些规则降级为警告；schema 2 起按错误处理
const rule = (code, msg) => (V2 ? E(code, msg) : W(code, msg))

// ---------- 1. 顶层字段 ----------
const required = ['schema_version', 'orchestrator_id', 'created_at', 'updated_at', 'scenario', 'goal', 'mode', 'status', 'plan', 'waves', 'tasks']
for (const k of required) if (!(k in cp)) E('top.missing', `缺字段 ${k}`)

if (![1, 2].includes(cp.schema_version)) {
  E('schema_version', `不认识的 schema_version: ${JSON.stringify(cp.schema_version)}（支持 1 / 2；不认识的版本应只读，不自动续跑）`)
} else if (cp.schema_version === 1) {
  W('schema_version', 'schema_version=1：counted / previous_outputs / pass_with_issues 只按警告处理；新建编排请用 2')
}

const orchId = cp.orchestrator_id
if (!isStr(orchId) || !ORCH_ID.test(orchId)) E('orchestrator_id', `orchestrator_id 应形如 orch-YYYYMMDD-HHMMSS-<3位>，实际 ${JSON.stringify(orchId)}`)

for (const k of ['created_at', 'updated_at']) {
  if (!ts(cp[k])) E('timestamp', `${k} 不是带时区的 ISO 8601：${JSON.stringify(cp[k])}`)
}
if (ts(cp.created_at) && ts(cp.updated_at) && Date.parse(cp.updated_at) < Date.parse(cp.created_at)) {
  E('timestamp', 'updated_at 早于 created_at')
}

if (!SCENARIOS.has(cp.scenario)) E('enum', `scenario 非法: ${JSON.stringify(cp.scenario)}`)
if (!MODES.has(cp.mode)) E('enum', `mode 非法: ${JSON.stringify(cp.mode)}`)
if (!TOP_STATUS.has(cp.status)) E('enum', `顶层 status 非法: ${JSON.stringify(cp.status)}`)
if (!isStr(cp.goal)) E('goal', 'goal 不能为空（应是用户原话）')
else if (PLACEHOLDER_GOAL.test(cp.goal)) W('goal', 'goal 仍是模板占位符「替换为用户原话」，恢复时无法靠它匹配意图')

if (!isStr(cp.plan)) E('plan', 'plan 不能为空')
else if (!cp.plan.startsWith(PLAN_PREFIX)) E('plan', `plan 必须以 ${PLAN_PREFIX} 开头（工作区相对路径），实际 ${cp.plan}`)
else if (!cp.plan.endsWith('.md')) E('plan', `plan 应指向 .md 文件，实际 ${cp.plan}`)

// ---------- 2. 任务表 ----------
const tasks = Array.isArray(cp.tasks) ? cp.tasks : []
if (!Array.isArray(cp.tasks)) E('tasks', 'tasks 必须是数组')
if (tasks.length < 3 || tasks.length > 10) E('tasks.count', `任务数 ${tasks.length} 不在 3-10`)

const byId = new Map()
const order = new Map()
tasks.forEach((t, i) => {
  if (!t || typeof t !== 'object') { E('task.shape', `tasks[${i}] 不是对象`); return }
  if (!isStr(t.id)) { E('task.id', `tasks[${i}] 缺 id`); return }
  if (byId.has(t.id)) E('task.id', `任务 id 重复: ${t.id}`)
  if (!TASK_ID.test(t.id)) E('task.id', `任务 id 不合规: ${t.id}（应形如 T2 / T2v / T2v1）`)
  byId.set(t.id, t)
  order.set(t.id, i)
})
for (const t of byId.values()) {
  const at = `任务 ${t.id}`
  if (!isStr(t.subject)) E('task.subject', `${at} 缺 subject`)
  if (!rolePool.has(t.role)) E('task.role', `${at} 的 role "${t.role}" 不在角色池 [${[...rolePool].join(', ')}]`)
  if (t.criticality !== undefined && !CRITICALITY.has(t.criticality)) E('enum', `${at} 的 criticality 非法: ${JSON.stringify(t.criticality)}`)
  if (!TASK_STATUS.has(t.status)) E('enum', `${at} 的 status 非法: ${JSON.stringify(t.status)}`)
  if (t.dispatch !== undefined && !DISPATCH.has(t.dispatch)) E('enum', `${at} 的 dispatch 非法: ${JSON.stringify(t.dispatch)}`)
  if (t.verify !== undefined && !VERIFY.has(t.verify)) E('enum', `${at} 的 verify 非法: ${JSON.stringify(t.verify)}`)
  if (t.verify === undefined) W('task.verify', `${at} 没写 verify，按缺省 standard 处理`)

  const verify = t.verify ?? 'standard'
  if (verify !== 'light' && !isStr(t.completion_criteria)) {
    E('task.criteria', `${at} 的 verify=${verify}，必须给 completion_criteria（否则 verifier 只能凭感觉打分）`)
  }

  if (!isInt(t.attempts) || t.attempts < 0) E('task.attempts', `${at} 的 attempts 必须是非负整数，实际 ${JSON.stringify(t.attempts)}`)
  if (t.returns !== undefined && (!isInt(t.returns) || t.returns < 0)) E('task.returns', `${at} 的 returns 必须是非负整数`)
  if (t.status === 'done' && isInt(t.attempts) && t.attempts < 1) E('task.attempts', `${at} 已 done 但 attempts=0（inline 完成任务也要记 1）`)
  if (t.status === 'done' && !isStr(t.summary)) E('task.summary', `${at} 已 done 但缺 summary`)
  if (isStr(t.summary) && t.summary.split('\n').length > 8) W('task.summary', `${at} 的 summary 超过 8 行（约定 ≤8 行）`)

  const isVerifier = VERIFIER_ID.test(t.id)
  if (t.verdict !== undefined && t.verdict !== null && !VERDICT.has(t.verdict)) {
    E('task.verdict', `${at} 的 verdict 非法: ${JSON.stringify(t.verdict)}`)
  }
  if (t.verdict && !isVerifier) W('task.verdict', `${at} 不是 verifier 任务却有 verdict=${t.verdict}`)
  if (isVerifier && t.verdict === undefined) W('task.verdict', `${at} 是 verifier 但没写 verdict（未裁决应为 null）`)
  if (t.dispatch === 'inline' && t.ref) W('task.ref', `${at} 是 inline 任务，ref 应为 null`)
  if (t.dispatch === 'subagent' && t.status === 'done' && !isStr(t.ref)) W('task.ref', `${at} 是 subagent 任务且已 done，但缺 ref（agent id）`)

  // counted：三档数字必须守恒，且与 summary 写的一致
  if (t.counted !== undefined) {
    const c = t.counted
    if (!c || typeof c !== 'object' || Array.isArray(c)) E('task.counted', `${at} 的 counted 必须是对象`)
    else {
      const okShape = ['total', 'pass', 'fail', 'unverifiable'].every((k) => isInt(c[k]) && c[k] >= 0)
      if (!okShape) E('task.counted', `${at} 的 counted 需要非负整数 total / pass / fail / unverifiable`)
      else if (c.pass + c.fail + c.unverifiable !== c.total) {
        rule('task.counted', `${at} 的 counted 不守恒：${c.pass}+${c.fail}+${c.unverifiable}=${c.pass + c.fail + c.unverifiable} ≠ total ${c.total}`)
      }
      const m = isStr(t.summary) ? t.summary.match(/成立\s*(\d+)\s*[/／]\s*不成立\s*(\d+)\s*[/／]\s*无法核验\s*(\d+)/) : null
      if (m && okShape) {
        const p = Number(m[1]), f = Number(m[2]), u = Number(m[3])
        if (p !== c.pass || f !== c.fail || u !== c.unverifiable) {
          E('task.counted', `${at} 的 summary 写 ${p}/${f}/${u}，counted 写 ${c.pass}/${c.fail}/${c.unverifiable}——两处必须一致`)
        }
      }
    }
  } else if (isStr(t.summary) && /成立\s*\d+\s*[/／]\s*不成立/.test(t.summary)) {
    W('task.counted', `${at} 的 summary 里有三档数字，建议加 counted 字段让 validator 校验守恒`)
  }

  // issue_counts：verifier 的问题分布
  if (t.issue_counts !== undefined) {
    const ic = t.issue_counts
    if (!ic || typeof ic !== 'object' || Array.isArray(ic)) E('task.issue_counts', `${at} 的 issue_counts 必须是对象`)
    else {
      let sum = 0
      for (const k of ['blocker', 'major', 'minor']) {
        if (!isInt(ic[k]) || ic[k] < 0) E('task.issue_counts', `${at} 的 issue_counts.${k} 必须是非负整数`)
        else sum += ic[k]
      }
      if (sum === 0 && t.verdict && t.verdict !== 'pass') W('task.issue_counts', `${at} 判了 ${t.verdict} 却没有任何 issue`)
    }
  }

  // previous_outputs：被否掉的那一版必须留痕
  if (t.previous_outputs !== undefined) {
    if (!Array.isArray(t.previous_outputs)) E('task.previous_outputs', `${at} 的 previous_outputs 必须是数组`)
    else {
      for (const prev of t.previous_outputs) {
        if (!isStr(prev)) E('task.previous_outputs', `${at} 的 previous_outputs 含非字符串项`)
        else if (!prev.startsWith(`${OUTPUT_PREFIX}${orchId}/`)) E('task.previous_outputs', `${at} 的 previous_outputs 必须以 ${OUTPUT_PREFIX}${orchId}/ 开头：${prev}`)
        else if (prev === t.output) E('task.previous_outputs', `${at} 的 output 不能同时出现在 previous_outputs 里`)
      }
      if (!t.returns) W('task.previous_outputs', `${at} 有 previous_outputs 但 returns=0`)
    }
  }
  if (isInt(t.returns) && t.returns > 0 && (!Array.isArray(t.previous_outputs) || t.previous_outputs.length === 0)) {
    rule('task.previous_outputs', `${at} 的 returns=${t.returns}，但没有 previous_outputs——被 verifier 否掉的那一版没留痕`)
  }

  if (!isStr(t.output)) E('task.output', `${at} 缺 output`)
  else if (!t.output.startsWith(`${OUTPUT_PREFIX}${orchId}/`)) {
    E('task.output', `${at} 的 output 必须以 ${OUTPUT_PREFIX}${orchId}/ 开头，实际 ${t.output}`)
  }

  // blockedBy：只指向更早的任务，无环，无自指
  if (!Array.isArray(t.blockedBy)) E('task.blockedBy', `${at} 的 blockedBy 必须是数组`)
  else for (const b of t.blockedBy) {
    if (!byId.has(b)) E('task.blockedBy', `${at} 依赖了不存在的任务 ${b}`)
    else if (b === t.id) E('task.blockedBy', `${at} 依赖了自己`)
    else if (order.get(b) >= order.get(t.id)) E('task.blockedBy', `${at} 依赖了不早于它的任务 ${b}（协议要求只能指向更早的任务）`)
  }
}

// ---------- 2b. 判定失败必须真的走返工 ----------
for (const t of byId.values()) {
  if (!VERIFIER_ID.test(t.id) || t.verdict !== 'fail') continue
  const target = byId.get(t.id.replace(/v\d*$/, ''))
  if (target && isInt(target.returns) && target.returns < 1) {
    rule('state', `${t.id} 判 fail，但被验任务 ${target.id} 的 returns=0（没走返工）`)
  }
  if (target && target.status === 'done' && !(target.previous_outputs ?? []).length) {
    W('state', `${t.id} 判 fail 且 ${target.id} 已返工完成，但没有任何 previous_outputs 可追溯`)
  }
}
// pass 与 issue 计数要自洽
for (const t of byId.values()) {
  if (!VERIFIER_ID.test(t.id) || !t.issue_counts) continue
  const bad = (t.issue_counts.blocker ?? 0) + (t.issue_counts.major ?? 0)
  if (t.verdict === 'pass' && bad > 0) W('state', `${t.id} 判 pass 但有 ${bad} 条 blocker/major——应标 pass_with_issues 并在终稿「已知偏差」里列出`)
  if (t.verdict === 'pass_with_issues' && bad === 0) W('state', `${t.id} 标了 pass_with_issues 却没有 blocker/major`)
}

// ---------- 3. waves 重算 ----------
const memo = new Map()
function waveOf(id, seen = new Set()) {
  if (memo.has(id)) return memo.get(id)
  // 环已经由 blockedBy 检查报过错了；这里不递归，返回 0 兜底
  if (seen.has(id)) return 0
  seen.add(id)
  const t = byId.get(id)
  const deps = Array.isArray(t?.blockedBy) ? t.blockedBy.filter((b) => byId.has(b)) : []
  const w = deps.length ? 1 + Math.max(...deps.map((b) => waveOf(b, seen))) : 0
  seen.delete(id)
  memo.set(id, w)
  return w
}
const expected = {}
for (const id of byId.keys()) {
  const w = waveOf(id)
  ;(expected[w] ??= []).push(id)
}
const normalizeWaves = (o) => Object.keys(o ?? {})
  .filter((k) => Array.isArray(o[k]))
  .sort((a, b) => Number(a) - Number(b))
  .map((k) => [k, [...o[k]].sort()])

let wavesFixed = false
if (!cp.waves || typeof cp.waves !== 'object' || Array.isArray(cp.waves)) {
  E('waves', 'waves 必须是 { "0": [id...] } 形式的对象')
} else {
  for (const [k, v] of Object.entries(cp.waves)) {
    if (!Array.isArray(v)) E('waves', `waves["${k}"] 不是数组`)
    else for (const id of v) if (!byId.has(id)) E('waves', `waves 引用了不存在的任务 ${id}`)
  }
  const a = JSON.stringify(normalizeWaves(cp.waves))
  const b = JSON.stringify(normalizeWaves(expected))
  if (a !== b) {
    if (opts.fixWaves) {
      cp.waves = expected
      fs.writeFileSync(opts.file, JSON.stringify(cp, null, 2) + '\n')
      wavesFixed = true
    } else {
      E('waves', `waves 与 blockedBy 推出的结果不一致（派生字段应在每次写盘时重算并整字段覆盖；可加 --fix-waves 自动回写）\n    期望 ${b}\n    实际 ${a}`)
    }
  }
  const listed = Object.values(cp.waves).flat()
  for (const id of byId.keys()) if (!listed.includes(id)) E('waves', `任务 ${id} 没有出现在 waves 里`)
  if (listed.length !== new Set(listed).size) E('waves', 'waves 里有重复的任务 id')
}

// ---------- 4. verifier 展开 ----------
for (const t of byId.values()) {
  const verify = t.verify ?? 'standard'
  const need = []
  if (verify === 'standard') need.push(`${t.id}v`)
  if (verify === 'strict') need.push(`${t.id}v1`, `${t.id}v2`, `${t.id}v3`)
  for (const id of need) {
    if (!byId.has(id)) E('verify.expand', `${t.id} 的 verify=${verify}，但缺少 verifier 任务 ${id}`)
    else if (!(byId.get(id).blockedBy ?? []).includes(t.id)) {
      E('verify.expand', `verifier ${id} 的 blockedBy 必须包含被验任务 ${t.id}`)
    }
  }
  if (verify === 'tournament' || verify === 'adversarial') {
    const has = [...byId.keys()].some((id) => id.startsWith(`${t.id}v`))
    if (!has) E('verify.expand', `${t.id} 的 verify=${verify}，但没有展开任何 *v 任务`)
  }
}

// ---------- 5. 状态一致性 ----------
const terminal = new Set(['done', 'failed', 'skipped'])
if (cp.status === 'done') {
  for (const t of byId.values()) {
    if (!terminal.has(t.status)) E('state', `顶层 status=done，但任务 ${t.id} 仍是 ${t.status}`)
  }
  const fr = `${OUTPUT_PREFIX}${orchId}/final-report.md`
  if (opts.files && !fs.existsSync(path.join(opts.root, fr))) E('state', `顶层 status=done，但终稿不存在：${fr}`)
}
if (cp.status === 'done' && tasks.length >= 3) {
  // 终稿是汇总任务的 output；这里只校验它是否由某个任务声明过
  const declared = [...byId.values()].some((t) => isStr(t.output) && t.output.split('/').pop() === 'final-report.md')
  if (!declared) W('state', '没有任何任务的 output 指向 final-report.md')
}

// 传播：skipped(upstream failed) 应当真的有失败上游
for (const t of byId.values()) {
  if (t.status === 'skipped' && /upstream failed/i.test(String(t.error ?? ''))) {
    const ups = (t.blockedBy ?? []).map((b) => byId.get(b)).filter(Boolean)
    if (!ups.some((u) => u.status === 'failed' || u.status === 'skipped')) {
      W('state', `${t.id} 标了 upstream failed，但它的上游没有 failed/skipped 的任务`)
    }
  }
  // verifier 判 fail 却已有下游 done：说明"验证阻断了交付"这条没被执行
  if (VERIFIER_ID.test(t.id) && t.verdict === 'fail') {
    const downstream = [...byId.values()].filter((d) => (d.blockedBy ?? []).includes(t.id) && d.status === 'done')
    if (downstream.length) W('state', `${t.id} 判 fail，但下游 ${downstream.map((d) => d.id).join(', ')} 已经 done`)
  }
}

// ---------- 6. HITL / 快照 ----------
if (cp.hitl_gates !== undefined) {
  if (!Array.isArray(cp.hitl_gates)) E('hitl', 'hitl_gates 必须是数组')
  else cp.hitl_gates.forEach((g, i) => {
    if (!GATE_AT.has(g?.at)) E('hitl', `hitl_gates[${i}].at 非法: ${JSON.stringify(g?.at)}`)
    if (g?.at_time !== undefined && !ts(g.at_time)) E('hitl', `hitl_gates[${i}].at_time 不是带时区的 ISO 8601`)
  })
}
if (cp.dag_snapshots !== undefined) {
  if (!Array.isArray(cp.dag_snapshots)) E('snapshot', 'dag_snapshots 必须是数组')
  else {
    let last = 0
    cp.dag_snapshots.forEach((s, i) => {
      if (!isInt(s?.version) || s.version <= last) E('snapshot', `dag_snapshots[${i}].version 必须递增的整数`)
      else last = s.version
      if (s?.at !== undefined && !ts(s.at)) E('snapshot', `dag_snapshots[${i}].at 不是带时区的 ISO 8601`)
    })
  }
}

// ---------- 7. 文件存在性 ----------
if (opts.files) {
  if (isStr(cp.plan) && cp.plan.startsWith(PLAN_PREFIX) && !fs.existsSync(path.join(opts.root, cp.plan))) {
    W('files', `plan 文件不存在：${cp.plan}（恢复时拿不到完整 prompt，应先问用户而不是即兴重写）`)
  }
  for (const t of byId.values()) {
    if (t.status !== 'done' || !isStr(t.output)) continue
    const abs = path.join(opts.root, t.output)
    if (!fs.existsSync(abs)) {
      E('files', `${t.id} 已 done，但产物不存在：${t.output}（应标 failed + error="output missing"）`)
      continue
    }
    if (fs.statSync(abs).isFile() && fs.statSync(abs).size === 0) {
      E('files', `${t.id} 的产物是空文件：${t.output}`)
    }
  }
}

// ---------- 8. 终稿段落 ----------
if (opts.files && cp.status === 'done' && isStr(orchId)) {
  const fr = path.join(opts.root, OUTPUT_PREFIX, orchId, 'final-report.md')
  if (fs.existsSync(fr)) {
    const txt = fs.readFileSync(fr, 'utf8')
    for (const kw of ['未确认', '依据']) if (!txt.includes(kw)) W('report', `终稿缺少「${kw}」段落`)
  }
}

// ---------- 输出 ----------
const result = { file: opts.file, root: opts.root, wavesFixed, errors, warnings, ok: errors.length === 0 }
if (opts.json) {
  console.log(JSON.stringify(result, null, 2))
} else {
  const base = path.basename(opts.file)
  if (wavesFixed) console.log(`FIXED ${base}：waves 已按 blockedBy 重算并写回`)
  if (errors.length === 0 && warnings.length === 0) {
    console.log(`PASS  ${base}：结构与状态一致（${byId.size} 个任务）`)
  } else {
    console.log(`${errors.length ? 'FAIL' : 'PASS'}  ${base}：${errors.length} 个错误 / ${warnings.length} 个警告`)
    for (const e of errors) console.log(`  ✗ [${e.code}] ${e.msg}`)
    for (const w of warnings) console.log(`  ! [${w.code}] ${w.msg}`)
  }
}
process.exitCode = errors.length ? 1 : 0
