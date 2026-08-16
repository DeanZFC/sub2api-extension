import { createRouter, createWebHistory } from 'vue-router'
import { useSessionStore } from '@/stores/session'
import { resolveAccessRedirect } from './access'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'home',
      component: () => import('@/views/UserHomeView.vue'),
      meta: { title: '抽奖活动' }
    },
    { path: '/activities', redirect: '/' },
    {
      path: '/activities/:type/:id',
      name: 'activity-detail',
      component: () => import('@/views/UserActivityView.vue'),
      meta: { title: '活动详情' }
    },
    {
      path: '/admin/group-grants',
      name: 'group-grants',
      component: () => import('@/views/admin/GroupGrantsView.vue'),
      meta: { title: '分组授权', requiresAdmin: true }
    },
    { path: '/admin/activity-groups', redirect: '/admin/group-grants' },
    {
      path: '/admin/checkins',
      name: 'checkins',
      component: () => import('@/views/admin/CheckinsView.vue'),
      meta: { title: '签到管理', requiresAdmin: true }
    },
    {
      path: '/admin/lotteries',
      name: 'lotteries',
      component: () => import('@/views/admin/LotteriesView.vue'),
      meta: { title: '抽奖管理', requiresAdmin: true }
    },
    {
      path: '/admin/request-logs',
      name: 'request-logs',
      component: () => import('@/views/admin/RequestLogsView.vue'),
      meta: { title: '调用日志', requiresAdmin: true }
    },
    {
      path: '/admin/lotteries/:id',
      name: 'lottery-detail',
      component: () => import('@/views/admin/LotteryDetailView.vue'),
      meta: { title: '抽奖详情', requiresAdmin: true }
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('@/views/NotFoundView.vue'),
      meta: { title: '页面不存在' }
    }
  ],
  scrollBehavior: () => ({ top: 0 })
})

router.beforeEach(async (to) => {
  const session = useSessionStore()
  await session.load()
  document.title = `${String(to.meta.title || '运营中心')} - Sub2API 扩展`
  const redirect = resolveAccessRedirect(to.name, Boolean(to.meta.requiresAdmin), session.isAdmin)
  if (redirect) return { name: redirect }
  return true
})

export default router
