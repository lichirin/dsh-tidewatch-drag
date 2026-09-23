/**
 * 面板自适应弹出方向 / 尺寸夹紧的纯函数自检。
 * 运行：node test/panel-box.mjs
 *
 * computePanelBox 是面板定位的唯一真相：无论徽章被顶到视口顶端（长会话向下
 * 滚动后很常见）还是贴在左右边缘，面板都必须整体留在视口内。这里直接断言
 * 它的输入输出，不经过 DOM。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// computePanelBox 会读 window.innerWidth / innerHeight 作为缺省视口。
global.window = { innerWidth: 1200, innerHeight: 800, addEventListener() {}, removeEventListener() {} }
let captured = null
global.window.__ModuleLoader__ = { load: m => { captured = m } }
global.document = {
  querySelector: () => null,
  createElement: () => ({ setAttribute() {}, style: {}, textContent: '' }),
  head: { appendChild() {} },
  addEventListener() {},
  removeEventListener() {},
  body: {},
}
new Function('window', 'document', readFileSync('lib/client.js', 'utf8'))(globalThis.window, globalThis.document)
const client = captured.factory(name => (name === 'react' ? {} : (() => { throw new Error('unexpected require: ' + name) })()))
const { computePanelBox, clampPanelSize } = client.__test__
assert.equal(typeof computePanelBox, 'function', '未导出 computePanelBox')
assert.equal(typeof clampPanelSize, 'function', '未导出 clampPanelSize')

const VIEW = { viewportW: 1200, viewportH: 800 }
/** 徽章矩形：right/left 由入参决定，height 固定 24。 */
const chip = (left, top, width = 180) => ({ left, top, right: left + width, bottom: top + 24, width, height: 24 })
const box = (input) => computePanelBox({ ...VIEW, naturalWidth: 320, naturalHeight: 430, saved: {}, ...input })

let passed = 0
const check = (name, fn) => { fn(); passed += 1; console.log('  ok', name) }

console.log('面板自适应弹出方向')

check('徽章在中下部：默认向上弹出，整体不越出视口', () => {
  const b = box({ chip: chip(600, 340) })
  assert.equal(b.dirY, 'above')
  assert.equal(b.width, 320)
  assert.ok(b.top >= 8, `top=${b.top}`)
  assert.ok(b.top + b.maxHeight <= 800 - 8, `底边越界：${b.top + b.maxHeight}`)
  // 面板底边贴在徽章上方（间距 PANEL_ANCHOR_GAP = 10）
  assert.equal(b.top + b.maxHeight, 340 - 10)
})

check('徽章被顶到视口顶端（上方放不下）：自动翻到下方 —— 就是「跑到屏幕外」的根因', () => {
  const b = box({ chip: chip(600, 20) })
  assert.equal(b.dirY, 'below')
  assert.ok(b.top >= 8, `top=${b.top}`)
  assert.equal(b.top, 20 + 24 + 10, '面板顶边应贴在徽章下方')
  assert.ok(b.top + b.maxHeight <= 800 - 8, `底边越界：${b.top + b.maxHeight}`)
})

check('徽章贴底：仍向上弹出', () => {
  const b = box({ chip: chip(600, 760) })
  assert.equal(b.dirY, 'above')
  assert.ok(b.top >= 8)
  assert.ok(b.top + b.maxHeight <= 800 - 8)
})

check('极端小视口：面板仍完整落在视口内', () => {
  const b = computePanelBox({ viewportW: 360, viewportH: 300, chip: chip(150, 10, 150), naturalWidth: 320, naturalHeight: 430, saved: {} })
  assert.ok(b.left >= 8, `left=${b.left}`)
  assert.ok(b.left + b.width <= 360 - 8, `右边越界：${b.left + b.width}`)
  assert.ok(b.top >= 8, `top=${b.top}`)
  assert.ok(b.top + b.maxHeight <= 300 - 8, `底边越界：${b.top + b.maxHeight}`)
})

check('徽章贴右缘：面板翻到左侧，不越出右边界', () => {
  const b = box({ chip: chip(1180, 340, 20) })
  assert.equal(b.dirX, 'left')
  assert.ok(b.left >= 8, `left=${b.left}`)
  assert.ok(b.left + b.width <= 1200 - 8, `右边越界：${b.left + b.width}`)
})

check('徽章贴左缘：面板开在右侧且不越出右边界', () => {
  const b = box({ chip: chip(0, 340, 180) })
  assert.equal(b.dirX, 'right')
  assert.ok(b.left + b.width <= 1200 - 8, `右边越界：${b.left + b.width}`)
})

console.log('尺寸与位移')

check('未自定义高度：height 自适应（只给 maxHeight），且不超过可用空间', () => {
  const b = box({ chip: chip(600, 340) })
  assert.equal(b.height, undefined, '不应固定 height')
  assert.ok(b.maxHeight > 0 && b.maxHeight <= 782)
})

check('自定义高度：夹进可用空间（上方只够 182 时不给 430）', () => {
  const b = box({ chip: chip(600, 200), saved: { width: 320, height: 430, offsetX: 0, offsetY: 0 } })
  const spaceAbove = 200 - 10 - 8
  assert.ok(spaceAbove < 430, '前置条件：上方空间不足以容纳 430')
  assert.ok(b.maxHeight <= spaceAbove, `maxHeight=${b.maxHeight} 应 ≤ ${spaceAbove}`)
})

check('自定义宽度：放不下时压到可用宽度，仍不越界', () => {
  const b = box({ chip: chip(900, 340, 180), saved: { width: 900, height: 300, offsetX: 0, offsetY: 0 } })
  assert.ok(b.width <= 1200 - 8 - b.left, `width=${b.width} left=${b.left}`)
  assert.ok(b.width >= 240, `不应压到下限以下：${b.width}`)
})

check('用户位移：整体夹回视口内（甩到视口外也只贴边）', () => {
  const base = box({ chip: chip(600, 340) })
  const right = box({ chip: chip(600, 340), saved: { width: 320, height: 430, offsetX: 99999, offsetY: 0 } })
  const left = box({ chip: chip(600, 340), saved: { width: 320, height: 430, offsetX: -99999, offsetY: 0 } })
  assert.equal(right.left, 1200 - 8 - 320, `右下夹紧 left=${right.left}`)
  assert.equal(left.left, 8, `左下夹紧 left=${left.left}`)
  assert.ok(base.left > left.left && base.left < right.left, '基准位置应位于两侧夹紧值之间')
})

check('clampPanelSize：受上下限与视口双重约束', () => {
  const small = clampPanelSize(10, 10, 1200, 800)
  assert.deepEqual(small, { width: 240, height: 180 })
  const big = clampPanelSize(99999, 99999, 1200, 800)
  assert.equal(big.width, Math.min(900, 1200 - 16))
  assert.equal(big.height, Math.min(1200, 800 - 16))
})

console.log(`\n${passed} 项全部通过`)
