// Fiada was called Strata, and agents may already be set up with STRATA_*
// variables. Each one still counts under its FIADA_* name, and wins when both
// are set. Imported first by every entry point, before anything reads them.
for (const [name, value] of Object.entries(process.env)) {
  if (name.startsWith('STRATA_') && value !== undefined) process.env[`FIADA_${name.slice('STRATA_'.length)}`] = value;
}
