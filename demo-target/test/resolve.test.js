import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh, postJSON, get } from './_helpers.js';

test('GET /:slug redirects to the stored url with 302', async () => {
  const { call } = fresh();
  await call(postJSON('/links', { slug: 'docs', url: 'https://example.com/docs' }));
  const res = await call(get('/docs'));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://example.com/docs');
});

test('GET /:slug returns 404 for an unknown slug', async () => {
  const { call } = fresh();
  const res = await call(get('/nope'));
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.match(body.error, /no such slug/);
});
