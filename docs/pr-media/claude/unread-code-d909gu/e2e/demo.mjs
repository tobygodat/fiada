// Demo driver: imports the demo repo into the local indexer, then plays a coding agent's edits.
// node demo.mjs import | edit1 | edit2 | reset
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const API = process.env.API ?? 'http://127.0.0.1:4178';
const dir = path.join(path.dirname(new URL(import.meta.url).pathname), 'demo/fiada-web');
const agent = { client: 'claude-code', session: 'demo-1', cwd: dir, root: dir };
const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });

async function post(p, body, method = 'POST') {
  const res = await fetch(API + p, body ? { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { method });
  if (!res.ok) throw new Error(`${p}: ${res.status} ${await res.text()}`);
  return res.json();
}

function changed() {
  const files = [];
  const status = git('status', '--porcelain', '-uall').split('\n').filter(Boolean);
  for (const line of status) {
    const code = line.slice(0, 2);
    const file = line.slice(3);
    const kind = code.includes('?') || code.includes('A') ? 'added' : code.includes('D') ? 'deleted' : 'modified';
    let lines = [];
    let additions = 0;
    let deletions = 0;
    if (kind === 'modified') {
      const diff = git('diff', '-U0', '--', file);
      for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
        const n = m[4] == null ? 1 : +m[4];
        const o = m[2] == null ? 1 : +m[2];
        additions += n;
        deletions += o;
        lines.push([+m[3], +m[3] + n - 1]);
      }
    } else if (kind === 'added') {
      const n = fs.readFileSync(path.join(dir, file), 'utf8').split('\n').length;
      additions = n;
      lines = [[1, n]];
    }
    files.push({ path: file, kind, lines, additions, deletions });
  }
  return files;
}

const append = (file, text) => fs.appendFileSync(path.join(dir, file), text);
const replace = (file, a, b) => {
  const p = path.join(dir, file);
  const s = fs.readFileSync(p, 'utf8');
  if (!s.includes(a)) throw new Error(`${file}: no ${a}`);
  fs.writeFileSync(p, s.replace(a, b));
};

const cmd = process.argv[2];
if (cmd === 'import') {
  await post('/api/repos', { source: dir });
  for (;;) {
    const ws = await (await fetch(API + '/api/workspace')).json();
    if (!ws.busy) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log('imported');
} else if (cmd === 'edit1') {
  await post('/api/agent/events', [
    { agent, type: 'session', phase: 'start' },
    { agent, type: 'prompt', text: 'Show which agent changes are new since I last looked' },
    { agent, type: 'status', text: 'Adding read marks to the agent overlay' },
  ]);
  append('src/graph/activity.ts', `\n/** Changes under a node nobody has looked at yet. */\nexport function unreadCount(m: Marks): number {\n  return changeCount(m);\n}\n`);
  replace('src/render/activity.ts', 'const PERIOD = 1400;', 'const PERIOD = 1600;');
  replace('src/components/AgentQueue.tsx', 'const MAX_STEPS = 6;', 'const MAX_STEPS = 8;');
  replace('src/graph/tree.ts', '\n', '\n// Trees the map draws.\n');
  fs.writeFileSync(path.join(dir, 'src/graph/seen.ts'), `// What you've looked at.\n\nexport type Seen = Record<string, number>;\n\nexport function lastSeen(s: Seen, id: string): number {\n  return s[id] ?? 0;\n}\n`);
  replace('src/useAgents.ts', '\n', '\n// Agents, live.\n');
  replace('src/render/edges.ts', '\n', '\n// Which links show.\n');
  await post('/api/agent/events', [{ agent, type: 'changes', files: changed() }]);
  console.log('edit1', changed().length);
} else if (cmd === 'edit2') {
  append('src/graph/activity.ts', `\n/** The other half. */\nexport function readCount(m: Marks, unread: number): number {\n  return changeCount(m) - unread;\n}\n`);
  await post('/api/agent/events', [
    { agent, type: 'status', text: 'Counting what was read' },
    { agent, type: 'changes', files: changed().filter((f) => f.path === 'src/graph/activity.ts') },
  ]);
  console.log('edit2');
} else if (cmd === 'reset') {
  git('checkout', '--', '.');
  git('clean', '-fdq');
  await post('/api/agent', null, 'DELETE');
  console.log('reset');
}
