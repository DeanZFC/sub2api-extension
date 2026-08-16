<script setup lang="ts">
import { Back } from '@element-plus/icons-vue'
</script>

<template>
  <section class="not-found">
    <strong>404</strong>
    <h1>页面不存在</h1>
    <p>当前地址没有对应的扩展页面。</p>
    <RouterLink class="button button--primary" to="/"><Back />返回首页</RouterLink>
  </section>
</template>
