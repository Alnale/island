const assert = require('node:assert/strict')
const { clampBounds, placementFromBounds, restoreWindowBounds } = require('../electron/window-placement.cjs')

const primary = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }
const secondary = { id: 2, workArea: { x: 1920, y: 0, width: 2560, height: 1440 } }
const fallback = { x: 700, y: 6, width: 520, height: 280 }

const saved = placementFromBounds({ x: 2500, y: 300, width: 520, height: 280 }, [primary, secondary], primary)
assert.equal(saved.displayId, '2')
const restored = restoreWindowBounds(saved, [primary, secondary], fallback, primary)
assert(restored.x >= secondary.workArea.x && restored.x < secondary.workArea.x + secondary.workArea.width)

const removed = restoreWindowBounds(saved, [primary], fallback, primary)
assert(removed.x >= 0 && removed.x < primary.workArea.width)
assert(removed.y >= 0 && removed.y < primary.workArea.height)

const clamped = clampBounds({ x: -5000, y: 9000, width: 520, height: 280 }, primary.workArea)
assert(clamped.x >= -488 && clamped.x <= 1888)
assert(clamped.y >= -248 && clamped.y <= 1008)
console.log('window placement tests: all passed')
