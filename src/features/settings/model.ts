// What Settings stores and how a stored value is read back: the plugin
// settings the Qt client kept (Service.qml `defaultSettingValues`), and the
// zoom rule the reader's window preferences share (account/Model.js; the
// reader owns those preferences in src/features/reader/prefs.ts).
// Pure functions, so every rule is testable without storage. A value read
// back is untrusted (hand edits, older versions): each is normalized, never
// trusted as written.

export const APPEARANCE = ["System", "Light", "Dark", "Omarchy"] as const;
export type Appearance = (typeof APPEARANCE)[number];

/**
 * The stored appearance's version. Version 1 (the Qt client and the first
 * port) offered System / Light / Dark, and all three drew the Omarchy palette;
 * version 2 adds Omarchy and draws Omamail's own paper/ink for the others.
 */
export const APPEARANCE_VERSION = 2;

/** Where the app runs, for the defaults that depend on it. */
export interface Platform {
  /** An Omarchy desktop, whose palette the app follows by default. */
  omarchy: boolean;
}

/** Omarchy on an Omarchy desktop, System elsewhere. */
export function defaultAppearance(platform: Platform): Appearance {
  return platform.omarchy ? "Omarchy" : "System";
}

/**
 * The appearance of a stored record. A version 1 record on an Omarchy desktop
 * becomes Omarchy whatever it said, since every version 1 value drew the
 * Omarchy palette: an existing user sees no change. Elsewhere System, Light
 * and Dark keep their meaning. Anything unknown is the platform's default.
 */
export function storedAppearance(source: Record<string, unknown>, platform: Platform): Appearance {
  const known = APPEARANCE.find((mode) => mode.toLowerCase() === text(source.appearance).toLowerCase());
  if (source.appearanceVersion === APPEARANCE_VERSION) return known ?? defaultAppearance(platform);
  if (platform.omarchy) return "Omarchy";
  return known && known !== "Omarchy" ? known : defaultAppearance(platform);
}

/** Whether a stored record predates the current appearance version, so it is written back once read. */
export function needsAppearanceMigration(raw: unknown): boolean {
  return !!raw && typeof raw === "object" && (raw as Record<string, unknown>).appearanceVersion !== APPEARANCE_VERSION;
}

export const DIRECTION = ["Auto", "Left to right", "Right to left"] as const;
export type Direction = (typeof DIRECTION)[number];

export const HEAVY_DEFAULT = "Show plain text first";
export const HEAVY_ALWAYS = "Always render";

/**
 * The body never goes below 80%: at 60% (Qt's floor) a 15pt body is 9pt, small
 * enough to read as broken. A stored value under it (Qt's window.json, a hand
 * edit, an earlier build) is raised to it when read.
 */
export const ZOOM_MIN = 0.8;
export const ZOOM_MAX = 2.5;
const ZOOM_STEPS_PER_UNIT = 20;

export const UNDO_SEND_DEFAULT = 10;
export const UNDO_SEND_MAX = 60;

/**
 * The plugin settings, by the Qt keys, with the Qt defaults. The AI keys
 * (`aiAgent`, `aiModel`) belong to the assistant (src/features/assistant/
 * settings.ts) and the calendar's to the calendar (src/features/calendar/
 * settings.ts): one owner each.
 */
export interface Settings {
  refreshIntervalSec: number;
  maxMessages: number;
  heavyMessageRendering: string;
  contentDirection: Direction;
  appearance: Appearance;
  /** Always APPEARANCE_VERSION once read: the record says which rule its appearance follows. */
  appearanceVersion: number;
  defaultQuery: string;
  notifyNewMail: "On" | "Off";
  oauthPort: number;
  undoSendSeconds: number;
  showBarIcon: boolean;
  unifiedMailboxes: boolean;
  suggestEvents: boolean;
}

export const DEFAULTS: Settings = {
  refreshIntervalSec: 120,
  maxMessages: 50,
  heavyMessageRendering: HEAVY_DEFAULT,
  contentDirection: "Auto",
  appearance: "System",
  appearanceVersion: APPEARANCE_VERSION,
  defaultQuery: "in:inbox",
  notifyNewMail: "On",
  oauthPort: 9481,
  undoSendSeconds: UNDO_SEND_DEFAULT,
  showBarIcon: true,
  unifiedMailboxes: false,
  suggestEvents: false,
};

function text(value: unknown): string {
  return String(value === undefined || value === null ? "" : value).trim();
}

/** Case-insensitive; anything else is `fallback` (System). */
export function normalizeAppearance(value: unknown, fallback: Appearance = "System"): Appearance {
  const wanted = text(value).toLowerCase();
  return APPEARANCE.find((mode) => mode.toLowerCase() === wanted) ?? fallback;
}

/** The color scheme an appearance asks for: "system" follows the desktop. */
export function schemeFor(mode: unknown): "light" | "dark" | "system" {
  const normalized = normalizeAppearance(mode);
  return normalized === "Light" ? "light" : normalized === "Dark" ? "dark" : "system";
}

