/**
 * dsh-tidewatch 计费与峰谷数学（纯函数，宿主与移植共用）。
 *
 * 峰谷依据：DeepSeek 官方峰谷分时定价（2026-08-17 起生效）。
 *   峰时段（UTC 小时，半开区间）：01:00–04:00、06:00–10:00，
 *   仅周一至周五（即北京时间工作日 09:00–12:00、14:00–18:00）；
 *   其余时间为空闲（谷）时段，谷时价 = 峰时价的一半。周六/周日全天谷期。
 *
 * 模型路由（官方 2026-09-10 更新日志 + 定价页脚注）：
 *   - `deepseek-flash`（DeepSeek-V4.1-Flash）在售；
 *   - 旧名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 已下线，
 *     官方**暂时**把请求路由到 V4.1 Flash，并按 **Flash 价格**计费；
 *   - `deepseek-v4-pro`（DeepSeek-V4-Pro-0813）官方确认 2026-09-14 之后
 *     继续提供 API 服务，计费方式不变——**独立一档价格**，不再并入 Flash。
 *
 * 计费口径：官方标价以人民币计（元 / 1M tokens），下表 `rates.cny` 与官方
 * 中文定价页逐位一致；账本以美元计价（官方人民币标价 ÷ CNY_PER_USD），
 * 成本 = input × cacheMiss + output × output + (cacheRead + cacheWrite) × cacheHit
 * (+ reasoning × reasoningPrice，当价格条目提供 reasoning 价时)。
 * 官方不单独对推理 token 收费（推理 token 已计入输出），故价格表不设 reasoning 价。
 *
 * 本文件核心算法（isPeakHour / peakPhaseAt / tierFor / costOf / 价格表结构）
 * 借鉴自 dsh-cost-meter（MIT License, https://github.com/Han-1413141/dsh-cost-meter），
 * 按精简目标改写：无配置依赖，峰谷恒启用。
 */

/** 峰谷时代分界（2026-08-16 16:00 UTC）：此前的计费按当时的基础价执行（历史正确性）。 */
export const LEGACY_BASE_BOUNDARY = '2026-08-16T16:00:00Z'

/** 峰时段窗口（UTC 小时，半开区间 [start, end)），仅周一至周五生效。 */
export const DEFAULT_PEAK_WINDOWS = [
  { start: 1, end: 4 },
  { start: 6, end: 10 },
]

/**
 * 汇率基准：官方人民币标价 ÷ 官方美元标价的隐含汇率
 * （原官方定价页 ¥4.50 ÷ $0.66 ≈ 6.8181…，取 6.82）。
 * 账本以美元计价、展示时再乘回该汇率，因此人民币展示值与官方人民币标价逐位一致。
 * 必须与 lib/client.js 的 FIXED_FX 保持同步。
 */
export const CNY_PER_USD = 6.82

/** 官方人民币标价（元 / 1M tokens）→ 账本美元单价。 */
const cny = yuan => yuan / CNY_PER_USD

/**
 * 在售模型的峰谷两档单价（官方人民币标价，元 / 1M tokens）。
 *
 * 官方定价页（api-docs.deepseek.com/quick_start/pricing）：
 *   | 模型             | 桶            | 谷时 | 峰时 |
 *   |------------------|---------------|------|------|
 *   | deepseek-flash   | 输入 缓存命中 | 0.02 | 0.04 |
 *   | deepseek-flash   | 输入 未命中   | 1    | 2    |
 *   | deepseek-flash   | 输出          | 4    | 8    |
 *   | deepseek-v4-pro  | 输入 缓存命中 | 0.15 | 0.30 |
 *   | deepseek-v4-pro  | 输入 未命中   | 4.5  | 9.0  |
 *   | deepseek-v4-pro  | 输出          | 13.5 | 27.0 |
 *
 * 峰时价 = 谷时价 × 2（官方「空闲时段价格为高峰时段价格的一半」）。
 * 数值为权威人民币价：改价时只改这三档，美元账本自动跟随。
 */
const FLASH_RATES_CNY = {
  offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
  peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
}

const PRO_RATES_CNY = {
  offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
  peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
}

/**
 * 峰谷时代之前（2026-08-16 16:00 UTC 前）的基础价（美元 / 1M tokens）。
 * 该旧价属上一代模型（DeepSeek-V3.2 时代），当时尚无按模型分档，故全模型共用。
 */
const LEGACY_BASE_USD = { cacheHit: 0.0028, cacheMiss: 0.14, output: 0.28 }

/** 把官方人民币两档单价换算为账本美元价格条目。 */
function entryFromCny(rates) {
  const tier = r => ({ cacheHit: cny(r.cacheHit), cacheMiss: cny(r.cacheMiss), output: cny(r.output) })
  return {
    rates: { cny: { offPeak: { ...rates.offPeak }, peak: { ...rates.peak } } },
    offPeak: tier(rates.offPeak),
    peak: tier(rates.peak),
    legacyBase: { ...LEGACY_BASE_USD },
  }
}

