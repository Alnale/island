import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { rmSync } from 'node:fs'

// 桌面挂件专用构建:只打包 widget/widget.html 一个入口,
// base='./' 使产物可用 file:// 直接加载(资源相对路径)。
// 挂件本地播放列表不含内置测试曲目(mode=widget 时 tracks.ts 返回空),
// 构建后删除 public/music 的拷贝,避免产物携带无用音频
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'widget-clean-music',
      closeBundle() {
        rmSync(fileURLToPath(new URL('./dist-widget/music', import.meta.url)), {
          recursive: true,
          force: true,
        })
      },
    },
  ],
  base: './',
  build: {
    outDir: 'dist-widget',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        widget: fileURLToPath(new URL('./widget/widget.html', import.meta.url)),
      },
    },
  },
})
