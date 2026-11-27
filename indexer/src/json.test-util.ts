// Reading into JSON our own code built, for tests that check one value deep inside it.

import assert from 'node:assert/strict';
import type { Json } from '@fiada/shared';

/** The value at `keys` inside `json`, failing the test where a step on the way isn't an object. */
export function dig(json: Json | undefined, ...keys: string[]): Json | undefined {
  let at = json;

  for (const key of keys) {
    assert.ok(at instanceof Object && !Array.isArray(at), `no object to read ${key} from`);
    at = at[key];
  }

  return at;
}