/** Exact labels only: `dir` would silently ignore a near miss. */
export function normalizeDirection(value: unknown): Direction {
  const raw = String(value ?? "");
  return raw === "Right to left" || raw === "Left to right" ? raw : "Auto";
}

/** 0 to 60 whole seconds; anything unreadable is the default. */
export function normalizeUndoSend(value: unknown): number {
  if (value === undefined || value === null || value === "") return UNDO_SEND_DEFAULT;
  const seconds = Number(value);
  if (!isFinite(seconds)) return UNDO_SEND_DEFAULT;
  return Math.max(0, Math.min(UNDO_SEND_MAX, Math.floor(seconds)));
}

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.floor(Number(value));
  if (!isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Stored settings over the defaults, each value read through its own rule. */
export function normalizeSettings(raw: unknown, platform: Platform = { omarchy: false }): Settings {
  const source: Record<string, unknown> = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as any) : {};
  const notify = text(source.notifyNewMail);
  return {
    refreshIntervalSec: bounded(source.refreshIntervalSec, DEFAULTS.refreshIntervalSec, 15, 86400),
    maxMessages: bounded(source.maxMessages, DEFAULTS.maxMessages, 10, 500),
    heavyMessageRendering: source.heavyMessageRendering === HEAVY_ALWAYS ? HEAVY_ALWAYS : HEAVY_DEFAULT,
    contentDirection: normalizeDirection(source.contentDirection),
    appearance: raw && typeof raw === "object" && !Array.isArray(raw) && Object.keys(source).length > 0
      ? storedAppearance(source, platform)
      : defaultAppearance(platform),
    appearanceVersion: APPEARANCE_VERSION,
    defaultQuery: text(source.defaultQuery) || DEFAULTS.defaultQuery,
    notifyNewMail: notify === "Off" ? "Off" : "On",
    oauthPort: (() => {
      const port = Math.floor(Number(source.oauthPort));
      return port >= 1024 && port <= 65535 ? port : DEFAULTS.oauthPort;
    })(),
    undoSendSeconds: normalizeUndoSend(source.undoSendSeconds),
    showBarIcon: bool(source.showBarIcon, DEFAULTS.showBarIcon),
    unifiedMailboxes: bool(source.unifiedMailboxes, DEFAULTS.unifiedMailboxes),
    suggestEvents: bool(source.suggestEvents, DEFAULTS.suggestEvents),
  };
}

/** A zoom as stored: ZOOM_MIN (0.8) to 2.5 in steps of 1/20; anything that is not a number is 1. */
export function clampZoom(value: unknown): number {
  if (value === null || value === undefined || value === "") return 1;
  const zoom = Number(value);
  if (!isFinite(zoom)) return 1;
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(zoom * ZOOM_STEPS_PER_UNIT) / ZOOM_STEPS_PER_UNIT));
}

export function zoomAfterStep(zoom: unknown, step: unknown): number {
  const by = Number(step);
  return clampZoom(clampZoom(zoom) + (isFinite(by) ? by : 0));
}

/** The Omarchy plugin's settings, written once to plugin-settings.json under
 * the Qt plugin's own keys: the settings they hold, or null when the file is
 * absent, unreadable or not an object. Unknown keys are dropped and each
 * value goes through its own rule, as any stored value does. */
/**
 * The settings object inside plugin-settings.json, as the Omarchy plugin's
 * notice widget writes it: `{version: 1, settings: {...}}`. Untrusted: null
 * for anything else, and every reader takes only the keys it knows.
 */
export function pluginExport(text: unknown): Record<string, unknown> | null {
  if (typeof text !== "string" || text.trim() === "" || text.length > 65536) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const file = raw as Record<string, unknown>;
  if (file.version !== 1) return null;
  const settings = file.settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  return settings as Record<string, unknown>;
}

/** This page's settings from the plugin's export, by the same rules as stored ones. */
export function pluginSettings(text: unknown): Settings | null {
  const raw = pluginExport(text);
  return raw ? normalizeSettings(raw) : null;
}

/**
 * The second line of a mailbox row in Settings (SettingsPage.qml): its
 * session's error, "Signed out", or its unread count, with the address in
 * front when the first line shows a name instead. The error is server text:
 * shown as plain text only.
 */
export function mailboxRowStatus(row: {
  email: string;
  named: boolean;
  signedIn?: boolean;
  error?: string;
  unread: number;
}): { text: string; error: boolean } {
  const error = String(row.error ?? "");
  if (error !== "") return { text: error, error: true };
  if (row.signedIn === false) return { text: "Signed out", error: false };
  const count = Math.max(0, Math.floor(Number(row.unread) || 0));
  const unread = count === 0 ? "No unread mail" : count === 1 ? "1 unread message" : count + " unread messages";
  return { text: row.named ? row.email + " · " + unread : unread, error: false };
}
