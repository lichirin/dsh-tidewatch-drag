/**
 * 面板拖动 / 缩放 / 自适应弹出方向的 DOM 级自检（可交互性回归）。
 * 运行：node test/panel.mjs
 *
 * 用最小 React 外壳渲染 lib/client.js 的 TideCard，直接派发 pointer 事件并观察
 * 样式与 localStorage，覆盖：默认自适应 → 拖动 → 八个缩放区（抓边锚对边）→
 * 最小尺寸与视口边界回推 → 指针捕获 / 光标锁定 / Esc 取消 → 触摸命中带 → 复位 →
 * 弹出方向翻转（扫描 18 个徽章位置，含真实翻转分支）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// ── 最小宿主环境 ────────────────────────────────────────────────────────
const storage = new Map()
global.localStorage = {
  getItem: k => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: k => storage.delete(k),
}
// 面板位置由 measure() 里的 requestAnimationFrame 计算，测试内同步执行即可。
global.requestAnimationFrame = fn => { fn(); return 0 }
global.cancelAnimationFrame = () => {}
global.ResizeObserver = class { observe() {} disconnect() {} }
global.MutationObserver = class { observe() {} disconnect() {} }
// 组件里的秒级倒计时会 setInterval；测试不需要真实计时，否则进程无法退出。
const timers = new Set()
global.setInterval = fn => { const id = { fn }; timers.add(id); return id }
global.clearInterval = id => timers.delete(id)

const listeners = new Map()
global.window = {
  innerWidth: 1200,
  innerHeight: 800,
  addEventListener: (t, fn) => listeners.set(t, fn),
  removeEventListener: t => listeners.delete(t),
}

// 输入框卡片：徽章与面板都以它为锚（rect 可控，用于验证弹出方向）。
// 卡片靠左，徽章才能正常贴在卡片右侧（否则徽章会被移到卡片上方，纵向两侧都缺空间）。
const composer = { rect: { left: 200, top: 500, right: 400, bottom: 600, width: 200, height: 100 } }
function setComposerTop(top) {
  composer.rect = { left: 200, top, right: 400, bottom: top + 100, width: 200, height: 100 }
}

/** tw-root 容器：client.js 用它的 offsetWidth/offsetHeight 做徽章尺寸测量。
 *  矩形按「徽章实际样式坐标」动态计算，否则面板定位会读到错误的徽章位置。 */
function makeChipElement() {
  const rect = { left: 0, top: 0, right: 180, bottom: 24, width: 180, height: 24 }
  return {
    name: 'tw-root',
    offsetWidth: 180,
    offsetHeight: 24,
    classList: { add() {}, remove() {} },
    contains: () => true,
    getBoundingClientRect: () => ({ ...rect }),
    /** 由测试在每次渲染后调用：把样式里的 right/bottom 换算成视口矩形。 */
    syncFromStyle(style) {
      if (style === undefined || style === null) return
      const right = Number(style.right)
      const bottom = Number(style.bottom)
      if (!Number.isFinite(right) || !Number.isFinite(bottom)) return
      rect.right = window.innerWidth - right
      rect.left = rect.right - 180
      rect.bottom = window.innerHeight - bottom
      rect.top = rect.bottom - 24
    },
  }
}

/** 假面板元素：client.js 只用到 classList / getBoundingClientRect。 */
function makePanelElement() {
  return {
    name: 'panel',
    offsetWidth: 320,
    offsetHeight: 430,
    classList: { add() {}, remove() {} },
    contains: () => true,
    getBoundingClientRect: () => ({ left: 8, top: 200, right: 328, bottom: 630, width: 320, height: 430 }),
  }
}

let captured = null
global.document = {
  querySelector: selector => (selector === '[data-composer-card]' ? { getBoundingClientRect: () => composer.rect } : null),
  createElement: () => ({ setAttribute() {}, style: {}, textContent: '' }),
  head: { appendChild() {} },
  addEventListener() {},
  removeEventListener() {},
  // body.style 用于观测拖拽期间的光标锁定（对照 Win32 尺寸循环）。
  body: { style: {} },
}
window.__ModuleLoader__ = { load: m => { captured = m } }

// ── 最小 React 外壳（每次 mount 重置 hook 状态）─────────────────────────
const state = { hooks: [], cursor: 0, dirty: false, renderedBefore: false, tree: null, pending: [], component: null, props: null }

const react = {
  useState(init) {
    const i = state.cursor++
    if (state.hooks.length <= i) state.hooks[i] = { value: typeof init === 'function' ? init() : init }
    const hook = state.hooks[i]
    return [hook.value, next => {
      const value = typeof next === 'function' ? next(hook.value) : next
      if (Object.is(value, hook.value)) return
      hook.value = value
      schedule()
    }]
  },
  useEffect(fn, deps) {
    const i = state.cursor++
    const prev = state.hooks[i]
    // 依赖数组按浅比较判断是否重跑（与 React 行为一致）：无数组=每次；空数组=仅首次。
    let changed
    if (prev === undefined || deps === undefined) changed = true
    else if (!Array.isArray(prev.deps) || prev.deps.length !== deps.length) changed = true
    else changed = deps.some((d, k) => !Object.is(d, prev.deps[k]))
    if (prev === undefined) state.hooks[i] = { deps, cleanup: undefined }
    else state.hooks[i].deps = deps
    if (!changed) return
    const hook = state.hooks[i]
    state.pending.push(() => {
      if (typeof hook.cleanup === 'function') hook.cleanup()
      hook.cleanup = fn()
    })
  },
  useRef(init) {
    const i = state.cursor++
    if (state.hooks.length <= i) state.hooks[i] = { current: init }
    return state.hooks[i]
  },
  createElement: (type, props, ...children) => {
    const node = { type, props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] } }
    // 模拟 React 挂载 ref：按 className 区分 tw-root（徽章容器）与面板。
    const ref = props?.ref
    if (ref !== null && typeof ref === 'object') {
      const isRoot = typeof props?.className === 'string' && props.className.includes('tw-root')
      ref.current = isRoot ? makeChipElement() : makePanelElement()
    }
    return node
  },
}

