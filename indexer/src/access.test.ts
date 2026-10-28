import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowLocalPaths, defaultHost, hasKey, originMatcher, RateLimit, whoMayCall } from './access.ts';

test('allowed origins: exact entries, preview wildcards, and none by default', () => {
  const allowed = originMatcher('https://hackgt13.vercel.app, https://hackgt13-*-toby-godats-projects.vercel.app/');
  assert.equal(allowed('https://hackgt13.vercel.app'), true);
  assert.equal(allowed('https://hackgt13-git-main-toby-godats-projects.vercel.app'), true);
  assert.equal(allowed('https://hackgt13-37nmqk9ak-toby-godats-projects.vercel.app'), true);
  // The wildcard covers one label's worth of letters, digits and hyphens, nothing more.
  assert.equal(allowed('https://hackgt13-x.evil.com-toby-godats-projects.vercel.app'), false);
  assert.equal(allowed('https://hackgt13.vercel.app.evil.com'), false);
  assert.equal(allowed('http://hackgt13.vercel.app'), false);
  assert.equal(allowed(undefined), false);

  assert.equal(originMatcher(undefined)('https://hackgt13.vercel.app'), false);
  assert.equal(originMatcher('')('https://hackgt13.vercel.app'), false);
  assert.equal(originMatcher('*')('https://anything.example'), true);
});

test('listens on loopback locally and on every interface on a hosting platform', () => {
  assert.equal(defaultHost({}), '127.0.0.1');
  assert.equal(defaultHost({ RAILWAY_PROJECT_ID: 'b7c1' }), '0.0.0.0');
  assert.equal(defaultHost({ RENDER: 'true' }), '0.0.0.0');
  assert.equal(defaultHost({ FLY_APP_NAME: 'fiada' }), '0.0.0.0');
});

test('local folders only on loopback unless FIADA_ALLOW_LOCAL says otherwise', () => {
  assert.equal(allowLocalPaths('127.0.0.1', undefined), true);
  assert.equal(allowLocalPaths('localhost', undefined), true);
  assert.equal(allowLocalPaths('0.0.0.0', undefined), false);
  assert.equal(allowLocalPaths('::', undefined), false);
  assert.equal(allowLocalPaths('0.0.0.0', '1'), true);
  assert.equal(allowLocalPaths('127.0.0.1', '0'), false);
});

test('the access key must match exactly', () => {
  assert.equal(hasKey('Bearer s3cret', 's3cret'), true);
  assert.equal(hasKey('bearer  s3cret ', 's3cret'), true);
  assert.equal(hasKey('Bearer s3cre', 's3cret'), false);
  assert.equal(hasKey('Bearer s3cretx', 's3cret'), false);
  assert.equal(hasKey('s3cret', 's3cret'), false);
  assert.equal(hasKey(undefined, 's3cret'), false);
});

test('a rate limit counts each caller apart and resets after its window', () => {
  let t = 0;
  const limit = new RateLimit(2, 60_000, () => t);
  assert.equal(limit.take('a'), 0);
  assert.equal(limit.take('a'), 0);
  assert.equal(limit.take('a'), 60);
  assert.equal(limit.take('b'), 0);
  t = 59_500;
  assert.equal(limit.take('a'), 1);
  t = 60_000;
  assert.equal(limit.take('a'), 0);
});

test('agent tokens report and ask the map; everything else takes a signed-in person', () => {
  assert.equal(whoMayCall('POST', '/api/agent/events'), 'agent');
  assert.equal(whoMayCall('POST', '/api/agent/check'), 'agent');
  assert.equal(whoMayCall('GET', '/api/agent/check'), 'person');

  for (const route of ['/api/agent/find', '/api/agent/dependents', '/api/agent/impact']) assert.equal(whoMayCall('GET', route), 'agent-or-person');
  // The read routes only read.
  assert.equal(whoMayCall('POST', '/api/agent/find'), 'person');
  assert.equal(whoMayCall('GET', '/api/agent/state'), 'person');
  assert.equal(whoMayCall('GET', '/api/graph'), 'person');
  assert.equal(whoMayCall('DELETE', '/api/agent'), 'person');
});
