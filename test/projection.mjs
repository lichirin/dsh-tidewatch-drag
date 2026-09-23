/**
 * costUsage 投影集成自检：验证分模型计费、流式样本替换、切换模型后各按各价。
 * 运行：node test/projection.mjs
 */
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'
import { CNY_PER_USD } from '../lib/pricing.js'

let projection = null
const ctx = {
  inject(services, fn) {
    assert.deepEqual(services, ['sessionProjections'])
    fn({ sessionProjections: { register(p) { projection = p } } })
  },
}
apply(ctx)
assert.ok(projection !== null, '投影未注册')
assert.equal(projection.key, 'costUsage')
assert.ok(projection.wire !== undefined, '缺少 wire（浏览器端将读不到投影）')

const stateSchemaOk = projection.stateSchema.safeParse(projection.init())
assert.equal(stateSchemaOk.success, true, `初始 state 未通过 schema：${JSON.stringify(stateSchemaOk.error?.issues)}`)

// 2026-09-16（周三）05:00 UTC = 谷期；02:00 UTC = 峰期；2026-09-19 = 周六。
const OFF_PEAK = Date.parse('2026-09-16T05:00:00Z')
const PEAK = Date.parse('2026-09-16T02:00:00Z')
const SATURDAY_PEAK_WINDOW = Date.parse('2026-09-19T02:00:00Z')

const header = model => ({ type: 'request/header', time: OFF_PEAK, data: { header: { config: { provider: 'deepseek-official', model } } } })
const usage = (turn, step, time, u) => ({ type: 'assistant/chunk', time, data: { turn, step, chunk: { type: 'usage', usage: u } } })

let passed = 0
const check = (name, fn) => { fn(); passed += 1; console.log('  ok', name) }

const TOKENS = { inputTokens: 1_000_000, outputTokens: 1_000_000 }
const yuan = usd => usd * CNY_PER_USD
/** 全新会话：init + 一次请求头。 */
const fresh = model => projection.apply(projection.init(), header(model))
/** 全新会话 + 一次调用。 */
const session = (model, tokens, atMs = OFF_PEAK) =>
  projection.apply(fresh(model), usage(1, 1, atMs, tokens))
const viewOf = state => projection.wire.view(state)

// ── 分模型单价 ───────────────────────────────────────────────────────────
check('flash 谷期 1M 未命中 + 1M 输出 = ¥5', () => {
  const v = viewOf(session('deepseek-flash', TOKENS))
  assert.equal(v.model, 'deepseek-flash')
  assert.ok(Math.abs(yuan(v.cost) - 5) < 1e-9, `got ¥${yuan(v.cost)}`)
  assert.ok(Math.abs(yuan(v.byModel['deepseek-flash'].cost) - 5) < 1e-9)
})

check('pro 谷期同 token = ¥18（官方 ¥4.5 + ¥13.5）', () => {
  const v = viewOf(session('deepseek-v4-pro', TOKENS))
  assert.equal(v.model, 'deepseek-v4-pro')
  assert.ok(Math.abs(yuan(v.cost) - 18) < 1e-9, `got ¥${yuan(v.cost)}`)
})

check('wire 视图通过 schema 校验', () => {
  const ok = projection.wire.viewSchema.safeParse(viewOf(session('deepseek-flash', TOKENS)))
  assert.equal(ok.success, true, JSON.stringify(ok.error?.issues))
})

// ── 峰谷档位逐事件生效 ──────────────────────────────────────────────────
check('峰期调用按峰时价计费（flash 1M+1M = ¥10）', () => {
  const v = viewOf(session('deepseek-flash', TOKENS, PEAK))
  assert.ok(Math.abs(yuan(v.cost) - 10) < 1e-9, `got ¥${yuan(v.cost)}`)
})

check('峰期 pro 1M+1M = ¥36（官方 ¥9 + ¥27）', () => {
  const v = viewOf(session('deepseek-v4-pro', TOKENS, PEAK))
  assert.ok(Math.abs(yuan(v.cost) - 36) < 1e-9, `got ¥${yuan(v.cost)}`)
})

check('周末落在峰窗小时的调用仍按谷期价（¥5）', () => {
  const v = viewOf(session('deepseek-flash', TOKENS, SATURDAY_PEAK_WINDOW))
  assert.ok(Math.abs(yuan(v.cost) - 5) < 1e-9, `got ¥${yuan(v.cost)}`)
})

check('缓存命中桶按 cacheHit 计价（1M 缓存读 = ¥0.02）', () => {
  const v = viewOf(session('deepseek-flash', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }))
  assert.ok(Math.abs(yuan(v.cost) - 0.02) < 1e-12, `got ¥${yuan(v.cost)}`)
})

// ── 流式样本替换（同一 turn:step 先流式后最终，不得重复计数）────────────
check('同一 (turn,step) 的最终样本替换流式样本，不重复计数', () => {
  let s = fresh('deepseek-flash')
  s = projection.apply(s, usage(1, 1, OFF_PEAK, { inputTokens: 10_000, outputTokens: 1_000 }))
  const streamed = s.totals.cost
  s = projection.apply(s, usage(1, 1, OFF_PEAK, TOKENS))
  assert.ok(Math.abs(yuan(s.totals.cost) - 5) < 1e-9, `替换后应恰为 ¥5，got ¥${yuan(s.totals.cost)}`)
  assert.ok(s.totals.cost > streamed, '最终样本应覆盖（大于）流式样本')
  assert.ok(Math.abs(yuan(viewOf(s).byModel['deepseek-flash'].cost) - 5) < 1e-9, '分模型桶同样不得重复计数')
})

