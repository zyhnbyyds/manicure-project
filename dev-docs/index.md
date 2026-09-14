---
layout: home

hero:
  name: 美甲预约系统
  text: 开发者文档
  tagline: 后端 NestJS + Fastify + Drizzle/MySQL · 后台 Vue 3 + Vite · 微信小程序原生 TS —— 三端一体的到店预约与经营管理系统技术实现文档
  actions:
    - theme: brand
      text: 从总览开始
      link: /overview/
    - theme: alt
      text: 本地开发与命令
      link: /overview/getting-started
    - theme: alt
      text: 数据模型
      link: /data/

features:
  - icon: 🧭
    title: 总览与架构
    details: 技术基线、三端职责边界、请求生命周期、目录结构与代码地图，先看这里再动手。
    link: /overview/
    linkText: 进入总览
  - icon: 🗄️
    title: 数据模型
    details: 61 张表的分组清单、命名与索引约定、软删与物理删豁免、迁移与种子数据流程。
    link: /data/
    linkText: 查看数据模型
  - icon: 📅
    title: 预约主链路
    details: 可约时段算法（班次 − 预约 − 缓冲）、FOR UPDATE 冲突检测、服务与资金状态机、九步结算流程。
    link: /backend/booking
    linkText: 阅读实现
  - icon: 💳
    title: 支付与退款
    details: 微信 Native / 支付宝当面付接入、回调验签与幂等、主动查单关单、退款判责与渠道对账。
    link: /backend/payment
    linkText: 阅读实现
  - icon: 🔐
    title: 鉴权与权限
    details: 双 JWT 域（后台 / 小程序 app 域）、RBAC 菜单与按钮权限点、数据权限与审计留痕。
    link: /backend/auth-rbac
    linkText: 阅读实现
  - icon: ✅
    title: 测试与交付
    details: 真实 MySQL 集成测试、并发与幂等用例写法、B1~B6 验收清单、PM2 部署与上线门禁。
    link: /quality/
    linkText: 查看质量体系
---

## 这份文档是什么

面向**开发者与二次开发者**的技术文档库：解释系统**怎么实现的、为什么这么实现、改动时要注意什么**。

它与另外两份文档分层，不要混用：

| 文档             | 位置              | 面向                   | 内容                                         |
| ---------------- | ----------------- | ---------------------- | -------------------------------------------- |
| **对客操作手册** | `docs/`           | 门店店长 / 店员 / 运营 | 每个模块怎么用、注意事项、支付开通与配合流程 |
| **本开发者文档** | `dev-docs/`       | 开发 / 测试 / 运维     | 架构、表结构、状态机、接口契约、测试与部署   |
| **设计资料库**   | `project-design/` | 产品 / 设计 / 交接     | 原始需求 spec、施工计划、UI 设计稿、踩坑记录 |

## 怎么用最快

1. 先读 [项目总览与技术基线](/overview/)，确认技术栈与代码铁律；
2. 再读 [目录结构与代码地图](/overview/structure)，找到你要改的模块；
3. 到 [本地开发与命令手册](/overview/getting-started) 把环境跑起来；
4. 动具体模块前，读对应章节（预约 → [预约主链路](/backend/booking)，钱 → [收银与支付](/backend/payment)）；
5. 提交前对照 [测试策略与验收标准](/quality/) 自检。

::: warning 改钱之前先看这个
凡是涉及**金额、余额、积分、次卡、应收、退款**的写入，必须先读
[收银与支付](/backend/payment) 与 [会员 · 储值 · 次卡 · 积分](/backend/membership)，
确认「条件更新模板」和「全局锁顺序」，不要自创写法。
:::
