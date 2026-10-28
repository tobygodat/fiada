// Which paper Fiada is on: the system's choice until the person picks dark or
// light. index.html applies the same rule before first paint, so nothing flashes.

import { useEffect, useState } from 'react';
import { getTheme, onThemeChange, setTheme, type Theme } from './theme/tokens.ts';

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

/** The choice, a setter, and the theme on screen now: colours drawn inline from tokens re-render when it changes. */
export function useTheme(): [ThemeChoice, (c: ThemeChoice) => void, Theme] {
  const [choice, setChoice] = useState<ThemeChoice>(() => saved() ?? 'system');
  const [shown, setShown] = useState<Theme>(getTheme);

  useEffect(() => onThemeChange(setShown), []);

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

  return [choice, setChoice, shown];
}
