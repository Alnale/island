/**
 * 图片工具 —— 岛体背景相关:自然尺寸测量 / 亮度采样。
 * (2026-08-07 从 DynamicIsland 抽出,审计 P0:三处「new Image → onload
 * → canvas」逐字重复收敛;失败一律返回 null 不抛,调用方各自兜底)
 */

/** 加载图片并取自然尺寸;解码失败返回 null(不抛) */
export function loadImageNaturalSize(src: string): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
    img.onerror = () => resolve(null)
    img.src = src
  })
}

/**
 * 采样图片平均亮度:32×32 缩放后取**不透明像素**(alpha > 125)的
 * 加权平均亮度(Rec.601);canvas 不可用 / 解码失败 / 无不透明像素
 * 返回 null。用途:字体颜色 auto 模式——白底图亮度高 → 黑字,
 * 暗色图 → 白字
 */
export function sampleImageBrightness(src: string): Promise<number | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = 32
        canvas.height = 32
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) {
          resolve(null)
          return
        }
        ctx.drawImage(img, 0, 0, 32, 32)
        const { data } = ctx.getImageData(0, 0, 32, 32)
        let sum = 0
        let count = 0
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] > 125) {
            sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
            count++
          }
        }
        resolve(count > 0 ? sum / count : null)
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = src
  })
}