function render() {
  state.cursor = 0
  state.tree = state.component(state.props)
  // 把徽章实际坐标同步给假元素，后续测量（面板定位）才拿到正确矩形。
  const chipEl = state.tree?.props?.ref?.current
  if (chipEl !== null && chipEl !== undefined && typeof chipEl.syncFromStyle === 'function') {
    chipEl.syncFromStyle(state.tree.props?.style)
  }
}
function flush() {
  state.dirty = false
  const hadEffects = state.pending.length > 0
  const fns = state.pending.splice(0, state.pending.length)
  for (const fn of fns) fn()
  if (hadEffects || !state.renderedBefore || state.dirty) render()
  state.renderedBefore = true
}
function schedule() {
  state.dirty = true
  queueMicrotask(flush)
}
/** 渲染 + 结算，直到状态收敛（面板定位依赖「徽章矩形」而徽章矩形又由渲染决定，
 *  所以需要迭代几轮；最多 8 轮，避免意外死循环）。 */
function renderAndSettle() {
  for (let i = 0; i < 8; i += 1) {
    const before = JSON.stringify(state.tree?.props?.style ?? null) + state.hooks.map(h => JSON.stringify(h?.value ?? null)).join('|')
    render()
    flush()
    const after = JSON.stringify(state.tree?.props?.style ?? null) + state.hooks.map(h => JSON.stringify(h?.value ?? null)).join('|')
    if (before === after) return
  }
}
/** 挂载（重置全部 hook 状态，模拟全新组件实例）。 */
function mount(component, props) {
  state.hooks = []
  state.cursor = 0
  state.dirty = false
  state.renderedBefore = false
  state.tree = null
  state.pending = []
  state.component = component
  state.props = props
  renderAndSettle()
}
const settle = async () => {
  await Promise.resolve(); flush()
  await Promise.resolve(); renderAndSettle()
}

new Function('window', 'document', readFileSync('lib/client.js', 'utf8'))(globalThis.window, globalThis.document)
const client = captured.factory(name => (name === 'react' ? react : (() => { throw new Error('unexpected require: ' + name) })()))
const TideCard = client.__test__?.TideCard
assert.ok(TideCard !== undefined, 'lib/client.js 未导出 __test__.TideCard')

const usageProjection = {
  model: 'deepseek-flash',
  input: 1000,
  output: 500,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  cost: 0.001,
  byModel: { 'deepseek-flash': { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0.001 } },
}
const baseProps = {
  useSessions: selector => selector({ current: 'session-1' }),
  useProjection: () => usageProjection,
}
storage.set('dsh-tidewatch:expanded', '1')

// ── 查询工具 ────────────────────────────────────────────────────────────
const tree = () => state.tree
function find(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (predicate(node)) return node
  const kids = node.props?.children
  const list = Array.isArray(kids) ? kids.flat(Infinity) : [kids]
  for (const kid of list) {
    const hit = find(kid, predicate)
    if (hit !== null) return hit
  }
  return null
}
const byClass = name => node => typeof node.props?.className === 'string' && node.props.className.split(' ').includes(name)
const classOf = node => (typeof node.props?.className === 'string' ? node.props.className : '')
const styleOf = node => node?.props?.style ?? {}
/** 面板上/下边：向上弹出时 style 只给 bottom（锚底边），需要按高度反推；反向用 maxHeight 兜底。 */
const panelTopOf = style => (style.top !== undefined
  ? Number(style.top)
  : global.window.innerHeight - Number(style.bottom) - Number(style.height ?? style.maxHeight ?? 0))
const panelBottomOf = style => (style.bottom !== undefined
  ? global.window.innerHeight - Number(style.bottom)
  : Number(style.top) + Number(style.height ?? style.maxHeight ?? 0))
/** 徽章（tw-root）实测矩形上边：用来断言面板底边贴在它上方 10px。 */
const chipTopY = () => Number(state.tree?.props?.ref?.current?.getBoundingClientRect?.().top ?? 0)
const panelEl = () => find(tree(), byClass('tw-panel'))
const headEl = () => find(tree(), byClass('tw-panel-head'))
const gripEl = () => find(tree(), byClass('tw-grip'))
/** 边框命中区（对照 WM_NCHITTEST 的 HTLEFT…HTBOTTOMRIGHT）。 */
const zoneEl = zone => find(tree(), byClass('tw-rs-' + zone))
/** 面板开向：贴徽章的是右缘时返回 true（面板向左展开）。 */
const opensLeft = () => classOf(panelEl()).includes('tw-panel-left')
/** 贴徽章那条竖边的底角命中区（右开 = se、左开 = sw）：原可见抓手承担的那个入口，现已合并到边框命中层。 */
const badgeCornerEl = () => zoneEl(opensLeft() ? 'sw' : 'se')
const resetBtn = () => find(tree(), node => node.type === 'button' && node.props?.className === 'tw-panel-reset')
const storedGeom = () => {
  const raw = storage.get('dsh-tidewatch-panel-v1')
  return raw === undefined ? null : JSON.parse(raw)
}

