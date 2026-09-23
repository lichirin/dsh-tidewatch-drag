/**
 * dsh-tidewatch 宿主插件。
 *
 * 职责只有一个：注册 `costUsage` 会话投影——从会话事件流（request/header、
 * assistant/chunk、assistant/message）收集每次模型调用的 usage 块，按事件
 * 时刻（event.time）用官方峰谷两档价格逐次计费，产出 token 桶与美元成本。
 * 前端（lib/client.js）经 useProjection('costUsage') 读取，按可配汇率换算
 * 人民币显示。
 *
 * 价格表见 lib/pricing.js：官方现有两个在售价格的模型，按请求头里的模型名
 * 分档计费——`deepseek-flash` 谷时 ¥0.02 / ¥1 / ¥4、`deepseek-v4-pro` 谷时
 * ¥0.15 / ¥4.5 / ¥13.5（每 M tokens，峰时均 ×2）；旧 Flash 名
 * （deepseek-v4-flash / deepseek-v4-flash-vision-exp）官方按 Flash 价计费，
 * 未收录的模型名兜底按 Flash 价估算。
 *
 * 投影工厂结构借鉴自 dsh-cost-meter（MIT License），按精简目标改写：
 * 无账本、无 RPC、无配置，峰谷恒启用（官方 2026-08-17 起两档方案已即时生效）。
 */

import { z } from 'zod'
import { costOf, priceRuleFor, DEFAULT_PRICE_TABLE } from './pricing.js'

export const name = 'tidewatch'

const bucketSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  reasoning: z.number(),
  cost: z.number(),
})

/** 未收录模型名的告警去重集合：每个模型名只提醒一次，避免逐次调用刷屏。 */
const warnedModels = new Set()

/**
 * 模型名未收录于官方价格表时提示一次（按兜底价估算，不阻断计费）。
 * @param model - 请求头里的模型名。
 * @param rule - 实际采用的兜底价格规则键。
 */
function warnUnmatchedModel(model, rule) {
  if (warnedModels.has(model)) return
  warnedModels.add(model)
  console.warn(`[dsh-tidewatch] 模型 "${model}" 未收录于官方价格表，暂按 ${rule} 价估算`)
}

// 投影内部状态 schema（session-projection 新版接口：stateSchema 在持久化缓存
// 恢复前校验 state；state 必须是 plain JSON）。
// `last.buckets` 是**纯 token 桶**（无 cost），金额单独放在 `last.cost`——
// 这正是 apply 实际写入的形状（此前 schema 误把 buckets 写成含 cost 的
// bucketSchema，导致任何已产生调用的会话都不通过校验）。
const tokenBucketsSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  reasoning: z.number(),
})

const costUsageStateSchema = z.object({
  provider: z.string(),
  model: z.string(),
  totals: bucketSchema,
  byModel: z.record(z.string(), bucketSchema),
  last: z.union([
    z.null(),
    z.object({ key: z.string(), model: z.string(), buckets: tokenBucketsSchema, cost: z.number() }),
  ]),
})

// 客户端 wire 载荷 schema（view 输出，随 session/projection 帧推送给浏览器）。
const usageProjectionSchema = z.object({
  model: z.string(),
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  reasoning: z.number(),
  cost: z.number(),
  byModel: z.record(z.string(), bucketSchema),
})

/**
 * costUsage 会话投影工厂：闭包无状态（不依赖账本/配置），按**每次请求头里的模型**
 * 取价格条目、按事件时刻 (event.time) 取峰谷档位逐次计费，保证会话徽章历史正确。
 */
