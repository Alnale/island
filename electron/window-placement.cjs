/** 多显示器窗口位置的纯计算逻辑；不依赖 Electron，便于回归测试。 */
const MIN_VISIBLE_PX = 32

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function intersectionArea(a, b) {
  const left = Math.max(a.x, b.x)
  const top = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  return Math.max(0, right - left) * Math.max(0, bottom - top)
}

function displayForPlacement(placement, displays, fallback) {
  if (!Array.isArray(displays) || displays.length === 0) return fallback
  const byId = displays.find((display) => String(display.id) === String(placement?.displayId))
  if (byId) return byId
  const oldArea = placement?.workArea
  if (oldArea && Number.isFinite(oldArea.x) && Number.isFinite(oldArea.y)) {
    return displays.reduce((best, display) =>
      intersectionArea(display.workArea, oldArea) > intersectionArea(best.workArea, oldArea) ? display : best,
    displays[0])
  }
  return fallback ?? displays[0]
}

function clampBounds(bounds, workArea, minVisible = MIN_VISIBLE_PX) {
  const width = Math.max(1, Math.min(Math.round(bounds.width), workArea.width))
  const height = Math.max(1, Math.min(Math.round(bounds.height), workArea.height))
  return {
    x: Math.round(clamp(bounds.x, workArea.x - width + minVisible, workArea.x + workArea.width - minVisible)),
    y: Math.round(clamp(bounds.y, workArea.y - height + minVisible, workArea.y + workArea.height - minVisible)),
    width,
    height,
  }
}

function restoreWindowBounds(placement, displays, fallbackBounds, fallbackDisplay) {
  const fallback = fallbackDisplay ?? displays?.[0]
  if (!placement || !fallback) return fallbackBounds
  const display = displayForPlacement(placement, displays, fallback)
  const area = display.workArea
  const width = Number.isFinite(placement.width) ? placement.width : fallbackBounds.width
  const height = Number.isFinite(placement.height) ? placement.height : fallbackBounds.height
  const xRoom = Math.max(0, area.width - width)
  const yRoom = Math.max(0, area.height - height)
  const normalizedX = Number.isFinite(placement.normalizedX) ? placement.normalizedX : 0.5
  const normalizedY = Number.isFinite(placement.normalizedY) ? placement.normalizedY : 0
  const x = area.x + clamp(normalizedX, 0, 1) * xRoom
  const y = area.y + clamp(normalizedY, 0, 1) * yRoom
  return clampBounds({ x, y, width, height }, area)
}

function placementFromBounds(bounds, displays, fallbackDisplay) {
  const display = (displays ?? []).reduce((best, item) =>
    !best || intersectionArea(item.workArea, bounds) > intersectionArea(best.workArea, bounds) ? item : best,
  fallbackDisplay)
  if (!display) return null
  const area = display.workArea
  return {
    version: 1,
    displayId: String(display.id),
    workArea: { x: area.x, y: area.y, width: area.width, height: area.height },
    normalizedX: clamp((bounds.x - area.x) / Math.max(1, area.width - bounds.width), 0, 1),
    normalizedY: clamp((bounds.y - area.y) / Math.max(1, area.height - bounds.height), 0, 1),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  }
}

module.exports = { MIN_VISIBLE_PX, clampBounds, displayForPlacement, placementFromBounds, restoreWindowBounds }