const GEOM_KEY = 'dsh-tidewatch-panel-v1'
const POS_KEY = 'dsh-tidewatch-position-v1'
const CUSTOM = { width: 340, height: 430, offsetX: 0, offsetY: 0 }
const mountDefault = () => { storage.delete(GEOM_KEY); storage.delete(POS_KEY); mount(TideCard, { ...baseProps }) }
const mountCustom = (geom = { ...CUSTOM }) => {
  storage.set(GEOM_KEY, JSON.stringify(geom))
  storage.delete(POS_KEY)
  mount(TideCard, { ...baseProps })
}

/** 完整拖拽：pointerdown → pointermove → pointerup，并结算渲染。 */
async function drag(el, fromX, fromY, toX, toY) {
  assert.ok(el !== null && el !== undefined, '拖拽目标不存在')
  const down = el.props.onPointerDown
  assert.equal(typeof down, 'function', '拖拽目标未绑定 onPointerDown')
  down({ button: 0, clientX: fromX, clientY: fromY, preventDefault() {}, stopPropagation() {}, target: { closest: () => null } })
  const move = listeners.get('pointermove')
  assert.equal(typeof move, 'function', '未注册 pointermove 监听')
  move({ clientX: toX, clientY: toY })
  listeners.get('pointerup')({})
  await settle()
}

let passed = 0
async function check(name, fn) {
  await fn()
  passed += 1
  console.log('  ok', name)
}

console.log('展开面板的可拖动 / 可缩放 / 自适应方向')

// ── 场景 1：默认自适应 ──────────────────────────────────────────────────
await check('默认态：自适应布局，边框命中区常驻、复位按钮不显示、头部不可拖动', () => {
  mountDefault()
  const panel = panelEl()
  assert.ok(panel !== null, '未渲染面板')
  assert.ok(classOf(panel).includes('tw-panel-fit'), `实际 className=${classOf(panel)}`)
  assert.equal(classOf(panel).includes('tw-panel-custom'), false)
  assert.equal(styleOf(panel).width, 320, '默认宽度 320')
  assert.equal(styleOf(panel).height, undefined, '默认高度自适应（不固定 height）')
  assert.ok(styleOf(panel).maxHeight > 0, '应给出 maxHeight 上限')
  assert.ok(styleOf(panel).left >= 0, '面板应已按视口定位')
  // 向上弹出改为按底边锚定：底边贴在徽章上方 10px。旧实现一律用
  // top = 徽章顶 − 间距 − maxHeight，内容比可用空间矮时面板就飘到视口顶端——
  // 下面这几条是那条回归的守门断言（旧实现 style 里没有 bottom，第一条必红）。
  assert.equal(styleOf(panel).bottom, global.window.innerHeight - chipTopY() + 10, '向上弹出应用 bottom 锚定底边（不依赖高度）')
  assert.equal(panelBottomOf(styleOf(panel)), chipTopY() - 10, '底边应贴徽章上方 10px')
  assert.ok(panelTopOf(styleOf(panel)) >= 8, `即使撑满 maxHeight 也不应越上边界：${panelTopOf(styleOf(panel))}`)
  assert.equal(styleOf(panel).visibility, undefined, '已测量，不应再隐藏')
  // 缩放入口只剩边框命中层：可见抓手已移除，但默认态就有贴徽章侧的底角命中区可拖
  assert.equal(gripEl(), null, '不应再有可见抓手（缩放入口改为边框命中层）')
  assert.ok(badgeCornerEl() !== null, '默认态也应有贴徽章侧的底角命中区')
  assert.equal(typeof badgeCornerEl().props.onPointerDown, 'function', '底角命中区应可直接拖动')
  assert.equal(resetBtn(), null, '默认态不应显示复位按钮')
  assert.equal(headEl().props.onPointerDown, undefined, '默认态头部不应可拖动')
})

// ── 费用口径回归：已花金额必须用宿主账本，绝不按当前峰谷价重算 ──────────────
// 旧实现的 bug：徽章用「当前档位 × 历史 token」重算合计，于是谷时花的 ¥5
// 在峰时重新打开会话会显示成 ¥10。下面几条把「同一份账本，换个钟点打开，
// 金额一字不变」钉死。

/** 递归收集渲染树里的文本，用于断言面板上显示的金额文字。 */
function textOfAll(node, acc = []) {
  if (typeof node === 'string') { acc.push(node); return acc }
  if (node === null || node === undefined || typeof node !== 'object') return acc
  const kids = node.props?.children
  const list = Array.isArray(kids) ? kids.flat(Infinity) : [kids]
  for (const kid of list) textOfAll(kid, acc)
  return acc
}
/** 面板里是否显示了某个金额文字（人民币 2 位小数）。 */
const panelTextIncludes = text => textOfAll(panelEl()).some(t => t.includes(text))
/** 用指定的投影载荷挂载（其余同 baseProps）。
 *  TideCard 的金额来自 bridge（真实运行时由 Probe 写入），故这里同时驱动 bridge。 */
const bridge = client.__test__?.bridge
const mountWithUsage = usage => {
  storage.delete(GEOM_KEY)
  storage.delete(POS_KEY)
  bridge.set({ sessionId: 'session-1', usage: usage ?? null })
  mount(TideCard, { ...baseProps, useProjection: () => usage })
}

// 谷时计价的历史账本：cashMiss 1M + output 1M → ¥5（宿主按事件时刻算好并持久化）
const OFFPEAK_LEDGER = {
  model: 'deepseek-flash',
  input: 1_000_000,
  output: 1_000_000,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  cost: 5 / 6.82,
  byModel: {
    'deepseek-flash': { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 5 / 6.82 },
  },
}

