import test from 'node:test';
import assert from 'node:assert/strict';
import { Sub2ApiClient } from '../src/sub2api-client.js';

const config = {
  sub2apiBaseUrl: 'https://sub2api.example',
  sub2apiAdminApiKey: 'admin-secret',
  upstreamTimeoutMs: 1_000
};

test('Sub2API 客户端分别使用 Bearer 和 x-api-key 并解包 data', async () => {
  const requests = [];
  const client = new Sub2ApiClient(config, async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify({ code: 0, message: 'success', data: { id: 7 } }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  });
  assert.deepEqual(await client.authMe('jwt-value', { userAgent: 'test-agent' }), { id: 7 });
  assert.deepEqual(await client.getUser(7), { id: 7 });
  assert.deepEqual(await client.getUserBalanceHistory(7), { id: 7 });
  assert.deepEqual(await client.getUserBalanceHistory(7, {
    page: 2,
    pageSize: 1000,
    type: 'admin_balance'
  }), { id: 7 });
  assert.deepEqual(await client.listGroups(), { id: 7 });
  assert.deepEqual(await client.updateUserAllowedGroups(7, [2, 5]), { id: 7 });
  assert.equal(requests[0].options.headers.Authorization, 'Bearer jwt-value');
  assert.equal(requests[0].options.headers['x-api-key'], undefined);
  assert.equal(requests[1].options.headers['x-api-key'], 'admin-secret');
  assert.equal(requests[1].options.headers.Authorization, undefined);
  assert.equal(
    requests[2].url,
    'https://sub2api.example/api/v1/admin/users/7/balance-history?page=1&page_size=1&type=balance'
  );
  assert.equal(
    requests[3].url,
    'https://sub2api.example/api/v1/admin/users/7/balance-history?page=2&page_size=1000&type=admin_balance'
  );
  assert.equal(
    requests[4].url,
    'https://sub2api.example/api/v1/admin/groups?page=1&page_size=1000&sort_by=id&sort_order=asc'
  );
  assert.equal(requests[5].options.method, 'PUT');
  assert.deepEqual(JSON.parse(requests[5].options.body), { allowed_groups: [2, 5] });
});

test('Sub2API 业务错误不会把上游响应内容直接泄露', async () => {
  const client = new Sub2ApiClient(config, async () => new Response(JSON.stringify({
    code: 'BAD', message: 'contains secret details'
  }), { status: 400, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(() => client.getUser(1), (error) => {
    assert.equal(error.code, 'SUB2API_ERROR');
    assert.equal(error.upstreamStatus, 400);
    assert.doesNotMatch(error.message, /secret details/);
    return true;
  });
});
