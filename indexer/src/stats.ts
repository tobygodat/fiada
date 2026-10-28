// The owner's usage numbers for a hosted indexer (GET /api/admin/stats): how
// many people have accounts, when they signed up and last signed in, and how
// many repositories their projects keep. Counts only, never who: no logins,
// names or ids leave the store through here. Deleted accounts are gone, so
// they count nowhere.

import type { StoredUsage } from './store.ts';

export interface UsageStats {
  /** ISO time of the answer. */
  at: string;
  /** Accounts that exist now. */
  people: number;
  /** 'YYYY-MM' (UTC) to accounts created that month, oldest month first. */
  signUpsByMonth: Record<string, number>;
  /**
   * Accounts that signed in with GitHub (or asked for a new agent token) within
   * the last 7 and 30 days. A session lasts 30 days, so this undercounts visits.
   */
  signedInWithin: { days7: number; days30: number };
  projectsWithRepos: number;
  /** Repositories saved across every project. */
  repos: number;
}

const DAY = 24 * 60 * 60 * 1000;

export function usageStats({ accounts, reposPerProject }: StoredUsage, now: Date): UsageStats {
  const months = new Map<string, number>();
  let days7 = 0;
  let days30 = 0;

  for (const { createdAt, updatedAt } of accounts) {
    const created = Date.parse(createdAt);

    if (!Number.isNaN(created)) {
      const month = new Date(created).toISOString().slice(0, 7);
      months.set(month, (months.get(month) ?? 0) + 1);
    }

    const since = now.getTime() - Date.parse(updatedAt);

    if (since <= 7 * DAY) days7++;

    if (since <= 30 * DAY) days30++;
  }

  return {
    at: now.toISOString(),
    people: accounts.length,
    signUpsByMonth: Object.fromEntries([...months].sort(([a], [b]) => a.localeCompare(b))),
    signedInWithin: { days7, days30 },
    projectsWithRepos: reposPerProject.filter((n) => n > 0).length,
    repos: reposPerProject.reduce((sum, n) => sum + n, 0),
  };
}
