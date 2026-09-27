// Loads .env from the project root, if there is one, before any other module
// reads process.env. Variables already set in the environment win.

try {
  process.loadEnvFile(new URL('../../.env', import.meta.url));
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
}

// Fiada was called Strata, and hosts already set STRATA_* variables. Each one
// still counts under its FIADA_* name, and wins when both are set.
for (const [name, value] of Object.entries(process.env)) {
  if (name.startsWith('STRATA_') && value !== undefined) process.env[`FIADA_${name.slice('STRATA_'.length)}`] = value;
}
