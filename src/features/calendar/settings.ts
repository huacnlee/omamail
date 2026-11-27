// The calendar's own settings, under the names the Qt client gave them
// (`calendarHourHeight`, `unifiedCalendarView`, `calendarRemindersEnabled`,
// `calendarSnoozeMinutes`, `invitationCalendars`). Qt kept them in the
// Omarchy shell's plugin entry (Service.qml `persistSetting`), which this app
// cannot reach directly: the plugin's notice widget hands them over once in
// plugin-settings.json, and `importCalendarSettings` takes them on the first
// run. Like the app's other settings (src/features/settings/store.ts) they
// live in NSH Storage, read back as untrusted. The settings page edits them
// through `calendarSettings`.
import { Storage, signal } from "nsh";

const KEY = "calendar.settings.v1";

export interface CalendarSettingsValue {
  /** Points per hour in the day and week views; 0 fits the window. */
  calendarHourHeight: number;
  /** One calendar for every mailbox rather than the open mailbox's. */
  unifiedCalendarView: boolean;
  calendarRemindersEnabled: boolean;
  /** 1 to 1440. */
  calendarSnoozeMinutes: number;
  /** Per mailbox, the calendar an accepted invitation is saved to. */
  invitationCalendars: Record<string, unknown>;
}

const DEFAULTS: CalendarSettingsValue = {
  calendarHourHeight: 0,
  unifiedCalendarView: false,
  calendarRemindersEnabled: true,
  calendarSnoozeMinutes: 5,
  invitationCalendars: {},
};

/** What a stored value says, anything malformed read as the default. */
export function parseSettings(text: string | null): CalendarSettingsValue {
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    data = {};
  }
  const height = Number(data.calendarHourHeight);
  const snooze = Math.floor(Number(data.calendarSnoozeMinutes));
  const invitations = data.invitationCalendars;
  return {
    calendarHourHeight: Number.isFinite(height) && height >= 0 ? height : DEFAULTS.calendarHourHeight,
    unifiedCalendarView: data.unifiedCalendarView === true,
    calendarRemindersEnabled: data.calendarRemindersEnabled !== false,
    calendarSnoozeMinutes: Number.isFinite(snooze) ? Math.max(1, Math.min(1440, snooze)) : DEFAULTS.calendarSnoozeMinutes,
    invitationCalendars: invitations && typeof invitations === "object" && !Array.isArray(invitations)
      ? (invitations as Record<string, unknown>) : {},
  };
}

const value = signal<CalendarSettingsValue>({ ...DEFAULTS });
/** The stored read, once started: whether anything was stored. */
let reading: Promise<boolean> | null = null;
/** A setting changed in this run, which a late read or import must not undo. */
let changed = false;

function save() {
  Storage.setItem(KEY, JSON.stringify(value())).catch(() => {
    // Storage refused the write; the setting holds for this run.
  });
}

/** Reads the stored settings once. */
export function loadSettings(): Promise<boolean> {
  if (!reading) {
    reading = Storage.getItem(KEY)
      .then((text) => {
        if (!changed) value.set(parseSettings(text));
        return text !== null;
      })
      .catch(() => false); // Unreadable storage: the defaults stand.
  }
  return reading;
}

const IMPORTED_KEYS: Array<keyof CalendarSettingsValue> = [
  "calendarHourHeight", "unifiedCalendarView", "calendarRemindersEnabled", "calendarSnoozeMinutes", "invitationCalendars",
];

/**
 * The Qt plugin's calendar settings, from plugin-settings.json (the settings
 * store hands them over on the app's first run). They apply only when this
 * app has stored none of its own and nothing changed meanwhile; the file is
 * untrusted, so only the five keys are taken, each through `parseSettings`.
 */
export function importCalendarSettings(raw: Record<string, unknown>): void {
  const imported = importedSettings(raw);
  if (!imported) return;
  void loadSettings().then((stored) => {
    if (stored || changed) return;
    // Counts as a change: nothing later in this run reads it back over.
    changed = true;
    value.set(imported);
    save();
  });
}

/** The calendar's settings in the plugin's export, or null when it names none. */
export function importedSettings(raw: unknown): CalendarSettingsValue | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const key of IMPORTED_KEYS) if (key in source) picked[key] = source[key];
  return Object.keys(picked).length === 0 ? null : parseSettings(JSON.stringify(picked));
}

export const calendarSettings = {
  value: () => value(),
  hourHeight: () => value().calendarHourHeight,
  unified: () => value().unifiedCalendarView,
  remindersEnabled: () => value().calendarRemindersEnabled,
  snoozeMinutes: () => value().calendarSnoozeMinutes,
  /** The Qt client's `persistSetting`, for the calendar's keys. */
  set<K extends keyof CalendarSettingsValue>(key: K, next: CalendarSettingsValue[K]) {
    changed = true;
    value.set(parseSettings(JSON.stringify({ ...value(), [key]: next })));
    save();
  },
};
