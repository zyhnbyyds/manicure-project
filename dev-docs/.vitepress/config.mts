import { defineConfig } from 'vitepress';
import { mermaidMarkdown } from './mermaid';

/**
 * 可选的部署子路径，例如 DOCS_BASE=/manicure/dev-docs/ bun run build
 * 本地开发与默认构建都用根路径。
 */
const base = process.env.DOCS_BASE ?? '/';

export default defineConfig({
  base,
  lang: 'zh-CN',
  title: '美甲预约系统 · 开发者文档',
  description:
    '美甲门店到店预约与经营管理系统（后端 / 后台前端 / 微信小程序）的技术实现文档：架构、数据模型、预约主链路、支付与退款、报表口径、测试与部署。',
  srcExclude: ['README.md', 'node_modules/**'],
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: false,
  markdown: {
    lineNumbers: true,
    theme: { light: 'github-light', dark: 'github-dark' },
    config: mermaidMarkdown,
  },
  head: [['meta', { name: 'theme-color', content: '#b45f6b' }]],
  themeConfig: {
    siteTitle: '美甲预约系统 · 开发者文档',
    outline: { level: [2, 3], label: '本页目录' },
    docFooter: { prev: '上一篇', next: '下一篇' },
    darkModeSwitchLabel: '主题',
    lightModeSwitchTitle: '切换到浅色',
    darkModeSwitchTitle: '切换到深色',
    sidebarMenuLabel: '目录',
    returnToTopLabel: '回到顶部',
    // ⚠️ VitePress 2 改了 API：1.x 的扁平选项 `lastUpdatedText` 已被废弃，
    //    改成对象形式 `lastUpdated: { text, formatOptions }`。
    //    **旧写法不报错、静默忽略** —— 症状是页脚永远显示英文 "Last updated"。
    lastUpdated: {
      text: '最后更新',
      // 不加 forceLocale 时时间跟随**浏览器** locale，中文站也会显示 "Sep 14, 2026"
      formatOptions: {
        dateStyle: 'medium',
        timeStyle: 'short',
        forceLocale: true,
      },
    },
    search: {
      provider: 'local',
      options: {
        /**
         * 关掉 MiniSearch 的自动 vacuum。
         * VitePress dev 模式在文件频繁变动（尤其批量写文档）时会触发 minisearch 7.2 的
         * `performVacuuming` 崩溃（`Cannot read properties of undefined (reading 'keys')`），
         * 进程直接退出。vacuum 只回收被删除词条，不影响搜索正确性。
         */
        miniSearch: { options: { autoVacuum: false } },
        translations: {
          button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
          modal: {
            noResultsText: '没有找到相关结果',
            resetButtonTitle: '清空条件',
            footer: {
              selectText: '选择',
              navigateText: '切换',
              closeText: '关闭',
            },
          },
        },
      },
    },
    nav: [
      { text: '首页', link: '/' },
      { text: '总览', link: '/overview/', activeMatch: '^/overview/' },
      { text: '后端', link: '/backend/', activeMatch: '^/backend/' },
      { text: '前端', link: '/frontend/', activeMatch: '^/frontend/' },
      { text: '数据', link: '/data/', activeMatch: '^/data/' },
      { text: '质量与交付', link: '/quality/', activeMatch: '^/quality/' },
      { text: '附录', link: '/appendix/', activeMatch: '^/appendix/' },
      {
        text: '相关文档',
        items: [
          { text: '对客操作手册（docs/）', link: '/appendix/related-docs' },
          {
            text: '设计资料库（project-design/）',
            link: '/appendix/related-docs#project-design',
          },
        ],
      },
    ],
    sidebar: {
      '/overview/': [
        {
          text: '总览',
          items: [
            { text: '项目总览与技术基线', link: '/overview/' },
            { text: '整体架构图', link: '/overview/architecture-map' },
            { text: '三端架构与请求生命周期', link: '/overview/architecture' },
            { text: '目录结构与代码地图', link: '/overview/structure' },
            { text: '本地开发与命令手册', link: '/overview/getting-started' },
            { text: '配置与环境变量', link: '/overview/config' },
          ],
        },
      ],
      '/backend/': [
        {
          text: '后端实现',
          items: [
            { text: '后端分层与请求链路', link: '/backend/' },
            { text: '鉴权 · RBAC · 数据权限', link: '/backend/auth-rbac' },
            { text: '预约主链路实现', link: '/backend/booking' },
            { text: '排班与可约时段算法', link: '/backend/scheduling' },
            { text: '收银与支付通道接入', link: '/backend/payment' },
            { text: '退款判责与对账', link: '/backend/refund-reconcile' },
            { text: '会员 · 储值 · 次卡 · 积分', link: '/backend/membership' },
            { text: '挂账与应收', link: '/backend/credit' },
            { text: '报表与提成核算', link: '/backend/reports' },
            { text: '通知与定时任务', link: '/backend/notification-jobs' },
            { text: '小程序 app 域实现', link: '/backend/app-domain' },
            { text: 'AI 操作助手', link: '/backend/ai-agent' },
          ],
        },
      ],
      '/frontend/': [
        {
          text: '前端实现',
          items: [
            { text: '后台前端（Vue 3）', link: '/frontend/' },
            { text: '后台页面与权限点清单', link: '/frontend/pages' },
            { text: '小程序架构与主题系统', link: '/frontend/miniapp' },
            { text: '小程序页面与接口映射', link: '/frontend/miniapp-pages' },
          ],
        },
      ],
      '/data/': [
        {
          text: '数据模型',
          items: [
            { text: '数据模型总览', link: '/data/' },
            { text: '业务表详解', link: '/data/business-tables' },
            {
              text: '系统 · 监控 · AI · 小程序身份表',
              link: '/data/system-tables',
            },
            {
              text: '迁移 · 种子数据 · 派生口径',
              link: '/data/migrations-seeds',
            },
          ],
        },
      ],
      '/quality/': [
        {
          text: '质量与交付',
          items: [
            { text: '测试策略与验收标准', link: '/quality/' },
            { text: '构建 · 部署 · 运维', link: '/quality/deploy' },
            { text: 'Docker 一键部署', link: '/quality/docker' },
            { text: '踩坑记录与排查手册', link: '/quality/pitfalls' },
          ],
        },
      ],
      '/appendix/': [
        {
          text: '附录',
          items: [
            { text: '接口契约索引', link: '/appendix/api' },
            { text: '权限点与菜单清单', link: '/appendix/permissions' },
            { text: '相关文档与资料库', link: '/appendix/related-docs' },
          ],
        },
      ],
    },
    footer: {
      message: '内部技术文档 · 面向开发者',
      copyright: 'manicure-project',
    },
  },
});