/** 把时钟固定在指定时刻，跑一段断言后恢复。 */
const withClock = (atMs, fn) => {
  const realNow = Date.now
  Date.now = () => atMs
  try { return fn() } finally { Date.now = realNow }
}
// 2026-09-16 是周三：02:00 UTC 为峰时、05:00 UTC 为谷时。
const PEAK_AT = Date.parse('2026-09-16T02:00:00Z')
const OFFPEAK_AT = Date.parse('2026-09-16T05:00:00Z')

await check('费用口径：谷时花掉的 ¥5，在峰时重新打开会话仍显示 ¥5（不按当前价重算）', () => {
  mountWithUsage(OFFPEAK_LEDGER)
  // 谷时打开：显示宿主账本金额
  withClock(OFFPEAK_AT, () => {
    mountWithUsage(OFFPEAK_LEDGER)
    assert.ok(panelTextIncludes('¥5.00'), `谷时打开应显示 ¥5.00；实际文本：${textOfAll(panelEl()).filter(t => t.includes('¥')).join(' | ')}`)
  })
  // 峰时打开同一份账本：必须还是 ¥5.00，不能变成 ¥10.00
  withClock(PEAK_AT, () => {
    mountWithUsage(OFFPEAK_LEDGER)
    const money = textOfAll(panelEl()).filter(t => t.includes('¥'))
    assert.ok(panelTextIncludes('¥5.00'), `峰时打开应仍显示 ¥5.00；实际文本：${money.join(' | ')}`)
    assert.equal(panelTextIncludes('¥10.00'), false, `峰时打开不应重算成 ¥10.00；实际文本：${money.join(' | ')}`)
  })
})

await check('费用口径：分模型明细取宿主逐次算好的金额（不按当前档位重算）', () => {
  const ledger = {
    model: 'deepseek-flash',
    input: 1_000_000,
    output: 1_000_000,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    cost: 5 / 6.82,
    byModel: {
      'deepseek-flash': { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 5 / 6.82 },
    },
  }
  withClock(PEAK_AT, () => {
    mountWithUsage(ledger)
    // 展开分模型明细
    const costRow = find(tree(), node => typeof node.props?.className === 'string' && node.props.className.includes('tw-total'))
    assert.ok(costRow !== null, '未找到「本次会话费用」行')
    costRow.props.onClick()
    // 明细行的金额必须等于宿主值 ¥5.00（而非按峰时重算的 ¥10.00）
    const money = textOfAll(panelEl()).filter(t => t.includes('¥'))
    assert.ok(panelTextIncludes('¥5.00'), `分模型明细应含 ¥5.00；实际：${money.join(' | ')}`)
    assert.equal(money.some(t => t.includes('¥10.00')), false, `不应出现按峰时重算的 ¥10.00；实际：${money.join(' | ')}`)
  })
})

await check('费用口径：旧缓存缺 cost 字段时才回退重算，且仍显示正数金额', () => {
  // 模拟早期版本写下的 byModel（只有 token，没有 cost）
  const legacy = {
    model: 'deepseek-flash',
    input: 1_000_000,
    output: 1_000_000,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    cost: 5 / 6.82,
    byModel: { 'deepseek-flash': { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0, reasoning: 0 } },
  }
  withClock(OFFPEAK_AT, () => {
    mountWithUsage(legacy)
    assert.ok(panelTextIncludes('¥5.00'), `缺 cost 时应回退重算为 ¥5.00（谷时）；实际：${textOfAll(panelEl()).filter(t => t.includes('¥')).join(' | ')}`)
  })
})

// 面板开向哪边，贴徽章那侧的底角命中区就在哪边的底角（右开 = se、左开 = sw）。

await check('默认态直接拖底角命中区即可缩放（无需先做别的操作）', async () => {
  mountDefault()
  assert.equal(storedGeom(), null, '前置条件：尚无自定义几何')
  const before = styleOf(panelEl())
  const corner = badgeCornerEl()
  // 朝面板开向拖 = 变宽（被抓的边跟着指针往外走）
  const toX = opensLeft() ? 250 : 350
  await drag(corner, 300, 700, toX, 700)
  const geom = storedGeom()
  assert.ok(geom !== null, '拖动后应持久化几何')
  assert.equal(geom.width, 370, `向外拖 50 → 宽应 320+50，实际 ${geom.width}`)
  assert.ok(classOf(panelEl()).includes('tw-panel-custom'), '拖动后进入自定义态')
  assert.ok(styleOf(panelEl()).width > before.width, '样式宽度应变大')
})

await check('底角命中区紧跟指针（右开面板）：向右拖 50 → 右缘右移 50，左缘不动', async () => {
  mountCustom()
  assert.equal(opensLeft(), false, '前置条件：本 mock 下应右开')
  const before = styleOf(panelEl())
  await drag(badgeCornerEl(), 300, 700, 350, 700)
  const after = styleOf(panelEl())
  assert.equal(after.left, before.left, '左缘应保持不动')
  assert.equal(after.width, before.width + 50, `宽度应 +50，实际 ${after.width}`)
  assert.equal(after.left + after.width, before.left + before.width + 50, '右缘应右移 50（= 指针位移）')
})

await check('底角命中区紧跟指针（右开面板）：向左拖 50 → 右缘左移 50（变窄）', async () => {
  mountCustom()
  const before = styleOf(panelEl())
  await drag(badgeCornerEl(), 300, 700, 250, 700)
  const after = styleOf(panelEl())
  assert.equal(after.left, before.left, '左缘应保持不动')
  assert.equal(after.width, before.width - 50, `宽度应 -50，实际 ${after.width}`)
  assert.equal(after.left + after.width, before.left + before.width - 50, '右缘应左移 50（= 指针位移）')
})

