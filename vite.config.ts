import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // mermaid 懒加载分包本体约 660KB(dynamic import,按需加载不阻塞
    // 首屏)——放宽体积告警阈值,避免每次构建误报
    chunkSizeWarningLimit: 800,
    // 构建目标(Chrome 130+,与Electron 43匹配)
    target: 'chrome130',
    // 生产环境关闭sourcemap(减小体积)
    sourcemap: false,
    // 启用esbuild压缩(更快更小)
    minify: 'esbuild',
    // CSS代码分割
    cssCodeSplit: true,
    // 模块预构建优化
    modulePreload: {
      polyfill: false, // Electron不需要polyfill
    },
    rollupOptions: {
      output: {
        // 手动分包策略(优化首屏加载和缓存)
        manualChunks(id) {
          // React核心单独打包(不常变动,缓存友好)
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/')) {
            return 'react-vendor'
          }
          // Markdown渲染(Agent视图使用)
          if (id.includes('node_modules/react-markdown') || 
              id.includes('node_modules/remark-gfm') || 
              id.includes('node_modules/rehype-highlight') || 
              id.includes('node_modules/rehype-raw')) {
            return 'markdown'
          }
          // Mermaid图表(大体积,懒加载但单独分包)
          if (id.includes('node_modules/mermaid')) {
            return 'mermaid'
          }
        },
      },
    },
  },
  // 依赖预构建优化
  optimizeDeps: {
    include: ['react', 'react-dom'],
  },
  // 开发服务器优化
  server: {
    // 预构建
    warmup: {
      clientFiles: ['./src/main.tsx', './src/App.tsx'],
    },
  },
})