check('重复投递同一最终样本不重复累计', () => {
  let s = session('deepseek-flash', TOKENS)
  s = projection.apply(s, usage(1, 1, OFF_PEAK, TOKENS))
  assert.ok(Math.abs(yuan(s.totals.cost) - 5) < 1e-9, `got ¥${yuan(s.totals.cost)}`)
})

// ── 中途切换模型：各按各自单价归属 ──────────────────────────────────────
check('切换模型后，各模型按各自单价分别计费并分模型归属', () => {
  let s = fresh('deepseek-flash')
  s = projection.apply(s, usage(1, 1, OFF_PEAK, TOKENS)) // flash ¥5
  s = projection.apply(s, header('deepseek-v4-pro'))
  s = projection.apply(s, usage(2, 1, OFF_PEAK, TOKENS)) // pro ¥18
  const v = viewOf(s)
  assert.equal(v.model, 'deepseek-v4-pro')
  assert.ok(Math.abs(yuan(v.byModel['deepseek-flash'].cost) - 5) < 1e-9, `flash 应 ¥5，got ¥${yuan(v.byModel['deepseek-flash'].cost)}`)
  assert.ok(Math.abs(yuan(v.byModel['deepseek-v4-pro'].cost) - 18) < 1e-9, `pro 应 ¥18，got ¥${yuan(v.byModel['deepseek-v4-pro'].cost)}`)
  assert.ok(Math.abs(yuan(v.cost) - 23) < 1e-9, `合计应 ¥23，got ¥${yuan(v.cost)}`)
  assert.ok(Math.abs(v.cost - (v.byModel['deepseek-flash'].cost + v.byModel['deepseek-v4-pro'].cost)) < 1e-12, '合计应等于分模型之和')
  const ok = projection.wire.viewSchema.safeParse(v)
  assert.equal(ok.success, true, JSON.stringify(ok.error?.issues))
})

check('切回 flash 后按 flash 价续算（不串档）', () => {
  let s = fresh('deepseek-v4-pro')
  s = projection.apply(s, usage(1, 1, OFF_PEAK, TOKENS)) // pro ¥18
  s = projection.apply(s, header('deepseek-flash'))
  s = projection.apply(s, usage(2, 1, OFF_PEAK, TOKENS)) // flash ¥5
  const v = viewOf(s)
  assert.equal(v.model, 'deepseek-flash')
  assert.ok(Math.abs(yuan(v.byModel['deepseek-v4-pro'].cost) - 18) < 1e-9)
  assert.ok(Math.abs(yuan(v.byModel['deepseek-flash'].cost) - 5) < 1e-9)
})

check('同一会话内 pro 单价确实高于 flash（分档生效）', () => {
  const flash = viewOf(session('deepseek-flash', TOKENS)).cost
  const pro = viewOf(session('deepseek-v4-pro', TOKENS)).cost
  assert.ok(pro > flash * 3, `flash=¥${yuan(flash)} pro=¥${yuan(pro)}`)
})

// ── 兼容名与未收录名 ────────────────────────────────────────────────────
check('旧 Flash 名（v4-flash / v4-flash-vision-exp）按 Flash 价计费', () => {
  for (const name of ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
    const v = viewOf(session(name, TOKENS))
    assert.ok(Math.abs(yuan(v.cost) - 5) < 1e-9, `${name} got ¥${yuan(v.cost)}`)
    assert.equal(v.model, name)
  }
})

check('未收录模型名兜底按 flash 价计费（不中断、不计零）', () => {
  const warnings = []
  const original = console.warn
  console.warn = msg => warnings.push(String(msg))
  try {
    let s = fresh('some-unknown-model')
    s = projection.apply(s, usage(1, 1, OFF_PEAK, TOKENS))
    s = projection.apply(s, usage(2, 1, OFF_PEAK, TOKENS))
    assert.ok(Math.abs(yuan(s.totals.cost) - 10) < 1e-9, `两次调用应 ¥10，got ¥${yuan(s.totals.cost)}`)
    assert.equal(warnings.length, 1, `未收录告警应只输出一次，实际 ${warnings.length} 次`)
    assert.ok(warnings[0].includes('some-unknown-model'))
  } finally {
    console.warn = original
  }
})

check('已收录模型名不产生未收录告警', () => {
  const warnings = []
  const original = console.warn
  console.warn = msg => warnings.push(String(msg))
  try {
    for (const name of ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
      projection.apply(session(name, TOKENS), usage(2, 1, OFF_PEAK, TOKENS))
    }
    assert.deepEqual(warnings, [], `不应有告警，实际：${warnings.join(' | ')}`)
  } finally {
    console.warn = original
  }
})

check('无 usage 的事件不改变状态', () => {
  const s = fresh('deepseek-flash')
  const same = projection.apply(s, { type: 'assistant/chunk', time: OFF_PEAK, data: { turn: 1, step: 1, chunk: { type: 'text' } } })
  assert.equal(same, s)
})

check('init 状态与 apply 后状态均满足持久化 schema', () => {
  assert.equal(projection.stateSchema.safeParse(projection.init()).success, true)
  assert.equal(projection.stateSchema.safeParse(session('deepseek-v4-pro', TOKENS)).success, true)
})

console.log(`\n${passed} 项全部通过`)
