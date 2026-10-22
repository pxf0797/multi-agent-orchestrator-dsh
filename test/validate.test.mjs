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

test('缺文件路径或参数 → exit 2', () => {
  const r = run([])
  assert.equal(r.code, 2)
})
