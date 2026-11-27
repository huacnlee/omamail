// The undo-send window. Port of omarchy/ui/message/Outbox.js.
export const DEFAULT_DELAY_SECONDS = 10;
export const MAX_DELAY_SECONDS = 60;

export function normalizeDelay(value: unknown): number {
  if (value === undefined || value === null || value === "") return DEFAULT_DELAY_SECONDS;
  const seconds = Number(value);
  if (!isFinite(seconds)) return DEFAULT_DELAY_SECONDS;
  return Math.max(0, Math.min(MAX_DELAY_SECONDS, Math.floor(seconds)));
}
