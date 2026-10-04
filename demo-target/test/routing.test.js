import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { fresh } from './_helpers.js';

test('worker exports a default fetch handler', () => {
  assert.equal(typeof worker.fetch, 'function');
});

test('unknown routes return 404 JSON', async () => {
  const { call } = fresh();
  const res = await call(new Request('https://shortlinks.example/links', { method: 'DELETE' }));
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.match(body.error, /no route/);
});

test('GET / returns 404 no-route', async () => {
  const { call } = fresh();
  const res = await call(new Request('https://shortlinks.example/'));
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.match(body.error, /no route/);
});
