// Which paper Strata is on: the system's choice until the person picks dark or
// light. index.html applies the same rule before first paint, so nothing flashes.

import { useEffect, useState } from 'react';
import { setTheme, type Theme } from './theme/tokens.ts';

export type ThemeChoice = Theme | 'system';

const KEY = 'strata-theme';
const prefersLight = () => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches;

function saved(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

export function useTheme(): [ThemeChoice, (c: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(() => saved() ?? 'system');

  useEffect(() => {
    if (choice !== 'system') return setTheme(choice);
    try {
      localStorage.removeItem(KEY);
    } catch {
      // private mode: nothing was saved
    }
    const media = matchMedia('(prefers-color-scheme: light)');
    const follow = () => {
      document.documentElement.dataset.theme = prefersLight() ? 'light' : 'dark';
    };
    follow();
    media.addEventListener('change', follow);
    return () => media.removeEventListener('change', follow);
  }, [choice]);

  return [choice, setChoice];
}
