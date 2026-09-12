import type MarkdownIt from 'markdown-it'

/**
 * 把 ```mermaid 代码块渲染成 `<pre class="mermaid">源码</pre>`。
 *
 * 为什么不用 `vitepress-plugin-mermaid`：它把代码块变成异步 Vue 组件
 * （`<Suspense><Mermaid graph="...">`），SSR 阶段 mermaid 在没有 DOM 的 Node 环境里渲染失败，
 * VitePress 2 的 `transformHtml` 又会把失败静默吞掉 —— 结果是构建出来的 HTML 里只剩一个
 * **空的** `<div class="mermaid"></div>`，图的源码也一起丢了，浏览器端再没有任何东西可渲染。
 * （旧版 VitePress 会因此直接构建失败，所以这个问题只在 2.x 上表现为"构建成功但图全没了"。）
 *
 * 现在改成留一个带源码的 `<pre class="mermaid">`：
 * - 构建期：不做任何处理，只是一段被 CSS 隐藏的文本（`docs/.vitepress/theme/custom.css`）；
 * - 浏览器端：`theme/index.ts` 挂载后调 `mermaid.run()` 把它替换成 SVG。
 *
 * 这样图的源码在 HTML 里是**可见可搜索**的（对技术文档反而是优点），渲染时机也完全在客户端。
 */
export function mermaidMarkdown(md: MarkdownIt): void {
  const defaultFence = md.renderer.rules.fence!.bind(md.renderer.rules)

  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    const info = token.info.trim()

    if (info === 'mermaid' || info === 'mmd') {
      return `<pre class="mermaid">${md.utils.escapeHtml(token.content)}</pre>\n`
    }

    return defaultFence(tokens, idx, options, env, self)
  }
}
