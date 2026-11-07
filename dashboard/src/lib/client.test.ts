import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APIError,
  filterRepositories,
  readJSON,
  statusOf,
  generateSummary,
  type Repository
} from './client.ts';

const repositories: Repository[] = [
  { name: 'api', path: '/repos/api', branch: 'main', detached: false, changed_files: 0 },
  {
    name: 'dashboard',
    path: '/repos/dashboard',
    branch: 'feat/svelte',
    detached: false,
    changed_files: 4
  },
  {
    name: 'broken',
    path: '/repos/broken',
    branch: '',
    detached: false,
    changed_files: 0,
    error: 'git failed'
  }
];

test('paid summary requests require an explicit POST and never retry', async () => {
  let calls = 0;
  const transport = (async (path, options) => {
    calls++;
    assert.equal(path, '/api/summary');
    assert.equal(options?.method, 'POST');
    assert.equal(options?.body, '{}');
    assert.equal(new Headers(options?.headers).get('X-Observatory-Request'), 'generate-summary');
    return new Response('{"error":{"message":"busy"}}', {
      status: 503,
      headers: { 'Retry-After': '0' }
    });
  }) as typeof fetch;
  await assert.rejects(generateSummary(new AbortController().signal, transport), /busy/);
  assert.equal(calls, 1);
});

test('search and status filters compose; unavailable scans are never clean', () => {
  assert.deepEqual(
    filterRepositories(repositories, ' SVELTE ', 'changed').map((repo) => repo.name),
    ['dashboard']
  );
  assert.equal(filterRepositories(repositories, '', 'clean').length, 1);
  assert.equal(filterRepositories(repositories, '', 'unavailable')[0].name, 'broken');
  assert.equal(statusOf(repositories[2]), 'Unavailable');
});

test('API errors preserve server guidance and tolerate non-JSON proxy errors', async () => {
  const jsonFailure = (async () =>
    new Response(JSON.stringify({ error: { message: 'Save a snapshot first.' } }), {
      status: 404
    })) as typeof fetch;
  await assert.rejects(
    readJSON('/api/snapshot', new AbortController().signal, jsonFailure),
    (error: unknown) =>
      error instanceof APIError &&
      error.status === 404 &&
      error.message === 'Save a snapshot first.'
  );
  const textFailure = (async () =>
    new Response('proxy unavailable', { status: 502 })) as typeof fetch;
  await assert.rejects(readJSON('/api/snapshot', new AbortController().signal, textFailure), /502/);
});

test('fetch cancellation and fresh-data options reach the transport', async () => {
  const controller = new AbortController();
  const transport = (async (_path, options) => {
    assert.equal(options?.signal, controller.signal);
    assert.equal(options?.cache, 'no-store');
    return new Response('{"status":"ok"}');
  }) as typeof fetch;
  assert.deepEqual(await readJSON('/healthz', controller.signal, transport), { status: 'ok' });
});

test('busy analysis retries once and remains cancellable while waiting', async () => {
  let calls = 0;
  const transport = (async () => {
    calls++;
    return calls === 1
      ? new Response('{}', { status: 503, headers: { 'Retry-After': '0' } })
      : new Response('{"snapshot_count":3}');
  }) as typeof fetch;
  assert.deepEqual(await readJSON('/api/analysis', new AbortController().signal, transport), {
    snapshot_count: 3
  });
  assert.equal(calls, 2);
  calls = 0;
  const busy = (async () => {
    calls++;
    return new Response('{}', { status: 503, headers: { 'Retry-After': '0' } });
  }) as typeof fetch;
  await assert.rejects(readJSON('/api/analysis', new AbortController().signal, busy), /503/);
  assert.equal(calls, 2);
  const controller = new AbortController();
  const waiting = readJSON(
    '/api/analysis',
    controller.signal,
    (async () =>
      new Response('{}', { status: 503, headers: { 'Retry-After': '2' } })) as typeof fetch
  );
  controller.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
});
