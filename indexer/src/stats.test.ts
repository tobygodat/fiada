import assert from 'node:assert/strict';
import { test } from 'node:test';
import { usageStats } from './stats.ts';

const now = new Date('2026-10-26T12:00:00.000Z');
const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

test('an indexer nobody has used counts nothing', () => {
  assert.deepEqual(usageStats({ accounts: [], reposPerProject: [] }, now), {
    at: '2026-10-26T12:00:00.000Z',
    people: 0,
    signUpsByMonth: {},
    signedInWithin: { days7: 0, days30: 0 },
    projectsWithRepos: 0,
    repos: 0,
  });
});

test('sign-ups are counted by UTC month, oldest first', () => {
  const accounts = ['2026-10-01T00:00:00.000Z', '2026-08-31T23:59:59.000Z', '2026-10-31T23:00:00.000Z', '2026-09-30T23:30:00-02:00'].map((createdAt) => ({
    createdAt,
    updatedAt: createdAt,
  }));
  const stats = usageStats({ accounts, reposPerProject: [] }, now);
  assert.equal(stats.people, 4);
  assert.deepEqual(Object.entries(stats.signUpsByMonth), [
    ['2026-08', 1],
    ['2026-10', 3],
  ]);
});

test('recent sign-ins fall in the 7 and 30 day windows by when the account was last signed in', () => {
  const accounts = [0, 7, 8, 30, 31, 400].map((n) => ({ createdAt: '2025-01-01T00:00:00.000Z', updatedAt: daysAgo(n) }));
  assert.deepEqual(usageStats({ accounts, reposPerProject: [] }, now).signedInWithin, { days7: 2, days30: 4 });
});

test('repositories are summed across projects, and empty projects do not count as having any', () => {
  const stats = usageStats({ accounts: [], reposPerProject: [3, 0, 1, 0] }, now);
  assert.equal(stats.repos, 4);
  assert.equal(stats.projectsWithRepos, 2);
});
