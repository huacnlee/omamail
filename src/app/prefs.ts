// The window's preferences, in window.json under the Qt client's own keys
// (Service.qml `applyWindowPrefs` / `saveWindowPrefs`, Model.windowPrefs), so a
// Qt user keeps theirs. This module is the file's one owner: the shell, the
// sidebar and the reader read and write these keys only through `prefs`.
//
// The file is owner-only and written through the backend
// (`Backend.writeConfig`). Writes wait for changes to settle (a dragged
// separator or a held zoom key is many values a second), then merge into the
// file as it stands, so a key this build does not know survives.
import { batch, effect, signal, Storage, untracked } from "nsh";
import { Backend } from "omamail-native";
import { bodyModeOf, type BodyMode } from "../mail/message/html";
import { clampZoom, zoomAfterStep } from "../features/settings/model";
import { app } from "./store";

const FILE = "window.json";
const WRITE_DELAY_MS = 300;
/** Where earlier builds of this port kept some of these; adopted once, then removed. */
const LEGACY_READER_KEY = "omamail.reader";
const LEGACY_FOLDERS_KEY = "mailbox.collapsedFolders";

export interface WindowPrefs {
  /** The sidebar folded to its rail. */
  sidebarCollapsed: boolean;
  /** Dragged pane widths in points; 0 is "never dragged", each pane's default. */
  sidebarWidth: number;
  listWidth: number;
  /** Label paths folded shut in the rail ("Archive", "Work/Clients"). */
  collapsedFolders: string[];
  /** The message body's zoom, 1 the default. */
  bodyZoom: number;
  /** How a message is read: rebuilt for reading, the sender's own, or text. */
  bodyMode: BodyMode;
  /** The standing answer to "load remote images". */
  alwaysShowImages: boolean;
  /** The window was open when the app last stopped (the Qt bar plugin reopens it). */
  windowOpen: boolean;
}

export const WINDOW_DEFAULTS: Readonly<WindowPrefs> = {
  sidebarCollapsed: false,
  sidebarWidth: 0,
  listWidth: 0,
  collapsedFolders: [],
  bodyZoom: 1,
  bodyMode: "reader",
  alwaysShowImages: false,
  windowOpen: false,
};

const KEYS = Object.keys(WINDOW_DEFAULTS) as (keyof WindowPrefs)[];

function defaults(): WindowPrefs {
  return { ...WINDOW_DEFAULTS, collapsedFolders: [] };
}

/** A stored pane width: whole points up to 4000, anything else 0 (Model.paneWidth). */
export function paneWidth(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, 4000);
}

/** Non-empty strings, first occurrence kept (Model.stringList). */
export function stringList(value: unknown): string[] {
  const out: string[] = [];
  for (const item of Array.isArray(value) ? value : []) {
    const text = String(item ?? "");
    if (text !== "" && !out.includes(text)) out.push(text);
  }
  return out;
}

