import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import pg from 'pg';
import { PostgresSyncDatabase } from '../src/postgres-database.js';

const projectEnv = resolve(fileURLToPath(new URL('../../.env', import.meta.url)));
try {
  loadEnvFile(projectEnv);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('缺少 DATABASE_URL');

const targetUrl = new URL(databaseUrl);
if (!['postgres:', 'postgresql:'].includes(targetUrl.protocol)) {
  throw new Error('DATABASE_URL 必须使用 postgresql://');
}
const databaseName = decodeURIComponent(targetUrl.pathname.replace(/^\//, ''));
if (!/^[a-z][a-z0-9_]{0,62}$/.test(databaseName)) {
  throw new Error('数据库名只能包含小写字母、数字和下划线，且必须以字母开头');
}

const adminUrl = new URL(targetUrl);
adminUrl.pathname = '/postgres';
const admin = new pg.Client({
  connectionString: adminUrl.toString(),
  application_name: 'sub2api-extension-setup',
  connectionTimeoutMillis: 15_000
});

await admin.connect();
try {
  const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [databaseName]);
  if (existing.rowCount === 0) {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    console.log(`已创建 PostgreSQL 数据库: ${databaseName}`);
  } else {
    console.log(`PostgreSQL 数据库已存在: ${databaseName}`);
  }
} finally {
  await admin.end();
}

const database = new PostgresSyncDatabase(databaseUrl);
try {
  const version = database.prepare('SELECT MAX(version) AS version FROM extension_schema_migrations').get();
  console.log(`扩展数据库结构已就绪，版本: ${Number(version.version)}`);
} finally {
  database.close();
}
