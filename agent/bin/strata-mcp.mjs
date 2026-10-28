#!/usr/bin/env node
// The old name, kept so agents set up before the rename keep reporting.
import { run } from './load.mjs';

await run('mcp');
