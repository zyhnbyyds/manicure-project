import { inBrowser, useData } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import { nextTick, onMounted, watch } from 'vue'
import './custom.css'

/** Mermaid 只在浏览器里初始化一次；SSR 阶段完全不加载它 */
let mermaidLoader: Promise<typeof import('mermaid').default> | null = null

function loadMermaid() {
  mermaidLoader ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      // Mermaid 默认 startOnLoad，但我们要按 SPA 路由手动触发，避免重复处理
      startOnLoad: false,
      // 技术文档里图是可信内容，但没必要放开到 loose
      securityLevel: 'strict',
      theme: 'neutral',
      fontFamily: 'inherit',
    })
    return mermaid
  })
  return mermaidLoader
}

/**
 * 把页面里尚未渲染的 `pre.mermaid` 交给 mermaid 换成 SVG。
 * VitePress 是 SPA，路由切换后新页面的图需要重新跑一次，所以挂在 watch 上。
 */
async function renderMermaid() {
  if (!inBrowser) return
  await nextTick()
  const pending = document.querySelectorAll('pre.mermaid:not([data-processed])')
  if (pending.length === 0) return
  const mermaid = await loadMermaid()
  // mermaid.run 会自行把 pre.mermaid 替换成 <svg>，并打上 data-processed
  await mermaid.run({ nodes: Array.from(pending) })
}

export default {
  extends: DefaultTheme,
  setup() {
    const { page } = useData()
    onMounted(renderMermaid)
    watch(() => page.value.relativePath, renderMermaid)
  },
}
