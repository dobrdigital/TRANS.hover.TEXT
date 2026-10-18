// Запуск: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { TranslationCache } = require('../cache.js');

test('get returns undefined for a missing key', () => {
  const cache = new TranslationCache();
  assert.equal(cache.get('missing'), undefined);
});

test('set and get store values', () => {
  const cache = new TranslationCache();
  cache.set('a', 'A');
  assert.equal(cache.get('a'), 'A');
  assert.equal(cache.size, 1);
});

test('evicts the least recently used entry beyond the limit', () => {
  const cache = new TranslationCache(2);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a'); // 'a' becomes most recent, 'b' is now the oldest
  cache.set('c', 3);
  assert.equal(cache.has('b'), false);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('c'), 3);
  assert.equal(cache.size, 2);
});

test('clear removes every entry', () => {
  const cache = new TranslationCache();
  cache.set('a', 1);
  cache.set('b', 2);
  cache.clear();
  assert.equal(cache.size, 0);
});

test('getOrCreate shares one in-flight request between concurrent callers', async () => {
  const cache = new TranslationCache();
  let calls = 0;
  const factory = () => {
    calls += 1;
    return new Promise((resolve) => setTimeout(() => resolve('перевод'), 10));
  };

  const [a, b, c] = await Promise.all([
    cache.getOrCreate('k', factory),
    cache.getOrCreate('k', factory),
    cache.getOrCreate('k', factory),
  ]);

  assert.equal(calls, 1);
  assert.equal(a, 'перевод');
  assert.equal(b, 'перевод');
  assert.equal(c, 'перевод');
});

test('getOrCreate does not keep a failed request', async () => {
  const cache = new TranslationCache();
  let calls = 0;
  const failing = () => {
    calls += 1;
    return Promise.reject(new Error('network'));
  };

  await assert.rejects(cache.getOrCreate('k', failing), /network/);
  assert.equal(cache.has('k'), false);

  const value = await cache.getOrCreate('k', () => {
    calls += 1;
    return Promise.resolve('ok');
  });
  assert.equal(value, 'ok');
  assert.equal(calls, 2);
});

test('getOrCreate returns a stored value without calling the factory', async () => {
  const cache = new TranslationCache();
  cache.set('k', 'cached');
  const value = await cache.getOrCreate('k', () => {
    throw new Error('must not be called');
  });
  assert.equal(value, 'cached');
});
