/**
 * dsh-tidewatch 计费自检：核对官方定价表、模型分档与峰谷数学。
 * 运行：node test/verify.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  CNY_PER_USD,
  DEFAULT_PRICE_TABLE,
  FALLBACK_PRICE_RULE,
  LEGACY_BASE_BOUNDARY,
  PRICE_RULE_FLASH,
  PRICE_RULE_PRO,
  costOf,
  isPeakHour,
  peakPhaseAt,
  priceEntryFor,
  priceRuleFor,
  tierFor,
} from '../lib/pricing.js'

let passed = 0
const check = (name, fn) => {
  fn()
  passed += 1
  console.log('  ok', name)
}

// ── 官方人民币标价（api-docs.deepseek.com/zh-cn/quick_start/pricing）──────
const OFFICIAL_CNY = {
  flash: { offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 }, peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 } },
  pro: { offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 }, peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 } },
}

console.log('官方定价表一致性')

check('两条在售价格规则：flash / pro', () => {
  assert.deepEqual(Object.keys(DEFAULT_PRICE_TABLE.models).sort(), [PRICE_RULE_FLASH, PRICE_RULE_PRO].sort())
})

check('flash 两档人民币标价 = 官方 0.02/1/4 与 0.04/2/8', () => {
  assert.deepEqual(DEFAULT_PRICE_TABLE.models[PRICE_RULE_FLASH].rates.cny, OFFICIAL_CNY.flash)
})

check('pro 两档人民币标价 = 官方 0.15/4.5/13.5 与 0.30/9/27', () => {
  assert.deepEqual(DEFAULT_PRICE_TABLE.models[PRICE_RULE_PRO].rates.cny, OFFICIAL_CNY.pro)
})

check('美元账本 = 官方人民币标价 ÷ CNY_PER_USD', () => {
  const usdOf = (yuan) => yuan / CNY_PER_USD
  for (const [rule, rates] of Object.entries({ flash: OFFICIAL_CNY.flash, pro: OFFICIAL_CNY.pro })) {
    for (const tier of ['offPeak', 'peak']) {
      const entry = DEFAULT_PRICE_TABLE.models[rule][tier]
      assert.ok(Math.abs(entry.cacheHit - usdOf(rates[tier].cacheHit)) < 1e-12, `${rule}.${tier}.cacheHit`)
      assert.ok(Math.abs(entry.cacheMiss - usdOf(rates[tier].cacheMiss)) < 1e-12, `${rule}.${tier}.cacheMiss`)
      assert.ok(Math.abs(entry.output - usdOf(rates[tier].output)) < 1e-12, `${rule}.${tier}.output`)
    }
  }
})

check('峰时价 = 谷时价 × 2（两档模型均成立）', () => {
  for (const rule of [PRICE_RULE_FLASH, PRICE_RULE_PRO]) {
    const e = DEFAULT_PRICE_TABLE.models[rule]
    for (const bucket of ['cacheHit', 'cacheMiss', 'output']) {
      assert.ok(Math.abs(e.peak[bucket] - e.offPeak[bucket] * 2) < 1e-12, `${rule}.${bucket}`)
    }
  }
})

console.log('模型名 → 价格规则')

check('deepseek-flash → flash 档', () => {
  assert.deepEqual(priceRuleFor('deepseek-flash'), { rule: PRICE_RULE_FLASH, matched: true })
})

check('deepseek-v4-pro → pro 档（官方确认继续提供、计费不变）', () => {
  assert.deepEqual(priceRuleFor('deepseek-v4-pro'), { rule: PRICE_RULE_PRO, matched: true })
})

check('旧 Flash 名（v4-flash / v4-flash-vision-exp / v4.1-flash）→ flash 档', () => {
  for (const name of ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4.1-flash', 'DeepSeek-Flash']) {
    assert.equal(priceRuleFor(name).rule, PRICE_RULE_FLASH, name)
    assert.equal(priceRuleFor(name).matched, true, name)
  }
})

check('带供应商前缀 / 括号附注的模型名仍能命中（含最长匹配）', () => {
  assert.equal(priceRuleFor('deepseek-official/deepseek-v4-pro').rule, PRICE_RULE_PRO)
  assert.equal(priceRuleFor('deepseek-v4-pro (0813)').rule, PRICE_RULE_PRO)
  assert.equal(priceRuleFor('deepseek-v4-flash（vision）').rule, PRICE_RULE_FLASH)
})

check('未收录模型名 → 兜底 flash 且 matched=false', () => {
  for (const name of ['default', 'gpt-5.6-luna', 'kimi-k3', '', undefined]) {
    const r = priceRuleFor(name)
    assert.equal(r.rule, FALLBACK_PRICE_RULE, String(name))
    assert.equal(r.matched, false, String(name))
  }
})

check('pro 与 flash 的单价条目确实不同（不再共用一档）', () => {
  const flash = priceEntryFor('deepseek-flash').offPeak
  const pro = priceEntryFor('deepseek-v4-pro').offPeak
  assert.notDeepEqual(flash, pro)
  assert.ok(Math.abs(pro.cacheMiss / flash.cacheMiss - 4.5) < 1e-12)
  assert.ok(Math.abs(pro.output / flash.output - 3.375) < 1e-12)
})

console.log('峰谷数学')

// 2026-09-16 = 周三；UTC 02:00 落在峰窗 01:00–04:00。
const WED_PEAK = Date.parse('2026-09-16T02:00:00Z')
const WED_OFF = Date.parse('2026-09-16T05:00:00Z')
const SAT_PEAK_WINDOW = Date.parse('2026-09-19T02:00:00Z')
const SUN_PEAK_WINDOW = Date.parse('2026-09-20T07:00:00Z')

check('工作日峰窗内为峰期、窗外为谷期', () => {
  assert.equal(isPeakHour(WED_PEAK), true)
  assert.equal(isPeakHour(WED_OFF), false)
})

check('周六/周日落在此前的峰窗小时也按谷期计价', () => {
  assert.equal(new Date(SAT_PEAK_WINDOW).getUTCDay(), 6)
  assert.equal(isPeakHour(SAT_PEAK_WINDOW), false)
  assert.equal(new Date(SUN_PEAK_WINDOW).getUTCDay(), 0)
  assert.equal(isPeakHour(SUN_PEAK_WINDOW), false)
})

check('峰谷切换点：周三 02:00 → 下一切换到 04:00（转入谷期）', () => {
  const p = peakPhaseAt(WED_PEAK)
  assert.equal(p.inPeak, true)
  assert.equal(p.nextAtMs, Date.parse('2026-09-16T04:00:00Z'))
  assert.equal(p.nextIntoPeak, false)
})

check('周末无切换：周六 02:00 的下一相位为周一 01:00（转入峰期）', () => {
  const p = peakPhaseAt(SAT_PEAK_WINDOW)
  assert.equal(p.inPeak, false)
  assert.equal(p.nextAtMs, Date.parse('2026-09-21T01:00:00Z'))
  assert.equal(p.nextIntoPeak, true)
})

console.log('成本计算')

const tokens = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0, reasoning: 0 }

check('flash 谷期：1M 未命中输入 + 1M 输出 = ¥1 + ¥4', () => {
  const usd = costOf(tokens, priceEntryFor('deepseek-flash'), WED_OFF)
  assert.ok(Math.abs(usd * CNY_PER_USD - 5) < 1e-9, `got ¥${usd * CNY_PER_USD}`)
})

check('flash 峰期：同 token = ¥2 + ¥8（峰时翻倍）', () => {
  const usd = costOf(tokens, priceEntryFor('deepseek-flash'), WED_PEAK)
  assert.ok(Math.abs(usd * CNY_PER_USD - 10) < 1e-9, `got ¥${usd * CNY_PER_USD}`)
})

check('pro 谷期：1M 未命中输入 + 1M 输出 = ¥4.5 + ¥13.5', () => {
  const usd = costOf(tokens, priceEntryFor('deepseek-v4-pro'), WED_OFF)
  assert.ok(Math.abs(usd * CNY_PER_USD - 18) < 1e-9, `got ¥${usd * CNY_PER_USD}`)
})

check('pro 峰期：同 token = ¥9 + ¥27', () => {
  const usd = costOf(tokens, priceEntryFor('deepseek-v4-pro'), WED_PEAK)
  assert.ok(Math.abs(usd * CNY_PER_USD - 36) < 1e-9, `got ¥${usd * CNY_PER_USD}`)
})

check('同一 usage 下 pro 成本高于 flash（分档确实生效）', () => {
  const flash = costOf(tokens, priceEntryFor('deepseek-flash'), WED_OFF)
  const pro = costOf(tokens, priceEntryFor('deepseek-v4-pro'), WED_OFF)
  assert.ok(pro > flash * 3, `flash=${flash} pro=${pro}`)
})

check('缓存命中按 cacheHit 计价：1M 缓存读 ¥0.02（flash 谷期）', () => {
  const usd = costOf({ input: 0, output: 0, cacheRead: 1_000_000 }, priceEntryFor('deepseek-flash'), WED_OFF)
  assert.ok(Math.abs(usd * CNY_PER_USD - 0.02) < 1e-12, `got ¥${usd * CNY_PER_USD}`)
})

check('缓存命中（pro 谷期 ¥0.15）与输出（pro 谷期 ¥13.5）逐项对齐官方', () => {
  const hit = costOf({ cacheRead: 1_000_000 }, priceEntryFor('deepseek-v4-pro'), WED_OFF)
  const out = costOf({ output: 1_000_000 }, priceEntryFor('deepseek-v4-pro'), WED_OFF)
  assert.ok(Math.abs(hit * CNY_PER_USD - 0.15) < 1e-9)
  assert.ok(Math.abs(out * CNY_PER_USD - 13.5) < 1e-9)
})

check('峰谷时代之前按 legacyBase 计费（历史正确性）', () => {
  const before = Date.parse(LEGACY_BASE_BOUNDARY) - 60_000
  const tier = tierFor(priceEntryFor('deepseek-v4-pro'), before)
  assert.deepEqual(tier, { cacheHit: 0.0028, cacheMiss: 0.14, output: 0.28 })
  assert.deepEqual(tierFor(priceEntryFor('deepseek-flash'), before), tier)
})

check('边界时刻起改用峰谷档位（该时刻为周日 16:00 UTC → offPeak 档）', () => {
  const at = Date.parse(LEGACY_BASE_BOUNDARY)
  assert.equal(new Date(at).getUTCDay(), 0)
  assert.equal(isPeakHour(at), false)
  assert.deepEqual(tierFor(priceEntryFor('deepseek-flash'), at), priceEntryFor('deepseek-flash').offPeak)
  assert.deepEqual(tierFor(priceEntryFor('deepseek-v4-pro'), at), priceEntryFor('deepseek-v4-pro').offPeak)
})

check('空/负 token 不产生成本', () => {
  assert.equal(costOf(undefined, priceEntryFor('deepseek-flash'), WED_OFF), 0)
  assert.equal(costOf({ input: -5, output: -5 }, priceEntryFor('deepseek-flash'), WED_OFF), 0)
})

console.log('前端 bundle 常量与宿主一致性')

const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const numberLiteral = '(-?\\d+(?:\\.\\d+)?)'
/** 从 marker 之后第一个 `[`/`{` 起做括号配对，返回完整字面量文本。 */
const blockAfter = (marker) => {
  const start = clientSource.indexOf(marker)
  assert.ok(start >= 0, `client.js 缺少 ${marker}`)
  const open = clientSource.slice(start).search(/[[{]/)
  assert.ok(open >= 0, `${marker} 后未找到块起始符`)
  const from = start + open
  const closers = { '[': ']', '{': '}' }
  const stack = []
  for (let i = from; i < clientSource.length; i += 1) {
    const ch = clientSource[i]
    if (ch === '[' || ch === '{') stack.push(closers[ch])
    else if (ch === ']' || ch === '}') {
      stack.pop()
      if (stack.length === 0) return clientSource.slice(from, i + 1)
    }
  }
  throw new Error(`无法解析 ${marker} 区块`)
}

const clientFx = Number(clientSource.match(new RegExp(`const FIXED_FX = ${numberLiteral}`))[1])
const rulesBlock = blockAfter('const RATE_RULES = [')
const rulePattern = new RegExp(
  `key: '([a-z]+)',[\\s\\S]*?label: '([^']+)',[\\s\\S]*?`
  + `offPeak: \\{ cacheHit: ${numberLiteral}, cacheMiss: ${numberLiteral}, output: ${numberLiteral} \\},`
  + `[\\s\\S]*?peak: \\{ cacheHit: ${numberLiteral}, cacheMiss: ${numberLiteral}, output: ${numberLiteral} \\},`
  + `[\\s\\S]*?models: \\[([^\\]]*)\\]`,
  'g',
)
const clientRules = {}
for (const m of rulesBlock.matchAll(rulePattern)) {
  clientRules[m[1]] = {
    label: m[2],
    offPeak: { cacheHit: Number(m[3]), cacheMiss: Number(m[4]), output: Number(m[5]) },
    peak: { cacheHit: Number(m[6]), cacheMiss: Number(m[7]), output: Number(m[8]) },
    models: [...m[9].matchAll(/'([^']+)'/g)].map(x => x[1]),
  }
}

check('client.js 解析出两条规则且汇率与宿主一致', () => {
  assert.equal(clientFx, CNY_PER_USD)
  assert.deepEqual(Object.keys(clientRules).sort(), [PRICE_RULE_FLASH, PRICE_RULE_PRO].sort())
})

check('client 展示人民币单价与宿主 rates.cny 逐位一致（含峰时 ×2）', () => {
  for (const [ruleKey, rule] of Object.entries(clientRules)) {
    const host = DEFAULT_PRICE_TABLE.models[ruleKey]
    assert.deepEqual(rule.offPeak, host.rates.cny.offPeak, `${ruleKey}.offPeak`)
    assert.deepEqual(rule.peak, host.rates.cny.peak, `${ruleKey}.peak`)
  }
})

check('client 的模型名别名表能覆盖官方全部在售/在兼容模型名', () => {
  // 每个别名都必须解析回它所属的规则（与宿主 priceRuleFor 同判据）。
  for (const [ruleKey, rule] of Object.entries(clientRules)) {
    for (const alias of rule.models) {
      const fromHost = priceRuleFor(alias)
      assert.equal(fromHost.rule, ruleKey, `${alias} 宿主解析不一致`)
      assert.equal(fromHost.matched, true, `${alias} 宿主未命中`)
    }
  }
  // 官方在售/兼容名逐一断言
  const expected = {
    deepseekflash: PRICE_RULE_FLASH,
    deepseekv4flash: PRICE_RULE_FLASH,
    deepseekv4flashvisionexp: PRICE_RULE_FLASH,
    deepseekv4pro: PRICE_RULE_PRO,
  }
  for (const [alias, ruleKey] of Object.entries(expected)) {
    assert.ok(clientRules[ruleKey].models.includes(alias), `client 缺少别名 ${alias}`)
  }
})

check('client 兜底规则与宿主 FALLBACK_PRICE_RULE 一致', () => {
  const fallback = clientSource.match(/const RATE_RULE_FALLBACK = '([a-z]+)'/)
  assert.ok(fallback !== null, 'client.js 缺少 RATE_RULE_FALLBACK')
  assert.equal(fallback[1], FALLBACK_PRICE_RULE)
})

console.log(`\n${passed} 项全部通过`)
