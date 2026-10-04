import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh, postJSON } from './_helpers.js';

test('POST /links creates a link and returns 201 with the record', async () => {
  const { call } = fresh();
  const res = await call(postJSON('/links', { slug: 'Docs', url: 'https://example.com/docs' }));
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('content-type').startsWith('application/json'), true);
  const body = await res.json();
  assert.equal(body.slug, 'docs');
  assert.equal(body.url, 'https://example.com/docs');
  assert.equal(typeof body.createdAt, 'string');
});

test('POST /links rejects a duplicate slug with 409', async () => {
  const { call } = fresh();
  await call(postJSON('/links', { slug: 'docs', url: 'https://example.com/a' }));
  const res = await call(postJSON('/links', { slug: 'docs', url: 'https://example.com/b' }));
  assert.equal(res.status, 409);
});

test('POST /links rejects a non-http(s) url with 400', async () => {
  const { call } = fresh();
  const res = await call(postJSON('/links', { slug: 'ftp', url: 'ftp://example.com/file' }));
  assert.equal(res.status, 400);
});

test('POST /links rejects an empty or slashy slug with 400', async () => {
  const { call } = fresh();
  const empty = await call(postJSON('/links', { slug: '', url: 'https://example.com' }));
  assert.equal(empty.status, 400);
  const slashy = await call(postJSON('/links', { slug: 'a/b', url: 'https://example.com' }));
  assert.equal(slashy.status, 400);
});

test('POST /links rejects a non-JSON body with 400', async () => {
  const { call } = fresh();
  const res = await call(new Request('https://shortlinks.example/links', { method: 'POST', body: 'not json' }));
  assert.equal(res.status, 400);
});

test('service.create returns the stored record directly', () => {
  const { service } = fresh();
  const record = service.create('Blog', 'https://example.com/blog');
  assert.equal(record.slug, 'blog');
  assert.equal(record.url, 'https://example.com/blog');
  assert.equal(typeof record.createdAt, 'string');
});