await check('底角命中区紧跟指针（左开面板）：向左拖 → 变宽且右缘（贴徽章那侧）不动', async () => {
  const saveRect = composer.rect
  // 徽章贴视口右缘 → 面板改为向左开
  composer.rect = { left: 1100, top: 500, right: 1190, bottom: 600, width: 90, height: 100 }
  try {
    mountCustom()
    assert.equal(opensLeft(), true, '前置条件：应左开')
    const before = styleOf(panelEl())
    const beforeRight = before.left + before.width
    assert.ok(zoneEl('sw') !== null, '左开时贴徽章侧的底角应为左下角（sw 区）')
    await drag(badgeCornerEl(), 300, 700, 250, 700) // 向左拖 50
    const after = styleOf(panelEl())
    assert.equal(after.right === undefined ? after.left + after.width : after.right, beforeRight, '右缘应保持不动（贴徽章那侧）')
    assert.equal(after.width, before.width + 50, `宽度应 +50，实际 ${after.width}`)
    assert.ok(after.left <= before.left, `左缘应向左（或贴边），实际 ${after.left}`)
  } finally {
    composer.rect = saveRect
  }
})

await check('底角命中区紧跟指针（左开面板）：向右拖 → 变窄且右缘不动', async () => {
  const saveRect = composer.rect
  composer.rect = { left: 1100, top: 500, right: 1190, bottom: 600, width: 90, height: 100 }
  try {
    mountCustom()
    const before = styleOf(panelEl())
    const beforeRight = before.left + before.width
    await drag(badgeCornerEl(), 300, 700, 350, 700) // 向右拖 50
    const after = styleOf(panelEl())
    assert.equal(after.left + after.width, beforeRight, '右缘应保持不动')
    assert.equal(after.width, before.width - 50, `宽度应 -50，实际 ${after.width}`)
  } finally {
    composer.rect = saveRect
  }
})

// ── 场景 2：自定义几何下的拖动 / 缩放 / 复位 ────────────────────────────
await check('自定义态：套 tw-panel-custom、渲染复位按钮（无可见抓手）', () => {
  mountCustom()
  assert.ok(classOf(panelEl()).includes('tw-panel-custom'))
  assert.equal(styleOf(panelEl()).width, 340, '自定义宽度应生效')
  assert.equal(styleOf(panelEl()).height, 430)
  assert.equal(gripEl(), null, '自定义态同样不应有可见抓手')
  assert.ok(badgeCornerEl() !== null, '底角命中区仍在')
  assert.ok(resetBtn() !== null, '应显示复位按钮')
  assert.equal(typeof headEl().props.onPointerDown, 'function', '自定义态头部可拖动')
})

await check('头部拖动：位移写入 localStorage，面板按基准 + 位移定位', async () => {
  mountCustom()
  const base = styleOf(panelEl())
  await drag(headEl(), 500, 500, 530, 470) // 指针向右 30、向上 30
  const geom = storedGeom()
  assert.ok(geom !== null, '几何应被持久化')
  assert.equal(geom.offsetX, 30, `右拖 30 → offsetX 30，实际 ${geom.offsetX}`)
  assert.equal(geom.offsetY, -30, `上拖 30 → offsetY -30，实际 ${geom.offsetY}`)
  assert.equal(geom.width, 340, '仅拖动不改宽度')
  assert.equal(geom.height, 430, '仅拖动不改高度')
  const style = styleOf(panelEl())
  assert.equal(style.left, base.left + 30, `left 应为基准+30，实际 ${style.left}`)
  assert.equal(panelTopOf(style), panelTopOf(base) - 30, `顶边应为基准-30，实际 ${panelTopOf(style)}`)
})

await check('头部拖动越界：位移被夹紧在可视区内', async () => {
  mountCustom()
  await drag(headEl(), 500, 500, 5000, 5000) // 右下拖到底
  let style = styleOf(panelEl())
  assert.ok(style.left >= 8 && style.left + style.width <= 1200 - 8, `面板水平越界：left=${style.left}`)
  assert.ok(panelTopOf(style) >= 8 && panelBottomOf(style) <= 800 - 8, `面板垂直越界：top=${panelTopOf(style)} bottom=${panelBottomOf(style)}`)
  assert.equal(style.left, 1200 - 8 - style.width, '右拖到底应贴右边距')
  assert.equal(panelBottomOf(style), 800 - 8, '下拖到底应贴下边距')
  await drag(headEl(), 500, 500, -5000, -5000) // 左上拖到底
  style = styleOf(panelEl())
  assert.equal(style.left, 8, `左拖到底应贴左边距，实际 ${style.left}`)
  assert.equal(panelTopOf(style), 8, `上拖到底应贴上边距，实际 ${panelTopOf(style)}`)
})

await check('底角命中区缩放：右缘 / 底边跟随指针（向右下拖 → 宽高各 +60）', async () => {
  mountCustom()
  await drag(badgeCornerEl(), 300, 700, 360, 760)
  const geom = storedGeom()
  assert.equal(geom.width, 400, `宽应 340+60，实际 ${geom.width}`)
  assert.equal(geom.height, 490, `高应 430+60，实际 ${geom.height}`)
  assert.equal(styleOf(panelEl()).width, 400, '样式宽度应与记录一致')
  assert.equal(styleOf(panelEl()).height, 490, '样式高度应与记录一致')
})

