import { defineConfig } from 'vitepress'

/**
 * 对客操作手册站点。
 * 可选的部署子路径，例如 DOCS_BASE=/manicure/docs/ bun run build
 */
const base = process.env.DOCS_BASE ?? '/'

export default defineConfig({
  base,
  lang: 'zh-CN',
  title: '美甲门店系统 · 操作手册',
  description:
    '美甲门店到店预约与管理系统的使用手册：预约排班、顾客与会员、收银与支付、挂账应收、报表与提成，以及每个模块的使用注意事项。',
  srcExclude: ['README.md', 'node_modules/**'],
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: false,
  markdown: {
    lineNumbers: false,
  },
  head: [
    ['meta', { name: 'theme-color', content: '#b45f6b' }],
    ['meta', { name: 'author', content: 'manicure-project' }],
  ],
  themeConfig: {
    siteTitle: '美甲门店系统 · 操作手册',
    outline: { level: [2, 3], label: '本页目录' },
    docFooter: { prev: '上一篇', next: '下一篇' },
    darkModeSwitchLabel: '主题',
    sidebarMenuLabel: '目录',
    returnToTopLabel: '回到顶部',
    lastUpdatedText: '最后更新',
    search: {
      provider: 'local',
      options: {
        /**
         * 关掉 MiniSearch 的自动 vacuum。
         * VitePress dev 模式在文件频繁变动（尤其批量写文档）时会触发 minisearch 7.2 的
         * `performVacuuming` 崩溃（`Cannot read properties of undefined (reading 'keys')`），
         * 进程直接退出。vacuum 只回收被删除词条，不影响搜索正确性。
         */
        miniSearch: {
          options: { autoVacuum: false },
        },
        translations: {
          button: { buttonText: '搜索手册', buttonAriaLabel: '搜索手册' },
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
      { text: '手册首页', link: '/' },
      { text: '快速上手', link: '/guide/', activeMatch: '^/guide/' },
      { text: '预约与排班', link: '/booking/', activeMatch: '^/booking/' },
      { text: '顾客与会员', link: '/member/', activeMatch: '^/member/' },
      { text: '收银与支付', link: '/payment/', activeMatch: '^/payment/' },
      { text: '报表与运营', link: '/report/', activeMatch: '^/report/' },
      { text: '后台管理', link: '/admin/', activeMatch: '^/admin/' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: '开始使用',
          items: [
            { text: '手册总览与整体逻辑', link: '/guide/' },
            { text: '快速上手（开业配置清单）', link: '/guide/quickstart' },
            { text: '角色与权限', link: '/guide/roles' },
            { text: '术语表', link: '/guide/glossary' },
            { text: '常见问题 FAQ', link: '/guide/faq' },
          ],
        },
      ],
      '/booking/': [
        {
          text: '预约与排班',
          items: [
            { text: '预约模块总览', link: '/booking/' },
            { text: '排班管理', link: '/booking/scheduling' },
            { text: '开单 · 改期 · 取消 · 结算', link: '/booking/booking-flow' },
            { text: '周期预约', link: '/booking/recurrences' },
            { text: '美甲师工作台', link: '/booking/staff-workbench' },
          ],
        },
      ],
      '/member/': [
        {
          text: '顾客与会员',
          items: [
            { text: '会员模块总览', link: '/member/' },
            { text: '顾客档案', link: '/member/customers' },
            { text: '会员等级与折扣', link: '/member/levels' },
            { text: '储值充值 · 赠送余额 · 次卡', link: '/member/recharge-cards' },
            { text: '积分与优惠券', link: '/member/points-coupons' },
            { text: '评价管理', link: '/member/reviews' },
          ],
        },
      ],
      '/payment/': [
        {
          text: '收银与支付',
          items: [
            { text: '收银台总览', link: '/payment/' },
            { text: '收银台操作', link: '/payment/cashier' },
            { text: '支付通道开通（重点）', link: '/payment/channels-setup' },
            { text: '退款处理', link: '/payment/refunds' },
            { text: '渠道对账', link: '/payment/reconcile' },
            { text: '挂账与应收', link: '/payment/credit' },
          ],
        },
      ],
      '/report/': [
        {
          text: '报表与运营',
          items: [
            { text: '报表与经营分析总览', link: '/report/' },
            { text: '报表指标口径', link: '/report/reports' },
            { text: '提成核算', link: '/report/commission' },
            { text: '通知与短信', link: '/report/notices' },
          ],
        },
      ],
      '/admin/': [
        {
          text: '后台管理',
          items: [
            { text: '后台管理端总览', link: '/admin/' },
            { text: '用户与角色', link: '/admin/users-roles' },
            { text: '菜单 · 部门 · 岗位 · 字典 · 参数', link: '/admin/menus-depts' },
            { text: '系统监控与审计', link: '/admin/monitor' },
            { text: '定时任务与文件管理', link: '/admin/jobs-files' },
            { text: 'AI 操作助手', link: '/admin/ai-assistant' },
          ],
        },
      ],
    },
    footer: {
      message: '门店操作手册 · 面向使用者',
      copyright: 'manicure-project',
    },
  },
})
