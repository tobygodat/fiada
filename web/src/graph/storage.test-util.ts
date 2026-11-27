// A stand-in for the browser's localStorage, for tests that run under Node.

/** Run `run` with `localStorage` backed by `store`, then put back whatever was there before. */
export function withStorage(store: Map<string, string>, run: () => void): void {
  const fake: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };

  const was = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true, writable: true });

  try {
    run();
  } finally {
    if (was) Object.defineProperty(globalThis, 'localStorage', was);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
}
