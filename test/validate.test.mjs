// test/validate.test.mjs — validate-checkpoint.mjs 的正负例
// 运行：node test/validate.test.mjs（或 npm test）

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const validator = path.join(root, 'tools/validate-checkpoint.mjs')
const template = JSON.parse(fs.readFileSync(path.join(root, 'templates/checkpoint.example.json'), 'utf8'))
const ORCH = template.orchestrator_id

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-validate-'))
const clone = () => JSON.parse(JSON.stringify(template))

function writeCp(name, cp) {
  const p = path.join(tmp, name)
  fs.writeFileSync(p, JSON.stringify(cp, null, 2))
  return p
}

function run(args) {
  const r = spawnSync(process.execPath, [validator, ...args], { encoding: 'utf8' })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

test('模板本身通过（跳过文件校验，允许 goal 占位符警告）', () => {
  const r = run([path.join(root, 'templates/checkpoint.example.json'), '--no-files'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /PASS/)
  assert.match(r.out, /goal/) // 占位符警告
})

test('waves 被改坏 → 报错并给出期望值', () => {
  const cp = clone()
  cp.waves = { 0: ['T1'], 1: ['T2', 'T2v', 'T3'], 2: ['T5'] }
  const r = run([writeCp('bad-waves.json', cp), '--no-files'])
  assert.equal(r.code, 1)
  assert.match(r.out, /\[waves\]/)
  assert.match(r.out, /期望/)
})

test('standard 任务缺 verifier → 报错', () => {
  const cp = clone()
  cp.tasks = cp.tasks.filter((t) => t.id !== 'T2v')
  cp.waves = { 0: ['T1'], 1: ['T2', 'T3'], 2: ['T5'] }
  const r = run([writeCp('no-verifier.json', cp), '--no-files'])
  assert.equal(r.code, 1)
  assert.match(r.out, /verify\.expand/)
  assert.match(r.out, /T2v/)
})

test('依赖指向更晚的任务 → 报错（且不会栈溢出）', () => {
  const cp = clone()
  cp.tasks.find((t) => t.id === 'T1').blockedBy = ['T5']
  const r = run([writeCp('forward.json', cp), '--no-files'])
  assert.equal(r.code, 1)
  assert.match(r.out, /task\.blockedBy/)
  assert.doesNotMatch(r.out, /Maximum call stack/)
})

test('done 但产物不存在 → 报错', () => {
  const cp = clone()
  const t = cp.tasks.find((x) => x.id === 'T1')
  t.status = 'done'
  t.attempts = 1
  t.summary = 'x'
  const emptyRoot = path.join(tmp, 'empty-root')
  fs.mkdirSync(emptyRoot, { recursive: true })
  const r = run([writeCp('no-output.json', cp), '--root', emptyRoot])
  assert.equal(r.code, 1)
  assert.match(r.out, /output missing/)
})

test('done 但 attempts=0 → 报错', () => {
  const cp = clone()
  cp.tasks.find((t) => t.id === 'T1').attempts = 0
  const r = run([writeCp('attempts.json', cp), '--no-files'])
  assert.equal(r.code, 1)
  assert.match(r.out, /attempts/)
})

test('时间戳缺时区、mode 非法 → 报错', () => {
  const cp = clone()
  cp.created_at = '2026-10-20 16:53:24'
  cp.mode = 'parallel'
  const r = run([writeCp('bad-enum.json', cp), '--no-files'])
  assert.equal(r.code, 1)
  assert.match(r.out, /\[timestamp\]/)
  assert.match(r.out, /mode 非法/)
})

test('完整 workspace（终稿 + 全部产物齐）→ 通过', () => {
  const ws = path.join(tmp, 'ws')
  const outDir = path.join(ws, '.dsh/orchestrator/output', ORCH)
  fs.mkdirSync(outDir, { recursive: true })
  fs.mkdirSync(path.join(ws, '.dsh/orchestrator/plans'), { recursive: true })

  const cp = clone()
  cp.goal = '把这份代码库的鉴权模块审一遍'
  cp.status = 'done'
  fs.writeFileSync(path.join(ws, '.dsh/orchestrator/plans', `${ORCH}.md`), '# plan\n')
  for (const t of cp.tasks) {
    t.status = 'done'
    t.attempts = 1
    t.summary = `要点\n文件：${t.output}\n来源：L1\n未确认项：none`
    fs.writeFileSync(path.join(ws, t.output), 'ok\n')
  }
  cp.tasks.find((t) => t.id === 'T2v').verdict = 'pass'

  const r = run([writeCp('good.json', cp), '--root', ws])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /0 个错误/)
})

test('counted 不守恒 → 报错（schema 2）', () => {
  const cp = clone()
  cp.tasks.find((t) => t.id === 'T2').counted = { total: 35, pass: 31, fail: 2, unverifiable: 1 }
  const r = run([writeCp('counted.json', cp), '--no-files'])
  assert.equal(r.code, 1)
  assert.match(r.out, /counted 不守恒/)
})

test('counted 与 summary 数字不一致 → 报错', () => {
  const cp = clone()
  const t = cp.tasks.find((x) => x.id === 'T2')
  t.counted = { total: 35, pass: 31, fail: 2, unverifiable: 2 }
  t.summary = '35 条：成立 32 / 不成立 2 / 无法核验 1'
  const r = run([writeCp('counted-summary.json', cp), '--no-files'])
  assert.equal(r.code, 1)
  assert.match(r.out, /两处必须一致/)
})

test('returns>0 但没留 previous_outputs → 报错（schema 2）', () => {
  const cp = clone()
  cp.tasks.find((t) => t.id === 'T2').returns = 1
  const r = run([writeCp('no-prev.json', cp), '--no-files'])
  assert.equal(r.code, 1)
  assert.match(r.out, /previous_outputs/)
})

test('verifier 判 fail 但被验任务没返工 → 报错（schema 2）', () => {
  const cp = clone()
  cp.tasks.find((t) => t.id === 'T2v').verdict = 'fail'
  const r = run([writeCp('fail-no-rework.json', cp), '--no-files'])
  assert.equal(r.code, 1)
  assert.match(r.out, /returns=0/)
})

test('verdict=pass 但 issue_counts 有 major → 警告（应标 pass_with_issues）', () => {
  const cp = clone()
  const v = cp.tasks.find((t) => t.id === 'T2v')
  v.verdict = 'pass'
  v.issue_counts = { blocker: 0, major: 2, minor: 1 }
  const r = run([writeCp('pass-with-major.json', cp), '--no-files'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /pass_with_issues/)
})

test('--fix-waves 把过期的 waves 写回文件', () => {
  const cp = clone()
  cp.waves = { 0: ['T1'], 1: ['T2', 'T3', 'T2v'], 2: ['T5'] }
  const file = writeCp('fix-waves.json', cp)
  const r = run([file, '--no-files', '--fix-waves'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /FIXED/)
  const after = JSON.parse(fs.readFileSync(file, 'utf8'))
  const w = Object.fromEntries(Object.entries(after.waves).map(([k, v]) => [k, [...v].sort()]))
  assert.deepEqual(w, { 0: ['T1'], 1: ['T2', 'T3'], 2: ['T2v'], 3: ['T5'] })
})

test('终稿缺「依据」段落 → 警告', () => {
  const ws = path.join(tmp, 'ws-report')
  const outDir = path.join(ws, '.dsh/orchestrator/output', ORCH)
  fs.mkdirSync(outDir, { recursive: true })
  fs.mkdirSync(path.join(ws, '.dsh/orchestrator/plans'), { recursive: true })
  fs.writeFileSync(path.join(ws, '.dsh/orchestrator/plans', `${ORCH}.md`), '# plan\n')
  const cp = clone()
  cp.status = 'done'
  cp.goal = '一次真实的编排'
  for (const t of cp.tasks) {
    t.status = 'done'
    t.attempts = 1
    t.summary = '结论'
    fs.writeFileSync(path.join(ws, t.output), t.id === 'T5' ? '# 终稿\n\n只有结论。\n' : 'ok\n')
  }
  const r = run([writeCp('report.json', cp), '--root', ws])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /缺少「依据」/)
})

test('缺文件路径或参数 → exit 2', () => {
  const r = run([])
  assert.equal(r.code, 2)
})
