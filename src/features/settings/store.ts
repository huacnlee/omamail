// The settings every feature reads: reactive getters, kept in NSH Storage
// under the keys and values the Qt client used (Service.qml
// `defaultSettingValues`, stored as one JSON object). Three groups have their
// own owners and are only passed through here: the reader's window
// preferences (src/features/reader/prefs.ts), the AI agent and model
// (src/features/assistant/settings.ts) and the calendar's settings
// (src/features/calendar/settings.ts).
//
// Nothing secret is ever stored here: OAuth clients go through the native
// owner-only config, passwords and tokens through the backend's keyring.
import { signal, Storage, untracked } from "nsh";
import { Backend } from "omamail-native";
import { aiSettings } from "../assistant/settings";
import { importCalendarSettings } from "../calendar/settings";
import { calendarSettings } from "../calendar/settings";
import { composeHost, setComposeHost } from "../../mail/compose/host";
import { listStore } from "../list/store";
import { readerPrefs } from "../reader/prefs";
import { isOmarchyDesktop, setThemeMode, type ThemeMode } from "../../ui";
import * as Model from "./model";

const KEY = "omamail.settings";

const settingsSignal = signal<Model.Settings>({ ...Model.DEFAULTS });
let loaded = false;
let loading: Promise<void> | null = null;
let changedBeforeLoad = false;

let previewing = false;

function persist() {
  if (previewing) return;
  Storage.setItem(KEY, JSON.stringify(untracked(() => settingsSignal()))).catch(() => {});
}

/** The Theme setting goes to the ui layer's theme (src/ui/theme.ts), which draws the palette. */
function applyAppearance(mode: Model.Appearance) {
  setThemeMode(mode.toLowerCase() as ThemeMode);
}

/**
 * Where the app runs, for the defaults and the appearance migration. Read
 * when the stored settings arrive: the ui layer has read Omarchy's shell
 * settings at mount by then (followOmarchyFont).
 */
function platform(): Model.Platform {
  return { omarchy: untracked(() => isOmarchyDesktop()) };
}

let hostWired = false;

/**
 * plugin-settings.json (the Omarchy plugin's settings, handed over once by
 * its notice widget) through the native read-only config; null when absent,
 * refused or malformed. Preferences only: nothing in it is a credential, and
 * no credential is read from it.
 */
function readPluginExport(): Record<string, unknown> | null {
  try {
    return Model.pluginExport(Backend.readConfig("plugin-settings.json"));
  } catch {
    return null;
  }
}

/** The plugin's keys that other features own, handed to their own setters (which validate them). */
function importOwnedKeys(raw: Record<string, unknown>) {
  if (typeof raw.aiAgent === "string") aiSettings.setAgent(raw.aiAgent);
  if (typeof raw.aiModel === "string" && raw.aiModel.trim() !== "") aiSettings.setModel(raw.aiModel);
  // The calendar's keys go through the calendar's own import, which applies
  // them only when it has stored nothing of its own.
  importCalendarSettings(raw);
}

/** Hands the values other features follow to their owners' own entry points. */
function push(value: Model.Settings) {
  listStore.configure({
    pageSize: value.maxMessages,
    refreshIntervalSec: value.refreshIntervalSec,
    notifyNewMail: value.notifyNewMail !== "Off",
    defaultQuery: value.defaultQuery,
  });
  // Compose asks its host for the undo window: the current host is extended
  // with it, keeping every other answer it gives.
  if (!hostWired) {
    hostWired = true;
    const host = composeHost();
    if (!host.undoSendSeconds) setComposeHost({ ...host, undoSendSeconds: () => untracked(() => settingsSignal()).undoSendSeconds });
  }
}

function patch(next: Partial<Model.Settings>) {
  const current = untracked(() => settingsSignal());
  const merged = Model.normalizeSettings({ ...current, ...next }, platform());
  if (JSON.stringify(merged) === JSON.stringify(current)) return;
  if (!loaded) changedBeforeLoad = true;
  settingsSignal.set(merged);
  if (merged.appearance !== current.appearance) applyAppearance(merged.appearance);
  push(merged);
  persist();
}

const get = <K extends keyof Model.Settings>(key: K) => () => settingsSignal()[key];