await check('底角命中区缩放：越界拖拽被夹在上下限与视口之间', async () => {
  mountCustom()
  await drag(badgeCornerEl(), 300, 700, -5000, -5000)
  let geom = storedGeom()
  assert.ok(geom.width >= 240, `宽应 ≥240，实际 ${geom.width}`)
  assert.ok(geom.height >= 180, `高应 ≥180，实际 ${geom.height}`)
  await drag(badgeCornerEl(), 300, 700, 5000, 5000)
  geom = storedGeom()
  assert.ok(geom.width <= 1200 - 16, `宽应 ≤视口，实际 ${geom.width}`)
  assert.ok(geom.height <= 800 - 16, `高应 ≤视口，实际 ${geom.height}`)
  const style = styleOf(panelEl())
  assert.ok(style.left >= 8 && style.left + style.width <= 1200 - 8, '缩放后仍应留在视口内')
})

await check('头部按下按钮区域时不触发拖动（避免与点击冲突）', () => {
  mountCustom()
  listeners.delete('pointermove')
  headEl().props.onPointerDown({
    button: 0, clientX: 500, clientY: 500, preventDefault() {}, stopPropagation() {},
    target: { closest: () => ({}) }, // 命中 button
  })
  assert.equal(listeners.get('pointermove'), undefined, '从按钮上按下不应注册拖动监听')
  assert.equal(storedGeom().offsetX, 0, '位移不应变化')
})

await check('复位面板：清空 localStorage 并回到自适应布局', async () => {
  mountCustom({ width: 500, height: 600, offsetX: 20, offsetY: -10 })
  assert.ok(storedGeom() !== null)
  resetBtn().props.onClick({ stopPropagation() {} })
  await settle()
  assert.equal(storage.has(GEOM_KEY), false, 'localStorage 应已清空')
  assert.ok(classOf(panelEl()).includes('tw-panel-fit'), '应回到 tw-panel-fit')
  assert.ok(badgeCornerEl() !== null, '复位后底角命中区仍可用')
  assert.equal(resetBtn(), null, '复位后隐藏复位按钮')
  assert.equal(styleOf(panelEl()).width, 320, '复位后回到默认宽度 320')
  assert.equal(styleOf(panelEl()).height, undefined, '复位后高度恢复自适应')
})

// ── 场景 3：自适应弹出方向（「跑到可视范围外」的根因回归）───────────────
await check('输入框在视口顶部（长会话向下滚后）：面板自动翻到徽章下方，不顶出屏幕', () => {
  setComposerTop(16)
  mountDefault()
  const style = styleOf(panelEl())
  assert.ok(classOf(panelEl()).includes('tw-panel-below'), `应带 tw-panel-below，实际 ${classOf(panelEl())}`)
  assert.ok(style.top >= 8, `面板顶边越界：top=${style.top}`)
  assert.ok(style.top + style.maxHeight <= 800 - 8, `面板底边越界：${style.top + style.maxHeight}`)
  setComposerTop(500)
})

await check('输入框在中下部：面板仍向上弹出（默认行为不变）', () => {
  setComposerTop(500)
  mountDefault()
  const style = styleOf(panelEl())
  assert.equal(classOf(panelEl()).includes('tw-panel-below'), false, '不应翻到下方')
  assert.ok(style.bottom !== undefined, '向上弹出应按底边锚定（style 只给 bottom）')
  assert.ok(panelBottomOf(style) <= 800 - 8, `面板底边越界：${panelBottomOf(style)}`)
  assert.ok(panelTopOf(style) >= 8, `即使撑满 maxHeight 也不应越上边界：top=${panelTopOf(style)}`)
})

await check('视口变矮时面板高度被压缩，不会顶出屏幕', () => {
  const originalH = global.window.innerHeight
  global.window.innerHeight = 320
  try {
    setComposerTop(240)
    mountDefault()
    const style = styleOf(panelEl())
    assert.ok(style.maxHeight <= 320 - 16, `maxHeight 应被压缩，实际 ${style.maxHeight}`)
    assert.ok(panelBottomOf(style) <= 320 - 8, `底边越界：${panelBottomOf(style)}`)
    assert.ok(panelTopOf(style) >= 8, `即使撑满 maxHeight 也不应越上边界：top=${panelTopOf(style)}`)
  } finally {
    global.window.innerHeight = originalH
    setComposerTop(500)
  }
})

await check('面板翻到下方后再拖动，位移仍能生效（不因方向翻转而失效）', async () => {
  setComposerTop(16)
  mountCustom()
  const base = styleOf(panelEl())
  await drag(headEl(), 500, 500, 470, 500) // 向左 30
  const geom = storedGeom()
  assert.equal(geom.offsetX, -30, `左拖 30 → offsetX -30，实际 ${geom.offsetX}`)
  assert.equal(styleOf(panelEl()).left, base.left - 30, '面板应随位移左移')
  setComposerTop(500)
})

// ── 场景 4：仿 Windows 11 的边框缩放（八区命中 + 抓边锚对边）───────────────
const ZONES = ['n', 's', 'w', 'e', 'nw', 'ne', 'sw', 'se']

await check('边框命中层：八区齐全、每区可按下，带宽/顶边/外扩符合资源管理器口径', () => {
  mountDefault()
  assert.ok(find(tree(), byClass('tw-rs')) !== null, '未渲染边框命中层')
  for (const zone of ZONES) {
    const node = zoneEl(zone)
    assert.ok(node !== null, `缺少缩放区 ${zone}`)
    assert.equal(typeof node.props.onPointerDown, 'function', `${zone} 区未绑定按下处理`)
  }
  const style = styleOf(panelEl())
  assert.equal(style['--tw-band'], '8px', '四边命中带应为 8px（= SM_CXSIZEFRAME + SM_CXPADDEDBORDER）')
  assert.equal(style['--tw-band-top'], '2px', '顶边命中带应为 2px（同资源管理器：顶部让给可拖动的头部）')
  assert.equal(style['--tw-outset'], '3px', '命中带应向外扩 3px（对应 DWM 隐形边框）')
  assert.equal(client.__test__.PANEL_BORDER_BAND, 8)
  assert.equal(client.__test__.PANEL_BORDER_BAND_TOP, 2)
  assert.equal(client.__test__.PANEL_BORDER_OUTSET, 3)
})

