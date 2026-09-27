// Explicit overrides from a checked-in strata.config.json. Always wins.

import { LAYERS, type Layer } from '@strata/shared';
import type { DomainClassifier, LayerClassifier } from './types.ts';

/** Minimal glob: `**` spans directories, `*` stays within one, `?` is one char. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}(?:/.*)?$`);
}

const compiled = new WeakMap<object, [RegExp, string, string][]>();
function rules(map: Record<string, string>) {
  let r = compiled.get(map);
  if (!r) {
    r = Object.entries(map).map(([glob, value]) => [globToRegExp(glob), value, glob]);
    compiled.set(map, r);
  }
  return r;
}

export const configLayers: LayerClassifier = {
  name: 'repo-config',
  classifyFile({ repo, file }) {
    const map = repo.config?.layers;
    if (!map) return null;
    for (const [re, value, glob] of rules(map)) {
      if (re.test(file.path) && (LAYERS as readonly string[]).includes(value)) {
        return { value: value as Layer, confidence: 1, reason: `strata.config.json: "${glob}"` };
      }
    }
    return null;
  },
};

export const configDomains: DomainClassifier = {
  name: 'repo-config',
  classifyFile({ repo, file }) {
    const map = repo.config?.domains;
    if (!map) return null;
    for (const [re, value, glob] of rules(map)) {
      if (re.test(file.path)) return { value, confidence: 1, reason: `strata.config.json: "${glob}"` };
    }
    return null;
  },
};
