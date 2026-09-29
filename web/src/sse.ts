// Server-sent events read off a fetch body, for the agent stream (useAgents.ts).

/** Splits server-sent events off the front of `buf`: each event's data, and what's left of an unfinished one. */
export function takeEvents(buf: string): { data: string[]; rest: string } {
  const data: string[] = [];
  const blocks = buf.replace(/\r\n/g, '\n').split('\n\n');
  const rest = blocks.pop() ?? '';
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, ''));
    if (lines.length) data.push(lines.join('\n'));
  }
  return { data, rest };
}