await check('抓左缘：左缘跟指针、右缘不动（旧版只能抓右下角）', async () => {
  mountCustom()
  const before = styleOf(panelEl())
  const beforeRight = before.left + before.width
  await drag(zoneEl('w'), 100, 400, 60, 400) // 向左 40
  const after = styleOf(panelEl())
  assert.equal(after.left + after.width, beforeRight, `右缘应保持不动（${after.left + after.width} ≠ ${beforeRight}）`)
  assert.equal(after.width, before.width + 40, `宽应 +40，实际 ${after.width}`)
  assert.equal(after.height, before.height, '拖左右边不应改高度')
})

await check('抓右缘：右缘跟指针、左缘不动，纵向位移被忽略', async () => {
  mountCustom()
  const before = styleOf(panelEl())
  await drag(zoneEl('e'), 400, 400, 460, 430) // 向右 60，附带 30 的纵向位移
  const after = styleOf(panelEl())
  assert.equal(after.left, before.left, '左缘应保持不动')
  assert.equal(after.width, before.width + 60, `宽应 +60，实际 ${after.width}`)
  assert.equal(after.height, before.height, '拖右缘不应改高度')
})

await check('抓上缘：上缘跟指针、下缘不动（旧版顶边完全不可拖）', async () => {
  mountCustom()
  const before = styleOf(panelEl())
  const beforeBottom = panelBottomOf(before)
  await drag(zoneEl('n'), 400, 100, 400, 60) // 向上 40
  const after = styleOf(panelEl())
  assert.equal(panelBottomOf(after), beforeBottom, '下缘应保持不动')
  assert.equal(after.height, before.height + 40, `高应 +40，实际 ${after.height}`)
  assert.equal(after.width, before.width, '拖上下边不应改宽度')
})

await check('抓下缘：下缘跟指针、上缘不动', async () => {
  mountCustom()
  const before = styleOf(panelEl())
  await drag(zoneEl('s'), 400, 600, 430, 660) // 向下 60
  const after = styleOf(panelEl())
  assert.equal(panelTopOf(after), panelTopOf(before), '上缘应保持不动')
  assert.equal(after.height, before.height + 60, `高应 +60，实际 ${after.height}`)
  assert.equal(panelBottomOf(after), panelBottomOf(before) + 60, '下缘应跟指针下移 60')
})

await check('抓左上角：两轴同时改，右下角固定', async () => {
  mountCustom()
  const before = styleOf(panelEl())
  await drag(zoneEl('nw'), 100, 100, 60, 70) // 左 40、上 30
  const after = styleOf(panelEl())
  assert.equal(after.left, before.left - 40, `左缘应左移 40，实际 ${after.left}`)
  assert.equal(panelTopOf(after), panelTopOf(before) - 30, `上缘应上移 30，实际 ${panelTopOf(after)}`)
  assert.equal(after.width, before.width + 40)
  assert.equal(after.height, before.height + 30)
  assert.equal(after.left + after.width, before.left + before.width, '右缘应固定')
  assert.equal(panelBottomOf(after), panelBottomOf(before), '下缘应固定')
})

await check('命中最小尺寸：被抓的边停住、锚定的对边不被推动', async () => {
  mountCustom({ width: 300, height: 430, offsetX: 0, offsetY: 0 })
  const before = styleOf(panelEl())
  const beforeRight = before.left + before.width
  await drag(zoneEl('w'), 100, 400, 600, 400) // 往右猛拖：想压到宽下限以下
  const after = styleOf(panelEl())
  assert.equal(after.width, 240, `应夹在宽下限 240，实际 ${after.width}`)
  assert.equal(after.left + after.width, beforeRight, '锚定的右缘不应被推动')
})

await check('贴徽章侧的底角命中区：右下 / 左下角拖动 → 宽高各 +60', async () => {
  mountCustom()
  const before = styleOf(panelEl())
  await drag(zoneEl(opensLeft() ? 'sw' : 'se'), 300, 700, 360, 760)
  const geom = storedGeom()
  assert.equal(geom.width, before.width + 60, `角区应宽 +60，实际 ${geom.width}`)
  assert.equal(geom.height, before.height + 60, `角区应高 +60，实际 ${geom.height}`)
})

// ── 场景 5：Win32 模态循环的对应物（SetCapture / 光标锁定 / Esc 取消）─────────
/** 直接派发一次按下（可选带 pointerId / currentTarget），返回事件对象。 */
function press(node, props) {
  const down = node.props.onPointerDown
  assert.equal(typeof down, 'function', '目标未绑定 onPointerDown')
  down({ button: 0, preventDefault() {}, stopPropagation() {}, target: { closest: () => null }, ...props })
}

await check('SetCapture 对应物：按下时捕获指针、抬手时释放', async () => {
  mountCustom()
  const calls = []
  const target = {
    setPointerCapture: id => calls.push('set:' + id),
    releasePointerCapture: id => calls.push('release:' + id),
  }
  press(zoneEl('w'), { clientX: 100, clientY: 400, pointerId: 7, currentTarget: target })
  listeners.get('pointermove')({ clientX: 60, clientY: 400 })
  listeners.get('pointerup')({})
  await settle()
  assert.deepEqual(calls, ['set:7', 'release:7'], `实际调用 ${JSON.stringify(calls)}`)
})