function objectOf(raw: unknown): Record<string, unknown> | null {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

/** The file's text (or object) as preferences, every value normalized as
 * Model.windowPrefs does; anything unreadable is the default. */
export function windowPrefs(raw: unknown): WindowPrefs {
  const data = objectOf(raw);
  if (!data) return defaults();
  // An older file said "plain" as plainTextForced.
  const legacy = data.plainTextForced === true ? "plain" : "reader";
  return {
    sidebarCollapsed: data.sidebarCollapsed === true,
    sidebarWidth: paneWidth(data.sidebarWidth),
    listWidth: paneWidth(data.listWidth),
    collapsedFolders: stringList(data.collapsedFolders),
    bodyZoom: clampZoom(data.bodyZoom),
    bodyMode: bodyModeOf(data.bodyMode, legacy),
    alwaysShowImages: data.alwaysShowImages === true,
    windowOpen: data.windowOpen === true,
  };
}

/** Writes every window key into the file's object; other keys stay as they are. */
export function mergeWindowPrefs(file: Record<string, unknown>, value: WindowPrefs): Record<string, unknown> {
  const out: Record<string, unknown> = { ...file };
  for (const key of KEYS) out[key] = key === "collapsedFolders" ? [...value.collapsedFolders] : value[key];
  return out;
}

function same(a: WindowPrefs, b: WindowPrefs): boolean {
  return KEYS.every((key) =>
    key === "collapsedFolders"
      ? a.collapsedFolders.length === b.collapsedFolders.length && a.collapsedFolders.every((p, i) => p === b.collapsedFolders[i])
      : a[key] === b[key]);
}

// ------------------------------------------------------------ the file

/** The file's text. The backend answers at once; a test's stand-in answers
 * with a promise, and both are taken. */
function readFile(): string | null | Promise<string | null> {
  try {
    const result = Backend.readConfig(FILE) as unknown;
    if (result && typeof (result as Promise<unknown>).then === "function") {
      return (result as Promise<unknown>).then((v) => (typeof v === "string" ? v : null), () => null);
    }
    return typeof result === "string" ? result : null;
  } catch {
    return null;
  }
}

const state = signal<WindowPrefs>(defaults());
const loaded = signal(false);
let loading = false;
/** Keys changed before the file was read: the change wins over the file. */
const dirty = new Set<keyof WindowPrefs>();
let timer: ReturnType<typeof setTimeout> | null = null;
let written: WindowPrefs | null = null;
/** Previews and fixtures: values live here only, the file is never read or written. */
let memory = false;

function apply(text: string | null) {
  // A read started before useMemory lands after it: the memory wins.
  if (memory) return;
  const file = objectOf(text) ?? {};
  const stored = windowPrefs(file);
  const current = untracked(() => state());
  const next: WindowPrefs = { ...stored };
  for (const key of dirty) (next as unknown as Record<string, unknown>)[key] = current[key];
  batch(() => {
    state.set(next);
    loaded.set(true);
  });
  written = stored;
  if (dirty.size > 0) save();
  dirty.clear();
  void adoptLegacy(file);
}

/** Values an earlier build kept in Storage, taken where the file has none. */
async function adoptLegacy(file: Record<string, unknown>) {
  try {
    const [reader, folders] = await Promise.all([
      Storage.getItem(LEGACY_READER_KEY).catch(() => null),
      Storage.getItem(LEGACY_FOLDERS_KEY).catch(() => null),
    ]);
    if (memory) return;
    const adopted: Partial<WindowPrefs> = {};
    const old = objectOf(reader);
    if (old) {
      const parsed = windowPrefs(old);
      if (!("bodyMode" in file) && "bodyMode" in old) adopted.bodyMode = parsed.bodyMode;
      if (!("bodyZoom" in file) && "bodyZoom" in old) adopted.bodyZoom = parsed.bodyZoom;
      if (!("alwaysShowImages" in file) && "alwaysShowImages" in old) adopted.alwaysShowImages = parsed.alwaysShowImages;
    }
    if (typeof folders === "string" && !("collapsedFolders" in file)) {
      let list: unknown = null;
      try {
        list = JSON.parse(folders);
      } catch {
        list = null;
      }
      adopted.collapsedFolders = stringList(list);
    }
    if (Object.keys(adopted).length > 0) patch(adopted);
    if (reader !== null) await Storage.removeItem(LEGACY_READER_KEY).catch(() => {});
    if (folders !== null) await Storage.removeItem(LEGACY_FOLDERS_KEY).catch(() => {});
  } catch {
    // Storage that cannot be read holds nothing to adopt.
  }
}

/** Reads the file once; later calls do nothing. Getters show the defaults
 * until it lands, which with the backend is at once. */
function load() {
  if (loading) return;
  loading = true;
  const text = readFile();
  if (typeof text === "string" || text === null) apply(text);
  else void text.then(apply);
}

function save() {
  if (memory) return;
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void (async () => {
      const value = untracked(() => state());
      if (written && same(written, value)) return;
      const file = objectOf(await readFile()) ?? {};
      try {
        await Backend.writeConfig(FILE, JSON.stringify(mergeWindowPrefs(file, value)));
        written = value;
      } catch {
        // A refused write: the window keeps its values for this run, and the
        // next change writes again.
      }
    })();
  }, WRITE_DELAY_MS);
}