function makeCostUsageProjection() {
  const zeroBuckets = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 })
  return {
    key: 'costUsage',
    stateSchema: costUsageStateSchema,
    // v3：适配 session-projection 新版接口（stateSchema + wire.view 结构）。
    // 旧缓存行按旧版本号持久化，版本不符会被丢弃重放。
    // 注意：官方改价（2026-09 调价、以及 Pro 独立成档）时刻意**不**提升版本号
    // ——已缓存的会话保留改价前算出的历史金额（老会话当时确实花了那么多钱）；
    // 从未计过费的会话首次打开时按**当前**价与**当前**模型档位计算。
    stateVersion: 3,
    init: () => ({ provider: 'deepseek', model: 'default', totals: zeroBuckets(), byModel: {}, last: null }),
    apply(state, event) {
      if (event.type === 'request/header') {
        const model = event.data?.header?.config?.model
        const provider = event.data?.header?.config?.provider
        const nextModel = typeof model === 'string' && model.length > 0 ? model : 'default'
        const nextProvider = typeof provider === 'string' && provider.length > 0 ? provider : 'deepseek'
        return nextModel === state.model && nextProvider === state.provider ? state : { ...state, model: nextModel, provider: nextProvider }
      }
      let usage = null
      let turn = 0
      let step = 0
      if (event.type === 'assistant/chunk' && event.data?.chunk?.type === 'usage' && event.data.chunk.usage !== undefined) {
        usage = event.data.chunk.usage
        turn = event.data.turn
        step = event.data.step
      } else if (event.type === 'assistant/message' && event.data?.usage !== undefined) {
        usage = event.data.usage
        turn = event.data.turn
        step = event.data.step
      } else {
        return state
      }
      const buckets = {
        input: usage.inputTokens ?? 0,
        output: usage.outputTokens ?? 0,
        cacheRead: usage.cacheReadTokens ?? 0,
        cacheWrite: usage.cacheWriteTokens ?? 0,
        reasoning: usage.reasoningTokens ?? 0,
      }
      const key = `${turn}:${step}`
      const prev = state.last !== null && state.last.key === key ? state.last : null
      if (prev !== null && prev.provider === state.provider && prev.model === state.model
        && prev.buckets.input === buckets.input && prev.buckets.output === buckets.output
        && prev.buckets.cacheRead === buckets.cacheRead && prev.buckets.cacheWrite === buckets.cacheWrite
        && prev.buckets.reasoning === buckets.reasoning) {
        return state
      }
      // 按事件时刻计费（历史正确）：峰谷时代前用 legacyBase，之后按峰谷两档。
      // 价格条目按当前请求头的模型名解析——Pro 与 Flash 是两档不同价格，
      // 同一会话中途切换模型时，各次调用分别按各自模型单价计算。
      const atMs = Number.isFinite(Number(event.time)) && Number(event.time) > 0 ? Number(event.time) : Date.now()
      const { rule, matched } = priceRuleFor(state.model)
      const entry = DEFAULT_PRICE_TABLE.models[rule] ?? DEFAULT_PRICE_TABLE.default
      const billed = costOf(buckets, entry, atMs)
      if (!matched) warnUnmatchedModel(state.model, rule)
      // 同一 (turn, step) 的最终样本替换流式样本，先减后加，避免重复计数。
      const totals = { ...state.totals }
      const byModel = { ...state.byModel }
      const shift = (model, bucket, cost, sign) => {
        totals.input += sign * bucket.input
        totals.output += sign * bucket.output
        totals.cacheRead += sign * bucket.cacheRead
        totals.cacheWrite += sign * bucket.cacheWrite
        totals.reasoning += sign * bucket.reasoning
        totals.cost += sign * cost
        const current = byModel[model] ?? zeroBuckets()
        byModel[model] = {
          input: current.input + sign * bucket.input,
          output: current.output + sign * bucket.output,
          cacheRead: current.cacheRead + sign * bucket.cacheRead,
          cacheWrite: current.cacheWrite + sign * bucket.cacheWrite,
          reasoning: current.reasoning + sign * bucket.reasoning,
          cost: current.cost + sign * cost,
        }
      }
      if (prev !== null) shift(prev.model, prev.buckets, prev.cost, -1)
      shift(state.model, buckets, billed, 1)
      return { provider: state.provider, model: state.model, totals, byModel, last: { key, model: state.model, buckets, cost: billed } }
    },
    // 客户端可见视图：缺失 wire 会令该投影成为 host-only，浏览器端
    // useProjection 永远读不到——这是 DSH 升级后消费恒为 0 的根因。
    wire: {
      viewSchema: usageProjectionSchema,
      view(state) {
        return {
          // 当前会话正在使用的模型（最近一次请求头的 model；无请求时为 default）。
          model: state.model,
          input: state.totals.input,
          output: state.totals.output,
          cacheRead: state.totals.cacheRead,
          cacheWrite: state.totals.cacheWrite,
          reasoning: state.totals.reasoning,
          cost: state.totals.cost,
          // byModel 的每一项都带宿主逐次算好的 cost（按每次调用发生时刻的档位）。
          // 前端必须**直接采用**这些金额：它们才是权威的历史口径；
          // 用「当前价格 × 历史 token」重算会把谷时的历史显示成峰时价。
          byModel: state.byModel,
        }
      },
    },
  }
}

/**
 * 挂载：注册 costUsage 会话投影。无其他宿主职责。
 * @param ctx - 宿主插件上下文。
 */
export function apply(ctx) {
  console.log('[dsh-tidewatch] loaded (peak/off-peak tide card)')
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register(makeCostUsageProjection())
  })
}
