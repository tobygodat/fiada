import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setupCommand } from './connect.ts';
import { takeEvents } from './sse.ts';

test('server-sent events split off whole, with an unfinished one kept for the next chunk', () => {
  assert.deepEqual(takeEvents('data: {"a":1}\n\n: ping\n\ndata: {"b"'), { data: ['{"a":1}'], rest: 'data: {"b"' });
  assert.deepEqual(takeEvents('data: {"b":2}\n\n'), { data: ['{"b":2}'], rest: '' });
  assert.deepEqual(takeEvents('data: one\r\ndata: two\r\n\r\n'), { data: ['one\ntwo'], rest: '' });
  assert.deepEqual(takeEvents(''), { data: [], rest: '' });
});

test('the setup command carries the indexer and the token, and nothing when there is no token', () => {
  assert.equal(
    setupCommand({ url: 'https://indexer.test', token: 'fa_abc.def' }),
    'npx -y @fiada/agent setup --write . --url https://indexer.test --token fa_abc.def',
  );
  assert.equal(setupCommand({ url: 'http://localhost:5178' }), 'npx -y @fiada/agent setup --write . --url http://localhost:5178');
});