function patch(next: Partial<WindowPrefs>) {
  load();
  const current = untracked(() => state());
  const merged = windowPrefs({ ...current, ...next });
  if (same(merged, current)) return;
  const isLoaded = untracked(() => loaded());
  if (!isLoaded) for (const key of Object.keys(next) as (keyof WindowPrefs)[]) dirty.add(key);
  state.set(merged);
  if (isLoaded) save();
}

const read = <K extends keyof WindowPrefs>(key: K) => (): WindowPrefs[K] => {
  load();
  return state()[key];
};

export const prefs = {
  /** Reads window.json now (every getter also reads it on first use). */
  load,
  /**
   * Keeps the preferences in memory from now on: window.json is never read
   * or written, nor Storage's old keys. A preview or fixture calls it on its
   * first line, so nothing it does can touch the user's file. `initial`
   * seeds values (normalized as the file's would be).
   */
  useMemory(initial: Partial<WindowPrefs> = {}) {
    memory = true;
    loading = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    dirty.clear();
    const value = windowPrefs({ ...defaults(), ...initial });
    written = value;
    batch(() => {
      state.set(value);
      loaded.set(true);
    });
  },
  /** True after `useMemory`. */
  inMemory: (): boolean => memory,
  /** The file has been read (reactive). */
  loaded: (): boolean => loaded(),
  all: (): WindowPrefs => {
    load();
    return state();
  },

  sidebarCollapsed: read("sidebarCollapsed"),
  sidebarWidth: read("sidebarWidth"),
  listWidth: read("listWidth"),
  collapsedFolders: read("collapsedFolders"),
  bodyZoom: read("bodyZoom"),
  bodyMode: read("bodyMode"),
  alwaysShowImages: read("alwaysShowImages"),
  windowOpen: read("windowOpen"),

  setSidebarCollapsed(value: boolean) {
    patch({ sidebarCollapsed: value === true });
  },
  setSidebarWidth(width: number) {
    patch({ sidebarWidth: width });
  },
  setListWidth(width: number) {
    patch({ listWidth: width });
  },
  /** Back to the proportional defaults. */
  resetWidths() {
    patch({ sidebarWidth: 0, listWidth: 0 });
  },
  setCollapsedFolders(paths: string[]) {
    patch({ collapsedFolders: stringList(paths) });
  },
  /** Folds `path` shut, or opens it (Service.toggleFolder). */
  toggleFolder(path: string) {
    const key = String(path ?? "");
    if (key === "") return;
    load();
    const list = untracked(() => state()).collapsedFolders;
    prefs.setCollapsedFolders(list.includes(key) ? list.filter((p) => p !== key) : [...list, key]);
  },
  /** Clamped to the zoom range, on its steps. */
  setBodyZoom(zoom: number) {
    patch({ bodyZoom: clampZoom(zoom) });
  },
  /** One zoom step in or out (a positive or negative step, e.g. 0.1). */
  zoomBy(step: number) {
    load();
    prefs.setBodyZoom(zoomAfterStep(untracked(() => state()).bodyZoom, step));
  },
  resetZoom() {
    patch({ bodyZoom: 1 });
  },
  setBodyMode(mode: BodyMode) {
    patch({ bodyMode: bodyModeOf(mode, untracked(() => state()).bodyMode) });
  },
  setAlwaysShowImages(value: boolean) {
    patch({ alwaysShowImages: value === true });
  },
  setWindowOpen(value: boolean) {
    patch({ windowOpen: value === true });
  },
};

/** Keeps the store's folded sidebar and the file in step while the calling
 * component is mounted. Call once, from the shell's body. */
export function persistPrefs(): void {
  load();
  // The file's fold reaches the store once it is read...
  effect(() => {
    if (!loaded()) return;
    const stored = untracked(() => state().sidebarCollapsed);
    untracked(() => app.setSidebarCollapsed(stored));
  });
  // ...and the store's fold reaches the file from then on.
  effect(() => {
    const collapsed = app.sidebarCollapsed();
    if (!untracked(() => loaded())) return;
    untracked(() => prefs.setSidebarCollapsed(collapsed));
  });
}

/** For tests: forget what was read and written. */
export function resetPrefsForTests(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  loading = false;
  memory = false;
  written = null;
  dirty.clear();
  batch(() => {
    state.set(defaults());
    loaded.set(false);
  });
}
