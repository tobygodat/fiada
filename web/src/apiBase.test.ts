import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiBase } from './apiBase.ts';

test('the indexer address works however it was typed', () => {
  assert.equal(apiBase(undefined), '');
  assert.equal(apiBase(' '), '');
  assert.equal(apiBase('https://strataindexer-production.up.railway.app/'), 'https://strataindexer-production.up.railway.app');
  assert.equal(apiBase('strataindexer-production.up.railway.app'), 'https://strataindexer-production.up.railway.app');
  assert.equal(apiBase('"https://fiada.fly.dev"'), 'https://fiada.fly.dev');
  assert.equal(apiBase('localhost:4178'), 'http://localhost:4178');
  assert.equal(apiBase('http://127.0.0.1:4178'), 'http://127.0.0.1:4178');
  assert.equal(apiBase('/indexer'), '/indexer');
});
