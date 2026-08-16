<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'
import { Calendar, Document, Moon, Present, Setting, Sunny } from '@element-plus/icons-vue'
import { useSessionStore } from '@/stores/session'

const route = useRoute()
const sessionStore = useSessionStore()
const dark = ref(document.documentElement.classList.contains('dark'))
const isAdminArea = computed(() => route.path.startsWith('/admin/'))

const initials = computed(() => {
  const value = sessionStore.user?.username || sessionStore.user?.email || 'U'
  return value.slice(0, 1).toUpperCase()
})

function toggleTheme(): void {
  dark.value = !dark.value
  document.documentElement.classList.toggle('dark', dark.value)
}
</script>

<template>
  <div class="app-shell" :class="{ 'app-shell--user': !isAdminArea }">
    <header class="topbar">
      <RouterLink class="brand" :to="isAdminArea ? '/admin/lotteries' : '/'" :aria-label="isAdminArea ? '运营中心' : '活动中心'">
        <span class="brand__mark"><Present /></span>
        <div>
          <strong>{{ isAdminArea ? '运营中心' : '活动中心' }}</strong>
          <span v-if="isAdminArea">Sub2API 扩展</span>
        </div>
      </RouterLink>

      <nav class="primary-nav" aria-label="主导航">
        <template v-if="isAdminArea">
          <RouterLink
            to="/admin/lotteries"
            :class="{ active: route.path.startsWith('/admin/lotteries') }"
          >
            <Present />
            抽奖管理
          </RouterLink>
          <RouterLink
            to="/admin/checkins"
            :class="{ active: route.path.startsWith('/admin/checkins') }"
          >
            <Calendar />
            签到管理
          </RouterLink>
          <RouterLink
            to="/admin/group-grants"
            :class="{ active: route.path.startsWith('/admin/group-grants') }"
          >
            <Setting />
            分组资格
          </RouterLink>
          <RouterLink
            to="/admin/request-logs"
            :class="{ active: route.path.startsWith('/admin/request-logs') }"
          >
            <Document />
            调用日志
          </RouterLink>
        </template>
      </nav>

      <div class="topbar__account">
        <button
          v-if="!isAdminArea"
          class="icon-button"
          type="button"
          title="切换主题"
          aria-label="切换主题"
          @click="toggleTheme"
        >
          <Sunny v-if="dark" />
          <Moon v-else />
        </button>
        <div class="user-chip" :class="{ 'user-chip--compact': !isAdminArea }" :title="sessionStore.user?.email">
          <span>{{ initials }}</span>
          <div>
            <strong>{{ sessionStore.user?.username || sessionStore.user?.email }}</strong>
            <small>{{ sessionStore.isAdmin ? '管理员' : '用户' }}</small>
          </div>
        </div>
      </div>
    </header>

    <main class="app-content">
      <RouterView />
    </main>
  </div>
</template>
