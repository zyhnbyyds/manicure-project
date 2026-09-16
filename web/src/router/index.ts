import { createRouter, createWebHistory } from 'vue-router';
import { setupGuard } from './guard';

/** 静态基础路由（登录页、布局外壳、错误页） */
export const constantRoutes = [
  {
    path: '/login',
    name: 'login',
    component: () => import('../views/login/index.vue'),
    meta: { title: '登录' },
  },
  {
    path: '/',
    name: 'layout',
    component: () => import('../layouts/default.vue'),
    redirect: '/dashboard',
    children: [
      {
        path: 'dashboard',
        name: 'dashboard',
        component: () => import('../views/dashboard/index.vue'),
        meta: { title: '首页', icon: 'home' },
      },
      {
        path: 'profile',
        name: 'profile',
        component: () => import('../views/profile/index.vue'),
        meta: { title: '个人中心', icon: 'user' },
      },
    ],
  },
  {
    path: '/403',
    name: 'forbidden',
    component: () => import('../views/error/403.vue'),
    meta: { title: '无权限' },
  },
  {
    // 大屏展示：**独立的顶层路由**，不挂在 `layout` 下 ——
    // 挂在下面就会带出侧边栏 / 顶栏 / 标签页，而这块屏要的就是干净的全屏。
    // 因此它也不走菜单驱动的动态路由（那条链路只会往 `layout` 里塞子路由），
    // 与 `/login`、`/403` 一样属于「基座页面」：登录态由路由守卫统一把守。
    path: '/screen',
    name: 'screen',
    component: () => import('../views/screen/index.vue'),
    meta: { title: '大屏展示' },
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('../views/error/404.vue'),
    meta: { title: '页面不存在' },
  },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: constantRoutes,
});

setupGuard(router);

export default router;
