import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRuntimeConfig, loadConfig } from '../src/config.js';

function configWithPrefix(prefix) {
  return loadConfig({
    SUB2API_BASE_URL: 'https://sub2api.example',
    SUB2API_ADMIN_API_KEY: 'admin-key',
    SESSION_SECRET: 's'.repeat(32),
    REWARD_CODE_PREFIX: prefix
  });
}

test('奖励码前缀最多 8 个字符以满足 Sub2API 的 32 字符上限', () => {
  assert.doesNotThrow(() => assertRuntimeConfig(configWithPrefix('ABC_DEF-')));
  assert.throws(
    () => assertRuntimeConfig(configWithPrefix('ABC_DEF-X')),
    (error) => error.code === 'CONFIG_INVALID' && /3 至 8/.test(error.message)
  );
});

test('PostgreSQL 连接配置优先于 SQLite 路径且拒绝其他协议', () => {
  const config = loadConfig({
    DATABASE_URL: 'postgresql://extension:test@db.example:5432/sub2api_extension',
    DB_PATH: './ignored.sqlite'
  });
  assert.equal(config.databaseUrl, 'postgresql://extension:test@db.example:5432/sub2api_extension');
  assert.throws(() => loadConfig({ DATABASE_URL: 'mysql://db.example/sub2api_extension' }), /postgresql:\/\//);
});

test('本地测试登录只能在回环地址开启且必须配置独立密钥', () => {
  const base = {
    SUB2API_BASE_URL: 'https://sub2api.example',
    SUB2API_ADMIN_API_KEY: 'admin-key',
    SESSION_SECRET: 's'.repeat(32),
    LOCAL_TEST_ENABLED: 'true'
  };
  assert.throws(() => assertRuntimeConfig(loadConfig(base)), /LOCAL_TEST_SECRET/);
  assert.throws(() => assertRuntimeConfig(loadConfig({
    ...base,
    LOCAL_TEST_SECRET: 't'.repeat(32),
    HOST: '0.0.0.0'
  })), /回环地址/);
  assert.doesNotThrow(() => assertRuntimeConfig(loadConfig({
    ...base,
    LOCAL_TEST_SECRET: 't'.repeat(32),
    HOST: '127.0.0.1'
  })));
});
