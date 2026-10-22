#!/usr/bin/env node
// tools/selfcheck.mjs — multi-agent-orchestrator skill self-check
// Usage: node tools/selfcheck.mjs [skillRoot]
// Checks: waves formula / path bases / enum closure / task count / verifier expansion / link integrity

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(process.argv[2] ?? path.join(here, '..'))

const failures = []
const checks = []
const read = (p) => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
const mdFiles = ['SKILL.md', ...fs.readdirSync(path.join(root, 'references'))
  .filter((f) => f.endsWith('.md')).map((f) => path.join('references', f))]
const jsonFiles = fs.readdirSync(path.join(root, 'templates'))
  .filter((f) => f.endsWith('.json')).map((f) => path.join('templates', f))

const record = (name, problems, note = '') => {
  checks.push({ name, ok: problems.length === 0, note })
  for (const p of problems) failures.push(`[${name}] ${p}`)
}

// ---------- collect fenced ```json blocks from markdown ----------
function fencedJson(file) {
  const text = read(path.join(root, file))
  const out = []
  const re = /```json\s*\n([\s\S]*?)```/g
  let m
  while ((m = re.exec(text))) out.push({ where: `${file} (fenced #${out.length + 1})`, raw: m[1] })
  return out
}

const docs = []
for (const f of mdFiles) for (const b of fencedJson(f)) {
  try { docs.push({ where: b.where, value: JSON.parse(b.raw) }) }
  catch { failures.push(`[parse] ${b.where} 不是合法 JSON`) }
}
const templates = jsonFiles.map((f) => ({ where: f, value: JSON.parse(read(path.join(root, f))) }))
const all = [...templates, ...docs]

// ---------- 1. waves formula ----------
const waveProblems = []
for (const { where, value } of all) {
  if (!value?.waves || !Array.isArray(value.tasks)) continue
  const byId = new Map(value.tasks.map((t) => [t.id, t]))
  const memo = new Map()
  const wave = (id, seen = new Set()) => {
    if (memo.has(id)) return memo.get(id)
    if (seen.has(id)) throw new Error(`cycle at ${id}`)
    seen.add(id)
    const t = byId.get(id)
    const w = !t || !t.blockedBy?.length ? 0 : 1 + Math.max(...t.blockedBy.map((b) => wave(b, seen)))
    memo.set(id, w)
    return w
  }
  const expected = {}
  for (const t of value.tasks) {
    const w = wave(t.id)
    ;(expected[w] ??= []).push(t.id)
  }
  const norm = (o) => JSON.stringify(Object.keys(o ?? {}).sort().reduce((a, k) => ((a[k] = [...o[k]].sort()), a), {}))
  if (norm(expected) !== norm(value.waves)) {
    waveProblems.push(`${where}: waves 与公式不一致\n    期望 ${norm(expected)}\n    实际 ${norm(value.waves)}`)
  }
  const orphan = Object.values(value.waves).flat().filter((id) => !byId.has(id))
  if (orphan.length) waveProblems.push(`${where}: waves 引用了不存在的任务 ${orphan}`)
}
record('waves 公式', waveProblems)

// ---------- 2. path bases ----------
const pathProblems = []
const PREFIX = '.dsh/orchestrator/'
for (const { where, value } of all) {
  const walk = (node, label) => {
    if (!node || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node)) {
      if ((k === 'output' || k === 'plan') && typeof v === 'string' && v) {
        if (!v.startsWith(PREFIX)) pathProblems.push(`${where}: ${label}.${k} = "${v}" 未以 ${PREFIX} 开头`)
      }
      walk(v, `${label}.${k}`)
    }
  }
  walk(value, '$')
}
// 正文里的裸路径（少一层 .dsh/orchestrator/）同样会 0 命中
for (const f of mdFiles) {
  const stripped = read(path.join(root, f))
    .replace(/```[\s\S]*?```/g, '')            // 代码块里的目录树/示例不参与
    .split('.dsh/orchestrator/plans/').join('')
    .split('.dsh/orchestrator/output/').join('')
  for (const m of stripped.matchAll(/(?<![A-Za-z0-9_./-])(plans|output)\/<orchId>/g)) {
    pathProblems.push(`${f}: 裸写 ${m[1]}/<orchId>，应带 .dsh/orchestrator/ 前缀`)
  }
}
record('路径基准', pathProblems)

