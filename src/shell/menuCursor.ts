// The cursor of a menu walked by keys (port of components/Menu.js): skips
// hidden and disabled rows and wraps; from nowhere (-1) j starts at the
// first row and k at the last.
export interface MenuEntry {
  visible?: boolean;
  enabled?: boolean;
}

export function selectable(entry: MenuEntry | undefined): boolean {
  return !!entry && entry.visible !== false && entry.enabled !== false;
}

export function nextSelectable(entries: readonly MenuEntry[], current: number, step: number): number {
  if (entries.length === 0) return -1;
  const direction = step < 0 ? -1 : 1;
  let at = Math.floor(current);
  if (!Number.isFinite(at) || at < 0 || at >= entries.length) at = direction > 0 ? -1 : 0;
  for (let i = 0; i < entries.length; i++) {
    at = (at + direction + entries.length) % entries.length;
    if (selectable(entries[at])) return at;
  }
  return -1;
}
