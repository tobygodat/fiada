// Loads .env from the project root, if there is one, before any other module
// reads process.env. Variables already set in the environment win.

try {
  process.loadEnvFile(new URL('../../.env', import.meta.url));
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
}
