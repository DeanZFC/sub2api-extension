import assert from 'node:assert/strict';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { assertRuntimeConfig, loadConfig } from '../src/config.js';
import { createApplication } from '../src/app.js';
import { getRechargeSummary } from '../src/sync.js';

const projectEnv = resolve(fileURLToPath(new URL('../../.env', import.meta.url)));
try {
  loadEnvFile(projectEnv);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const config = loadConfig();
assertRuntimeConfig(config);
assert.ok(config.databaseUrl, '真实环境验证必须设置 DATABASE_URL');

const application = createApplication(config);
try {
  const groupResult = await application.services.syncService.refreshGroups();
  const usersPage = await application.services.client.listUsers(1, 100);
  const users = Array.isArray(usersPage?.items) ? usersPage.items : Array.isArray(usersPage) ? usersPage : [];
  const configuredUserId = Number(process.env.VERIFY_USER_ID || 0);
  const selectedUser = configuredUserId > 0
    ? users.find((item) => Number(item.id) === configuredUserId)
    : users.find((item) => item.status === 'active' && item.role === 'user') || users.find((item) => item.status === 'active') || users[0];
  assert.ok(selectedUser, 'Sub2API 中没有可用于验证的用户');
  const userId = Number(selectedUser.id);
  const user = await application.services.syncService.refreshUser(userId, {
    withRechargeHistory: true,
    rechargeWindowDays: [7, 30]
  });
  const summary = getRechargeSummary(application.services.db, userId, { windowDays: [7, 30] });
  assert.equal(Number(user.user_id), userId);
  console.log(JSON.stringify({
    postgres: true,
    sub2api_api: true,
    user_id: userId,
    groups_updated: Number(groupResult.groups_updated || 0),
    recharge_events: Number(summary.recharge_count || 0),
    recent_windows_verified: Object.keys(summary.recent_recharge_totals_cents || {}).sort()
  }));
} finally {
  application.close();
}