/** 价格规则键（供前端展示与分模型归属共用，勿随官方模型名变动而改动）。 */
export const PRICE_RULE_FLASH = 'flash'
export const PRICE_RULE_PRO = 'pro'

/** 兜底价格规则：官方未公布 / 插件未收录的模型名按 Flash 价估算（官方把旧 Flash 名路由到 Flash）。 */
export const FALLBACK_PRICE_RULE = PRICE_RULE_FLASH

/**
 * 内置 DeepSeek 价格表（美元 / 1M tokens；账本口径；基础档 = 空闲档）。
 * 两条规则对应官方两个在售价格的模型；`default` 为未知模型名的兜底（= Flash）。
 */
export const DEFAULT_PRICE_TABLE = {
  models: {
    [PRICE_RULE_FLASH]: entryFromCny(FLASH_RATES_CNY),
    [PRICE_RULE_PRO]: entryFromCny(PRO_RATES_CNY),
  },
  default: entryFromCny(FLASH_RATES_CNY),
}

/**
 * 官方模型名 → 价格规则键。键为「归一化后」的模型名（小写、去空格/横杠/点/括号）。
 * - `deepseek-v4-pro`：官方确认继续提供 V4 Pro API 且计费方式不变 → 独立 Pro 档；
 * - `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp`：模型已下线，官方按 Flash 价计费；
 * - `deepseek-chat` / `deepseek-reasoner`：V3.2 时代的旧名，早已停用，兜底到 Flash。
 */
const MODEL_PRICE_RULES = {
  deepseekflash: PRICE_RULE_FLASH,
  deepseekv41flash: PRICE_RULE_FLASH,
  deepseekv4flash: PRICE_RULE_FLASH,
  deepseekv4flashvisionexp: PRICE_RULE_FLASH,
  deepseekv4pro: PRICE_RULE_PRO,
  deepseekpro: PRICE_RULE_PRO,
}

/** 归一化模型名：忽略大小写/空格/横杠/点号与括号附注。 */
export function normalizeModelId(model) {
  return String(model ?? '').toLowerCase().replace(/[\s\-_.()（）]/g, '')
}

/**
 * 模型名 → 价格规则键。
 *
 * 匹配顺序：归一化精确命中 → 表内规则键的最长包含命中（取最长，避免
 * `…pro` 与 `…flash` 互相误伤）→ 兜底 Flash。
 * @param model - 请求中的模型 id（也可传带供应商前缀的形式，如 `deepseek/deepseek-v4-pro`）。
 * @returns { rule, matched }，matched 为 false 表示未收录、按兜底价估算。
 */
export function priceRuleFor(model) {
  const id = normalizeModelId(model)
  if (id.length > 0) {
    if (Object.prototype.hasOwnProperty.call(MODEL_PRICE_RULES, id)) {
      return { rule: MODEL_PRICE_RULES[id], matched: true }
    }
    let best = null
    for (const [key, rule] of Object.entries(MODEL_PRICE_RULES)) {
      if (id.includes(key) && (best === null || key.length > best.key.length)) best = { key, rule }
    }
    if (best !== null) return { rule: best.rule, matched: true }
  }
  return { rule: FALLBACK_PRICE_RULE, matched: false }
}

/**
 * 取某模型名的价格条目。
 *
 * 与旧版的区别：Pro 与 Flash 现在是**两档不同价格**，不再所有模型名共用一档；
 * 未收录的模型名才退到 `default`（= Flash 价）。
 * @param model - 请求中的模型 id。
 * @returns 命中的价格条目。
 */
export function priceEntryFor(model) {
  const { rule } = priceRuleFor(model)
  return DEFAULT_PRICE_TABLE.models[rule] ?? DEFAULT_PRICE_TABLE.default
}

/**
 * 某一时刻是否处于峰时段。官方口径：峰时段仅周一至周五（UTC 自然日）的
 * 01:00–04:00 与 06:00–10:00；周六/周日全天按谷期计价，无峰谷切换。
 * @param atMs - 时刻（epoch ms）。
 * @param windows - 峰时段窗口数组（缺省用官方默认窗口）。
 * @returns 峰时段返回 true；周末或窗口外返回 false。
 */
export function isPeakHour(atMs, windows = DEFAULT_PEAK_WINDOWS) {
  if (!Array.isArray(windows) || windows.length === 0) return false
  const d = new Date(atMs)
  const day = d.getUTCDay()
  if (day === 0 || day === 6) return false // 周末全天谷期（峰时段仅周一至周五）
  const hour = d.getUTCHours()
  return windows.some(w => {
    const start = Number(w?.start)
    const end = Number(w?.end)
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false
    if (start < end) return hour >= start && hour < end
    // 跨午夜窗口（本配置不会出现，兼容处理）。
    return hour >= start || hour < end
  })
}

