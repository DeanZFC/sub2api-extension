import test from 'node:test';
import assert from 'node:assert/strict';
import { toPostgresSql } from '../src/postgres-database.js';

test('PostgreSQL 参数转换会跳过字符串和注释中的问号', () => {
  assert.equal(
    toPostgresSql("SELECT '?' AS literal, value FROM sample WHERE first = ? AND second = ? -- ?\n"),
    "SELECT '?' AS literal, value FROM sample WHERE first = $1 AND second = $2 -- ?\n"
  );
  assert.equal(
    toPostgresSql('SELECT "?" FROM sample WHERE value = ? /* ? */'),
    'SELECT "?" FROM sample WHERE value = $1 /* ? */'
  );
});