// ---------- 3. enum closure ----------
const enumProblems = []
const MODES = new Set(['wave', 'workflow', 'hybrid'])
const readText = mdFiles.map((f) => read(path.join(root, f))).join('\n')
for (const m of readText.matchAll(/"mode"\s*:\s*"([^"]+)"/g)) {
  if (!MODES.has(m[1])) enumProblems.push(`未知 mode: "${m[1]}"`)
}
// "落盘只有四种/五种" must match the number of statuses listed on that line
const statusLine = readText.split('\n').find((l) => l.includes('落盘只有'))
if (!statusLine) enumProblems.push('找不到顶层 status 的枚举说明')
else {
  const cn = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 }
  const sentence = (statusLine.split('落盘只有')[1] ?? '').split('。')[0]
  const word = sentence.match(/^\**([一二三四五六])种/)
  const listed = [...sentence.matchAll(/`([a-z_]+)`/g)].map((m) => m[1])
  const TOP = new Set(['running', 'awaiting_human', 'done', 'failed', 'aborted'])
  for (const s of listed) if (!TOP.has(s)) enumProblems.push(`未知顶层 status: "${s}"`)
  if (!word) enumProblems.push('status 枚举说明缺少数量词（如"五种"）')
  else if (cn[word[1]] !== listed.length) {
    enumProblems.push(`status 说"${word[1]}种"，实际列出 ${listed.length} 个：${listed.join(', ')}`)
  }
}
record('枚举闭合', enumProblems)

// ---------- 4. task count + role pool ----------
const countProblems = []
for (const { where, value } of all) {
  if (!Array.isArray(value?.tasks)) continue
  const n = value.tasks.length
  if (n < 3 || n > 10) countProblems.push(`${where}: 任务数 ${n} 不在 3-10`)
}
const roleText = read(path.join(root, 'references/role-templates.md'))
const roles = new Set([...roleText.matchAll(/^#{2,3}\s*\d+\.\s*`([a-z-]+)`/gm)].map((m) => m[1]))
if (!roles.size) countProblems.push('role-templates.md 里解析不到角色名')
for (const { where, value } of all) {
  for (const t of value?.tasks ?? []) {
    if (t.role && !roles.has(t.role)) countProblems.push(`${where}: 任务 ${t.id} 的 role "${t.role}" 不在角色池 [${[...roles].join(', ')}]`)
  }
}
record('任务数与角色池', countProblems)

// ---------- 5. verifier expansion ----------
const verifyProblems = []
for (const { where, value } of all) {
  if (!Array.isArray(value?.tasks)) continue
  const ids = new Set(value.tasks.map((t) => t.id))
  for (const t of value.tasks) {
    if (t.verify === 'standard' && !ids.has(`${t.id}v`)) verifyProblems.push(`${where}: ${t.id} 是 standard 但没有 ${t.id}v`)
    if (t.verify === 'strict' && !ids.has(`${t.id}v1`)) verifyProblems.push(`${where}: ${t.id} 是 strict 但没有 ${t.id}v1..v3`)
    if (['tournament', 'adversarial'].includes(t.verify) && ![...ids].some((i) => i.startsWith(`${t.id}v`))) {
      verifyProblems.push(`${where}: ${t.id} 是 ${t.verify} 但没有展开 *v 任务`)
    }
  }
}
record('验证展开', verifyProblems)

// ---------- 6. link integrity ----------
const linkProblems = []
for (const f of mdFiles) {
  const text = read(path.join(root, f))
  for (const m of text.matchAll(/`(references\/[a-z-]+\.md|templates\/[a-z.]+\.json|tools\/[a-z.-]+\.mjs)`/g)) {
    if (!fs.existsSync(path.join(root, m[1]))) linkProblems.push(`${f}: 引用了不存在的文件 ${m[1]}`)
  }
}
record('文件引用', linkProblems)

// ---------- report ----------
const width = Math.max(...checks.map((c) => c.name.length))
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(width)}`)
if (failures.length) {
  console.log(`\n${failures.length} 个问题：`)
  for (const f of failures) console.log('  - ' + f)
  process.exitCode = 1
} else {
  console.log(`\n全部通过（${checks.length} 项）。`)
}
