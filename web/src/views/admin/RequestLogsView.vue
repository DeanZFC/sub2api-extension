<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ArrowLeft, ArrowRight, Refresh, Search } from '@element-plus/icons-vue'
import { errorMessage } from '@/api/client'
import { getRequestLogs, type RequestLogFilters } from '@/api/requestLogs'
import EmptyState from '@/components/EmptyState.vue'
import ErrorState from '@/components/ErrorState.vue'
import PageHeader from '@/components/PageHeader.vue'
import { formatActivityDate } from '@/domain/time'
import type { RequestLog } from '@/types/domain'

const logs = ref<RequestLog[]>([])
const loading = ref(true)
const error = ref('')
const total = ref(0)
const page = ref(1)
const pages = ref(1)
const pageSize = 50
const filters = reactive({ path: '', ip: '', user_id: '', outcome: 'all' as 'all' | 'blocked' | 'error' | 'rate_limited' })

async function load(targetPage = page.value): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const query: RequestLogFilters = {
      page: targetPage,
      page_size: pageSize,
      outcome: filters.outcome
    }
    if (filters.path.trim()) query.path = filters.path.trim()
    if (filters.ip.trim()) query.ip = filters.ip.trim()
    if (filters.user_id) query.user_id = Number(filters.user_id)
    const result = await getRequestLogs(query)
    logs.value = result.items
    total.value = result.total
    page.value = result.page
    pages.value = result.pages
  } catch (cause) {
    error.value = errorMessage(cause)
  } finally {
    loading.value = false
  }
}

function submit(): void {
  void load(1)
}

function formatDate(value: string): string {
  return formatActivityDate(value, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  })
}

function statusTone(status: number): string {
  if (status === 429 || status >= 500) return 'danger'
  if (status >= 400) return 'warning'
  if (status >= 300) return 'accent'
  return 'success'
}

function roleLabel(role: string): string {
  if (role === 'admin') return '管理员'
  if (role === 'user') return '用户'
  return '未登录'
}

onMounted(() => load())
</script>

<template>
  <div class="page request-log-page">
    <PageHeader title="调用日志" description="查询接口访问、权限拒绝、限流和服务端错误记录。" />

    <form class="toolbar log-toolbar" @submit.prevent="submit">
      <label class="search-control">
        <Search />
        <input v-model="filters.path" type="search" placeholder="接口路径" aria-label="按接口路径筛选" />
      </label>
      <input v-model="filters.ip" class="control toolbar-control" placeholder="IP 地址" aria-label="按 IP 地址筛选" />
      <input v-model="filters.user_id" class="control toolbar-control toolbar-control--user" type="number" min="1" placeholder="用户 ID" aria-label="按用户 ID 筛选" />
      <select v-model="filters.outcome" class="control toolbar__select" aria-label="按调用结果筛选" @change="submit">
        <option value="all">全部结果</option>
        <option value="blocked">权限拒绝/限流</option>
        <option value="rate_limited">仅限流</option>
        <option value="error">全部异常</option>
      </select>
      <button class="icon-button" type="submit" title="查询日志" aria-label="查询日志"><Search /></button>
      <button class="icon-button" type="button" title="刷新日志" aria-label="刷新日志" @click="load(1)"><Refresh /></button>
      <span class="toolbar__count">共 {{ total }} 条</span>
    </form>

    <div v-if="loading" class="skeleton-list"><div v-for="index in 8" :key="index" class="skeleton-row" /></div>
    <ErrorState v-else-if="error" :message="error" @retry="load()" />
    <EmptyState v-else-if="logs.length === 0" title="没有匹配的调用日志" description="调整筛选条件后重新查询。" />

    <template v-else>
      <div class="data-table-wrap">
        <table class="data-table request-log-table">
          <thead><tr><th>时间</th><th>来源</th><th>接口</th><th>结果</th><th>次数/耗时</th><th>User-Agent</th></tr></thead>
          <tbody>
            <tr v-for="item in logs" :key="item.id">
              <td><strong>{{ formatDate(item.created_at) }}</strong><small :title="item.request_id">{{ item.request_id }}</small></td>
              <td><strong>{{ item.ip_address }}</strong><small>{{ roleLabel(item.role) }}{{ item.user_id ? ` #${item.user_id}` : '' }}</small></td>
              <td class="path-cell"><strong><code>{{ item.method }}</code> {{ item.path }}</strong><small>{{ item.route_pattern || '未匹配路由' }}</small></td>
              <td><span class="status-badge" :class="`status-badge--${statusTone(item.status_code)}`">{{ item.status_code }}</span><small>{{ item.result_code || 'OK' }}</small></td>
              <td><strong>{{ item.request_count > 1 ? `${item.request_count} 次` : `${item.duration_ms} ms` }}</strong><small v-if="item.request_count > 1">最长 {{ item.duration_ms }} ms</small><small v-else>{{ item.rate_limit_scope || '正常调用' }}</small></td>
              <td class="agent-cell" :title="item.user_agent">{{ item.user_agent || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="log-pagination">
        <span>第 {{ page }} / {{ pages }} 页</span>
        <button class="icon-button" type="button" title="上一页" :disabled="page <= 1 || loading" @click="load(page - 1)"><ArrowLeft /></button>
        <button class="icon-button" type="button" title="下一页" :disabled="page >= pages || loading" @click="load(page + 1)"><ArrowRight /></button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.request-log-page { width: min(1380px, 100%); }
.log-toolbar { flex-wrap: wrap; }
.toolbar-control { width: 150px; min-height: 34px; }
.toolbar-control--user { width: 120px; }
.request-log-table { min-width: 1120px; }
.request-log-table code { color: var(--accent); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
.path-cell { max-width: 360px; }
.path-cell strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-cell { overflow: hidden; max-width: 220px; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); font-size: 12px; }
.log-pagination { display: flex; align-items: center; justify-content: flex-end; gap: 4px; padding: 12px 0; color: var(--text-muted); font-size: 12px; }
.log-pagination span { margin-right: 8px; }
@media (max-width: 720px) {
  .toolbar-control, .toolbar-control--user { width: calc(50% - 4px); }
}
</style>