/**
 * 某一时刻所处的峰谷相位与相邻相位切换点（供倒计时/进度条展示）。
 * 窗口为半开区间 [start, end)（UTC 小时），兼容跨午夜窗口（end <= start）。
 * 周末（UTC 周六/周日）无切换点：此时下一时刻为下一个工作日首次进入峰时；
 * 为覆盖周六 → 周一（含周一 00:00–01:00 的 prev 落在上周五）的跨度，切换点收集范围扩展到 -3 ~ +3 天。
 * @param atMs - 时刻（epoch ms）。
 * @param windows - 峰时段窗口数组。
 * @returns { inPeak, prevAtMs, nextAtMs, nextIntoPeak }，或 null（无有效窗口/时刻）。
 *   prevAtMs = 当前相位起点，nextAtMs = 下一次切换时刻，
 *   nextIntoPeak = 该次切换是否进入峰时段。
 */
export function peakPhaseAt(atMs, windows = DEFAULT_PEAK_WINDOWS) {
  if (!Array.isArray(windows) || windows.length === 0 || !Number.isFinite(atMs)) return null
  const hourAt = (dayOffset, hour) => {
    const date = new Date(atMs)
    date.setUTCDate(date.getUTCDate() + dayOffset)
    date.setUTCHours(hour, 0, 0, 0)
    return date.getTime()
  }
  // 收集前三天到后三天的全部切换点，保证任意时刻都能取到前后相邻切换点
  // （周末无窗口点：周六/周日的 prev 落在周五，next 落在下周一；周一 00:00–01:00 的 prev 需回溯到上周五）。
  const points = []
  for (let day = -3; day <= 3; day += 1) {
    const d = new Date(hourAt(day, 0))
    const dow = d.getUTCDay()
    if (dow === 0 || dow === 6) continue // 周末无峰谷切换
    for (const w of windows) {
      const start = Number(w?.start)
      const end = Number(w?.end)
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue
      points.push({ at: hourAt(day, start), intoPeak: true })
      // 跨午夜窗口的结束点落在次日。
      points.push({ at: hourAt(end <= start ? day + 1 : day, end), intoPeak: false })
    }
  }
  const inPeak = isPeakHour(atMs, windows)
  let prev = null
  let next = null
  for (const p of points) {
    if (p.at <= atMs && (prev === null || p.at > prev.at)) prev = p
    if (p.at > atMs && (next === null || next.at < next.at)) next = p
  }
  if (prev === null || next === null) return null
  return { inPeak, prevAtMs: prev.at, nextAtMs: next.at, nextIntoPeak: next.intoPeak }
}

/**
 * 为一次用量挑选价格档位：峰谷时代前（2026-08-16 16:00 UTC）→ 当时基础价；
 * 生效后峰时段 → peak；否则 → offPeak。
 * @param entry - 模型价格记录。
 * @param atMs - 计费时刻。
 * @returns 三档价格 { cacheHit, cacheMiss, output, reasoning? }。
 */
export function tierFor(entry, atMs) {
  const base = entry ?? { cacheHit: 0, cacheMiss: 0, output: 0 }
  const asTier = price => price?.reasoning === undefined
    ? { cacheHit: price?.cacheHit ?? 0, cacheMiss: price?.cacheMiss ?? 0, output: price?.output ?? 0 }
    : { cacheHit: price.cacheHit, cacheMiss: price.cacheMiss, output: price.output, reasoning: price.reasoning }
  // 峰谷时代之前：按当时的基础价计费（历史正确性）。
  if (Number.isFinite(atMs) && atMs < Date.parse(LEGACY_BASE_BOUNDARY)) {
    const lb = base.legacyBase
    return lb === undefined ? asTier(base) : asTier(lb)
  }
  if (isPeakHour(atMs)) {
    const p = base.peak
    return p === undefined ? asTier(base) : asTier(p)
  }
  const off = base.offPeak
  return off === undefined ? asTier(base) : asTier(off)
}

/**
 * 一次调用的美元成本。
 * @param tokens - { input, output, cacheRead, cacheWrite, reasoning? } 各桶 token 数。
 * @param entry - 模型价格记录。
 * @param atMs - 计费时刻。
 * @returns 美元成本（非负）。
 */
export function costOf(tokens, entry, atMs) {
  const tier = tierFor(entry, atMs)
  const input = Math.max(0, Number(tokens?.input) || 0)
  const output = Math.max(0, Number(tokens?.output) || 0)
  const cacheRead = Math.max(0, Number(tokens?.cacheRead) || 0)
  const cacheWrite = Math.max(0, Number(tokens?.cacheWrite) || 0)
  const reasoning = Math.max(0, Number(tokens?.reasoning) || 0)
  const reasoningPrice = typeof tier.reasoning === 'number' ? tier.reasoning : 0
  return (input * tier.cacheMiss
    + output * tier.output
    + (cacheRead + cacheWrite) * tier.cacheHit
    + reasoning * reasoningPrice) / 1e6
}
