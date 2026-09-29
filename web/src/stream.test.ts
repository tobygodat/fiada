import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setupCommand, shellWord } from './connect.ts';
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
    'npx -y --package=@fiada/agent fiada setup --write . --url=https://indexer.test --token=fa_abc.def',
  );
  assert.equal(setupCommand({ url: 'http://localhost:5178' }), 'npx -y --package=@fiada/agent fiada setup --write . --url=http://localhost:5178');
});

test('the setup command quotes what a shell would split or run', () => {
  assert.equal(shellWord('fa_eyJrIjoiYSJ9.abc-_'), 'fa_eyJrIjoiYSJ9.abc-_');
  assert.equal(shellWord('key with; rm -rf ~'), "'key with; rm -rf ~'");
  assert.equal(shellWord("it's $HOME"), "'it'\\''s $HOME'");
  assert.equal(
    setupCommand({ url: 'https://indexer.test' }, 'a b;c'),
    "npx -y --package=@fiada/agent fiada setup --write . --url=https://indexer.test --token='a b;c'",
  );
});
