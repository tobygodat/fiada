// How long ago something happened, in the few words the agent window and the detail panel use.

/** "just now", "4 min ago", "2 h ago". */
export function ago(iso: string) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));

  if (s < 60) return 'just now';

  if (s < 3600) return `${Math.round(s / 60)} min ago`;

  return `${Math.round(s / 3600)} h ago`;
}
