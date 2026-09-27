import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowLocalPaths, hasKey, originMatcher } from './access.ts';

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

test('local folders only on loopback unless STRATA_ALLOW_LOCAL says otherwise', () => {
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