export const settings = {
  /** Fixtures only: the defaults (with `values`), loaded from no storage and no config file. */
  preview(values: Partial<Model.Settings> = {}) {
    previewing = true;
    loaded = true;
    loading = Promise.resolve();
    const next = Model.normalizeSettings({ ...Model.DEFAULTS, ...values }, platform());
    settingsSignal.set(next);
    applyAppearance(next.appearance);
    push(next);
  },
  /** Reads the stored settings once; later calls share the first. A change made before the read lands wins. */
  load(): Promise<void> {
    if (loaded) return Promise.resolve();
    if (!loading) {
      loading = Storage.getItem(KEY)
        .then((text) => {
          loaded = true;
          if (changedBeforeLoad) {
            push(untracked(() => settingsSignal()));
            return;
          }
          let raw: unknown = null;
          try {
            raw = text ? JSON.parse(text) : null;
          } catch {
            raw = null;
          }
          // A first run takes the Omarchy plugin's settings once: stored, the
          // app's own copy wins from then on.
          const exported = text ? null : readPluginExport();
          const imported = exported ? Model.normalizeSettings(exported, platform()) : null;
          const next = imported ?? Model.normalizeSettings(raw, platform());
          settingsSignal.set(next);
          applyAppearance(next.appearance);
          push(next);
          if (exported) {
            persist();
            importOwnedKeys(exported);
          } else if (Model.needsAppearanceMigration(raw)) {
            // A version 1 record, migrated once (model.ts storedAppearance).
            persist();
          }
        })
        .catch(() => {
          loaded = true;
        });
      void readerPrefs.load();
    }
    return loading;
  },
  all: () => settingsSignal(),

  refreshIntervalSec: get("refreshIntervalSec"),
  maxMessages: get("maxMessages"),
  heavyMessageRendering: get("heavyMessageRendering"),
  alwaysRenderHeavyMessages: () => settingsSignal().heavyMessageRendering === Model.HEAVY_ALWAYS,
  contentDirection: get("contentDirection"),
  appearance: get("appearance"),
  defaultQuery: get("defaultQuery"),
  notifyNewMail: () => settingsSignal().notifyNewMail !== "Off",
  oauthPort: get("oauthPort"),
  undoSendSeconds: get("undoSendSeconds"),
  showBarIcon: get("showBarIcon"),
  unifiedMailboxes: get("unifiedMailboxes"),
  suggestEvents: get("suggestEvents"),

  // The AI agent and model, one owner (src/features/assistant/settings.ts).
  aiAgent: () => aiSettings.agent(),
  aiModel: () => aiSettings.model(),
  setAgent(agent: string) {
    if (aiSettings.agent() === agent) return;
    aiSettings.setAgent(agent);
    // A new agent starts a new chat, as Qt's `resetChat` did.
    aiSettings.resetChats();
  },
  /** False with nothing changed when the id is not a model id. */
  setModel(model: string): boolean {
    const value = String(model || "").trim();
    if (aiSettings.model() === value) return true;
    if (!aiSettings.setModel(value)) return false;
    aiSettings.resetChats();
    return true;
  },

  // The calendar's settings, one owner (src/features/calendar/settings.ts).
  unifiedCalendarView: () => calendarSettings.unified(),
  calendarRemindersEnabled: () => calendarSettings.remindersEnabled(),
  calendarSnoozeMinutes: () => calendarSettings.snoozeMinutes(),

  // The reader's preferences, one owner (src/features/reader/prefs.ts).
  bodyMode: () => readerPrefs.bodyMode(),
  bodyZoom: () => readerPrefs.zoom(),
  alwaysShowImages: () => readerPrefs.alwaysShowImages(),
  setBodyMode: (mode: Parameters<typeof readerPrefs.setBodyMode>[0]) => readerPrefs.setBodyMode(mode),
  setBodyZoom: (zoom: number) => {
    const target = Model.clampZoom(zoom);
    const current = readerPrefs.zoom();
    if (target !== current) readerPrefs.zoomBy(target - current);
  },
  resetBodyZoom: () => readerPrefs.resetZoom(),
  setAlwaysShowImages: (value: boolean) => readerPrefs.setAlwaysShowImages(value),

  set<K extends keyof Model.Settings>(key: K, value: Model.Settings[K]) {
    patch({ [key]: value } as Partial<Model.Settings>);
  },
  setAppearance(mode: Model.Appearance) {
    patch({ appearance: mode });
  },
  setNotifyNewMail(on: boolean) {
    patch({ notifyNewMail: on ? "On" : "Off" });
  },
  setAlwaysRenderHeavy(on: boolean) {
    patch({ heavyMessageRendering: on ? Model.HEAVY_ALWAYS : Model.HEAVY_DEFAULT });
  },
};

/** For tests: the defaults, unread. */
export function resetSettingsForTests(): void {
  settingsSignal.set({ ...Model.DEFAULTS });
  loaded = false;
  loading = null;
  changedBeforeLoad = false;
}
