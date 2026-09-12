import { SetMetadata } from '@nestjs/common';

/** 元数据键：该路由允许「没有 app token 的访客」访问 */
export const APP_OPTIONAL_TOKEN = Symbol('appOptionalToken');

/**
 * **访客可访问**（免登录浏览）。
 *
 * ## 为什么需要
 *
 * 项目 / 美甲师 / 可约时段这类**纯浏览**数据，用户还没进过小程序就该能看到
 * （就像点开一家店的菜单不该先注册）。而 `AppAccessTokenGuard` 原来对**所有**
 * app 域路由一律要求 app token，于是静默登录失败（微信凭据没配、网络抖动、
 * 用户拒了授权）时，用户看到的是 `401 Unauthorized` —— 一个英文的、什么也没
 * 说明的弹窗，而不是「列表为空」。
 *
 * ## 语义（**注意「没有凭证」与「凭证不对」是两回事**）
 *
 * - **没带** `Authorization` → 当访客放行，`request.appUser` 保持 `undefined`；
 * - **带了**任何凭证 → 仍然按 app token 严格校验，验不过就 401。
 *
 * 后半条是安全红线（§8.3 双向拒绝）能继续成立的关键：否则后台 token 打 app 域
 * 会被静默降级成「访客」而不是被拒 —— 那就等于把守卫关掉了。
 * 所以这个装饰器**只能**挂在「谁看都一样」的只读端点上，
 * 任何依赖 `request.appUser` 的路由都不要挂。
 */
export const AppOptionalToken = (): MethodDecorator & ClassDecorator =>
  SetMetadata(APP_OPTIONAL_TOKEN, true);
