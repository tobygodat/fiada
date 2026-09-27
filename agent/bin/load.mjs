// Runs one of this package's TypeScript entry points. Node 22.18+ strips types
// natively, which starts in about a tenth of a second; older Node goes through
// tsx. Hooks run after every edit an agent makes, so startup time matters.

export async function run(entry) {
  const url = new URL(`../src/${entry}`, import.meta.url);
  if (!process.features.typescript) {
    const { register } = await import('tsx/esm/api');
    register();
  }
  await import(url.href);
}