await check('尺寸循环期间：加 tw-resizing、锁定光标与选中；抬手后解锁', async () => {
  mountCustom()
  press(zoneEl('e'), { clientX: 400, clientY: 400, pointerId: 3 })
  assert.equal(global.document.body.style.cursor, 'ew-resize', '拖拽期间应锁定缩放光标')
  assert.equal(global.document.body.style.userSelect, 'none', '拖拽期间应禁止选中')
  listeners.get('pointermove')({ clientX: 460, clientY: 400 })
  await settle()
  assert.ok(classOf(panelEl()).includes('tw-resizing'), '拖拽期间面板应带 tw-resizing')
  listeners.get('pointerup')({})
  await settle()
  assert.equal(global.document.body.style.cursor, '', '抬手后应解除光标锁定')
  assert.equal(global.document.body.style.userSelect, '', '抬手后应解除选中锁定')
  assert.equal(classOf(panelEl()).includes('tw-resizing'), false, '抬手后应移除 tw-resizing')
})

await check('缩放中按 Esc：尺寸还原、不写入 localStorage、解除锁定与监听', async () => {
  mountCustom()
  const before = styleOf(panelEl())
  press(zoneEl('s'), { clientX: 400, clientY: 600, pointerId: 9 })
  listeners.get('pointermove')({ clientX: 400, clientY: 760 })
  await settle()
  assert.ok(styleOf(panelEl()).height > before.height, '前置条件：拖动过程中高度已变化')
  assert.equal(global.document.body.style.cursor, 'ns-resize')
  listeners.get('keydown')({ key: 'Escape', preventDefault() {} })
  await settle()
  assert.equal(styleOf(panelEl()).height, before.height, 'Esc 后高度应还原')
  assert.equal(storedGeom().height, 430, '不应把取消的尺寸写入 localStorage')
  assert.equal(global.document.body.style.cursor, '', 'Esc 后应解除光标锁定')
  assert.equal(listeners.get('pointermove'), undefined, 'Esc 后应移除拖拽监听')
  assert.equal(listeners.get('pointerup'), undefined, 'Esc 后应移除抬手监听')
})

await check('头部拖动中按 Esc：位置还原且不写入 localStorage', async () => {
  mountCustom()
  const before = styleOf(panelEl())
  press(headEl(), { clientX: 500, clientY: 500, pointerId: 5 })
  listeners.get('pointermove')({ clientX: 560, clientY: 500 })
  await settle()
  assert.notEqual(styleOf(panelEl()).left, before.left, '前置条件：拖动过程中位置已变化')
  listeners.get('keydown')({ key: 'Escape', preventDefault() {} })
  await settle()
  assert.equal(styleOf(panelEl()).left, before.left, 'Esc 后位置应还原')
  assert.equal(storedGeom().offsetX, 0, '不应把取消的位移写入 localStorage')
})

await check('触摸/笔（粗指针）：命中带按 Windows 做法放宽，细指针回到 8px', async () => {
  global.window.matchMedia = q => ({ matches: q === '(pointer: coarse)' })
  try {
    mountDefault()
    const style = styleOf(panelEl())
    assert.equal(style['--tw-band'], '14px', '触摸下四边带应放宽到 14px')
    assert.equal(style['--tw-band-top'], '6px', '触摸下顶边带应放宽到 6px（否则手指抓不住）')
    assert.equal(style['--tw-outset'], '6px')
    assert.equal(client.__test__.PANEL_RESIZE_CURSORS.nw, 'nwse-resize', '角区光标表应与边一致')
  } finally {
    delete global.window.matchMedia
  }
  mountDefault()
  assert.equal(styleOf(panelEl())['--tw-band'], '8px', '细指针下应回到 8px')
})

await check('扫描多种徽章位置：抓边都锚对边，且弹出方向真的翻转时也不跳变', async () => {
  const save = composer.rect
  let flips = 0
  let cases = 0
  try {
    // 扫描徽章横向位置：横向空间关系变化会让 computePanelBox 在缩放后改选另一侧，
    // 这正是「位移是相对自动位置的增量」模型最容易出错的地方（基准 left 依赖宽度）。
    for (let right = 300; right <= 1160; right += 50) {
      composer.rect = { left: right - 200, top: 500, right, bottom: 600, width: 200, height: 100 }
      mountCustom()
      const before = styleOf(panelEl())
      const wasLeft = classOf(panelEl()).includes('tw-panel-left')
      await drag(zoneEl('e'), 400, 400, 460, 400) // 抓右缘向右 60
      const after = styleOf(panelEl())
      if (wasLeft !== classOf(panelEl()).includes('tw-panel-left')) flips += 1
      // 被抓的右缘最多长到视口右边距（8px）就停住（同 Windows：拖到屏幕边就不再长），
      // 而锚定的左缘在任何位置都不许被推动。
      const room = Math.max(0, global.window.innerWidth - 8 - (before.left + before.width))
      const grow = Math.min(60, room)
      assert.equal(after.left, before.left, `composer.right=${right}：锚定的左缘不应被推动`)
      assert.equal(after.width, before.width + grow, `composer.right=${right}：宽应 +${grow}（可用 ${room}）`)
      cases += 1
    }
  } finally {
    composer.rect = save
  }
  assert.ok(flips > 0, `扫描 ${cases} 个位置应至少覆盖一次弹出方向翻转，实际 ${flips}`)
  console.log(`      （扫描 ${cases} 个位置，其中 ${flips} 个在缩放后改选了另一侧，几何均未跳变）`)
})

console.log(`\n${passed} 项全部通过`)
