interface ImportMetaEnv {
  /** The hosted indexer's URL, for a build served apart from it (e.g. on Vercel). Unset, the map calls its own origin. */
  readonly VITE_API_URL?: string;
}
