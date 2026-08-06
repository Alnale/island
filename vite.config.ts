import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // mermaid 懒加载分包本体约 660KB(dynamic import,按需加载不阻塞
    // 首屏)——放宽体积告警阈值,避免每次构建误报
    chunkSizeWarningLimit: 800,
  },
})
