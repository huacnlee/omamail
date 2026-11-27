// The mailbox feature's state: each account's labels and folders, which
// folders are folded, which labels are watched, the inbox counts the rail
// shows, and the label changes (create, rename, move, delete) as
// account/LabelActions.qml made them. One owner: the sidebar mounts
// `useMailboxSync()` once; everything else reads `mailboxStore`.
//
// Every label request names its account by id and checks it still exists
// and is signed in first: an IMAP folder id is a folder name, which another
// account may have too, so the open account is no guide to whose folder was
// meant (App.qml openLabelMenu).
import { batch, cleanup, computed, effect, signal, Storage, untracked } from "nsh";
import { prefs } from "../../app/prefs";
import { app, type AccountRef } from "../../app/store";
import { on } from "../../backend/client";
import {
  labelDelimiter, labelIdOfMailbox, labelMailboxKey, labelNameProblem, labelNestProblem, labelParent,
  labelLeaf, labelPathJoin, migrateMonitoredChanges, monitoredNote, sidebarSlots, toggleId, visibleLabels,
  type Label, type LabelMove, type Slot,
} from "../../mail/labels";
import * as api from "../../mail/labels-api";
import { jmapAbsentMailboxes, m365AbsentMailboxes } from "../../mail/mailboxes-absent";
import { m365Check } from "../../mail/providers/m365-check";
import { capabilities, DEFAULT_PROVIDER, mailboxes, sharedMailboxes, type MailboxEntry } from "../../mail/mailboxes";
import { toast } from "../../ui";
import { setDropSpam } from "./drag";

/** How many rows the Ctrl digits reach: Ctrl+0 is the zoom's (docs/KEYS.md). */
export const SLOT_LIMIT = 9;
const MONITOR_CONCURRENCY = 3;

const KEY_MONITORED = "mailbox.monitored";

const labelsSignal = signal<Record<string, Label[]>>({});
const loadingSignal = signal<Record<string, boolean>>({});
/** A preview's folds; null means the window's (window.json through src/app/prefs.ts, as Service.qml kept them). */
const previewFolds = signal<string[] | null>(null);
/** useMailboxSync has started (never in an offline preview). */
const synced = signal(false);
function folds(): string[] {
  const local = previewFolds();
  if (local !== null) return local;
  // Not before the sidebar's sync has started: module-level computeds run at
  // import, and a preview must be able to seed (offline) before window.json
  // is read.
  return synced() ? prefs.collapsedFolders() : [];
}
const monitoredSignal = signal<Record<string, string[]>>({});
const inboxUnreadSignal = signal<Record<string, number>>({});
const absentSignal = signal<Record<string, string[]>>({});
const slotHintsSignal = signal<boolean>(false);
/** A preview fixture's seeded store: nothing asks the backend or storage. */
let offline = false;

export interface MailboxPreview {
  labels?: Record<string, Label[]>;
  monitored?: Record<string, string[]>;
  collapsedFolders?: string[];
  absent?: Record<string, string[]>;
}

/**
 * Seeds the store for a preview fixture and cuts it off from the backend and
 * storage, so a screenshot shows synthetic accounts only. Call before mount.
 */
export function seedMailboxPreview(seed: MailboxPreview) {
  offline = true;
  batch(() => {
    labelsSignal.set({ ...(seed.labels ?? {}) });
    monitoredSignal.set({ ...(seed.monitored ?? {}) });
    previewFolds.set((seed.collapsedFolders ?? []).slice());
    absentSignal.set({ ...(seed.absent ?? {}) });
  });
}

interface Pending {
  reloading: boolean;
  queued: boolean;
  retried: boolean;
  migrations: LabelMove[];
  followPath: string;
}
const pending = new Map<string, Pending>();
/** The last count each watched label was read at; growth is news only after the first read. */
const seen = new Map<string, number>();

function pendingOf(accountId: string): Pending {
  let p = pending.get(accountId);
  if (!p) pending.set(accountId, (p = { reloading: false, queued: false, retried: false, migrations: [], followPath: "" }));
  return p;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

function note(text: string) {
  app.setNotice(text);
}

function fail(text: string) {
  app.setNotice(text);
  toast({ title: text, kind: "error" });
}

/**
 * The optional rows an account lacks: a Microsoft 365 mailbox's from the
 * accounts feature's mailbox check (`m365Check`, the one m365.verify, as
 * M365Client.qml read auth.checked); a JMAP mailbox's from its labels' state.
 */
function absentOf(account: AccountRef, known: Record<string, string[]>): string[] | null {
  if (account.provider === "m365") return m365AbsentMailboxes(m365Check(account.id));
  return known[account.id] ?? null;
}

function accountById(id: string): AccountRef | null {
  return app.accounts().find((a) => a.id === id) ?? null;
}

/** The account a label change is for, or null with the reason said. */
function owner(accountId: string): AccountRef | null {
  const account = accountById(accountId);
  if (!account) {
    fail("That mailbox is no longer set up, so nothing was changed");
    return null;
  }
  if ((account as { signedIn?: boolean }).signedIn === false) {
    fail("That mailbox is signed out, so nothing was changed");
    return null;
  }
  return account;
}

function persist(key: string, value: unknown) {
  if (offline) return;
  Storage.setItem(key, JSON.stringify(value)).catch(() => {});
}

function setLabels(accountId: string, labels: Label[]) {
  labelsSignal.set({ ...labelsSignal(), [accountId]: labels });
}

function setMonitored(accountId: string, ids: string[]) {
  monitoredSignal.set({ ...monitoredSignal(), [accountId]: ids });
  persist(KEY_MONITORED, monitoredSignal());
}

function labelPathOf(label: Label | null | undefined): string {
  return label ? String(label.name || label.rawName || "") : "";
}

function labelById(accountId: string, id: string): Label | null {
  return (labelsSignal()[accountId] ?? []).find((l) => l.id === id) ?? null;
}

function labelByPath(accountId: string, path: string): Label | null {
  return (labelsSignal()[accountId] ?? []).find((l) => labelPathOf(l) === path) ?? null;
}

function takenProblem(accountId: string, name: string): string {
  return labelByPath(accountId, name) ? `There is already a label named ${name}` : "";
}

/** Reads the account's labels again, one listing at a time, applying queued path changes. */
async function reloadLabels(accountId: string): Promise<void> {
  const account = accountById(accountId);
  if (!account || offline) return;
  const p = pendingOf(accountId);
  if (p.reloading) {
    p.queued = true;
    return;
  }
  p.reloading = true;
  loadingSignal.set({ ...loadingSignal(), [accountId]: true });
  let result: Label[] | null = null;
  let error: unknown = null;
  try {
    result = await api.fetchLabels(account.provider, accountId, (boxes) => mailboxStore.setAbsentMailboxes(accountId, jmapAbsentMailboxes(boxes)));
  } catch (e) {
    error = e;
  }
  p.reloading = false;
  loadingSignal.set({ ...loadingSignal(), [accountId]: false });
  if (p.queued) {
    p.queued = false;
    return reloadLabels(accountId);
  }
  if (!accountById(accountId)) return;
  if (error || !result) {
    p.followPath = "";
    // A listing with nothing to apply fails quietly: the rail keeps what it had.
    if (p.migrations.length > 0 || p.retried) fail(`Could not read the labels back: ${errorText(error)}`);
    if (p.migrations.length > 0 && !p.retried) {
      p.retried = true;
      queueMicrotask(() => void reloadLabels(accountId));
    }
    return;
  }
  p.retried = false;
  const labels = result;
  const moves = p.migrations;
  p.migrations = [];
  batch(() => {
    setLabels(accountId, labels);
    if (moves.length > 0) {
      const watched = monitoredSignal()[accountId] ?? [];
      const next = migrateMonitoredChanges(watched, moves, labels);
      if (next !== watched) setMonitored(accountId, next);
    }
    if (p.followPath !== "") {
      const moved = labels.find((l) => labelPathOf(l) === p.followPath);
      p.followPath = "";
      if (app.accountId() === accountId) app.openMailbox(moved ? labelMailboxKey(moved.id) : "inbox");
    }
  });
  void refreshMonitored(accountId);
}

const monitoring = new Set<string>();

/** Counts each watched label, a few at a time, and says which grew. */
async function refreshMonitored(accountId: string): Promise<void> {
  const account = accountById(accountId);
  const ids = (monitoredSignal()[accountId] ?? []).slice();
  if (!account || offline || ids.length === 0 || monitoring.has(accountId)) return;
  if ((account as { signedIn?: boolean }).signedIn === false) return;
  monitoring.add(accountId);
  const grown: { name: string; delta: number }[] = [];
  const worker = async () => {
    for (let id = ids.shift(); id !== undefined; id = ids.shift()) {
      const counts = await api.fetchLabelCounts(account.provider, accountId, id).catch(() => null);
      if (!counts) continue;
      const list = labelsSignal()[accountId] ?? [];
      const at = list.findIndex((l) => l.id === id);
      if (at < 0) continue;
      const before = Math.max(0, Math.floor(Number(list[at].unread) || 0));
      const updated = { ...list[at], unread: counts.unread, total: counts.total };
      setLabels(accountId, list.map((l, i) => (i === at ? updated : l)));
      const key = `${accountId}\u0000${id}`;
      if (counts.unread > before && seen.has(key)) grown.push({ name: String(updated.name || id), delta: counts.unread - before });
      seen.set(key, counts.unread);
    }
  };
  await Promise.all(Array.from({ length: MONITOR_CONCURRENCY }, worker));
  monitoring.delete(accountId);
  if (grown.length > 0) note(monitoredNote(grown));
}

function afterLabelMoved(accountId: string, label: Label, newPath: string, before: Label[]) {
  const p = pendingOf(accountId);
  const wasOpen = app.accountId() === accountId && labelIdOfMailbox(app.mailbox()) === label.id;
  p.followPath = wasOpen ? newPath : "";
  p.migrations = p.migrations.concat([{ before, oldPath: labelPathOf(label), newPath, delimiter: labelDelimiter(label) }]);
  void reloadLabels(accountId);
}

function canManage(account: AccountRef): boolean {
  return capabilities(account.provider).manageLabels;
}

const openLabels = computed<Label[]>(() => (app.unified() ? [] : labelsSignal()[app.accountId()] ?? []));
const openMailboxes = computed<MailboxEntry[]>(() => {
  const absent = (a: AccountRef) => absentOf(a, absentSignal());
  if (app.unified()) return sharedMailboxes(app.accounts().map((a) => mailboxes(a.provider, absent(a))));
  const account = app.account();
  return mailboxes(account ? account.provider : DEFAULT_PROVIDER, account ? absent(account) : null);
});
const shownLabels = computed<Label[]>(() => visibleLabels(openLabels(), folds()));
const slots = computed<Slot[]>(() => sidebarSlots(openMailboxes(), shownLabels(), SLOT_LIMIT));

export const mailboxStore = {
  /** The open account's labels; none in the combined view. */
  labels: openLabels,
  labelsOf: (accountId: string): Label[] => labelsSignal()[accountId] ?? [],
  loading: (accountId: string) => !!loadingSignal()[accountId],
  collapsedFolders: () => folds(),
  /** Labels the open view shows: the account's, unless the combined view (no labels there). */
  hasLabels: computed(() => {
    const account = app.account();
    return !app.unified() && !!account && (capabilities(account.provider).labels || capabilities(account.provider).move || labelsSignal()[account.id]?.length > 0);
  }),
  /** The mailbox rows of the open view: the account's, or the rows every account shares. */
  mailboxes: openMailboxes,
  /** The labels in the rail's order with folded rows left out: what the digits number. */
  visibleLabels: shownLabels,
  /** One numbered list over the rail, Ctrl+1 to Ctrl+9. */
  slots,
  /** The digits show on the rows (the shell sets this while Ctrl is held). */
  slotHintsVisible: () => slotHintsSignal(),
  setSlotHintsVisible(visible: boolean) {
    slotHintsSignal.set(visible);
  },
  /** Opens the row `index` (0-based: Ctrl+1 is 0). False when there is none. */
  goSlot(index: number): boolean {
    const slot = untracked(() => slots())[index];
    if (!slot) return false;
    if (slot.kind === "mailbox") {
      app.search("");
      app.openMailbox(slot.key);
    } else mailboxStore.selectLabel(slot.id);
    return true;
  },
  /** Opens a label's list; labels belong to one account, so not in the combined view. */
  selectLabel(id: string): boolean {
    if (app.unified() || id === "") return false;
    app.search("");
    app.openMailbox(labelMailboxKey(id));
    return true;
  },
  toggleFolder(path: string) {
    if (offline) previewFolds.set(toggleId(previewFolds() ?? [], path));
    else prefs.toggleFolder(path);
  },
  monitored: (accountId: string): string[] => monitoredSignal()[accountId] ?? [],
  isMonitored: (accountId: string, labelId: string) => (monitoredSignal()[accountId] ?? []).indexOf(labelId) >= 0,
  toggleMonitored(accountId: string, labelId: string) {
    if (!owner(accountId)) return;
    const next = toggleId(monitoredSignal()[accountId] ?? [], labelId);
    setMonitored(accountId, next);
    if (next.indexOf(labelId) >= 0) {
      const label = labelById(accountId, labelId);
      note(`Watching ${labelPathOf(label) || labelId} for new mail`);
      void refreshMonitored(accountId);
    } else seen.delete(`${accountId}\u0000${labelId}`);
  },
  /** The inbox's unread count, as the list reported it (or the Inbox label's). */
  inboxUnread(accountId: string): number {
    const reported = inboxUnreadSignal()[accountId];
    if (reported !== undefined) return reported;
    const inbox = (labelsSignal()[accountId] ?? []).find((l) => String(l.id).toUpperCase() === "INBOX");
    return inbox ? Math.max(0, Math.floor(Number(inbox.unread) || 0)) : 0;
  },
  /** For whoever reads the inbox: its unread count, shown on the rail and the tabs. */
  setInboxUnread(accountId: string, count: number) {
    inboxUnreadSignal.set({ ...inboxUnreadSignal(), [accountId]: Math.max(0, Math.floor(Number(count) || 0)) });
  },
  /** The optional mailboxes this account's server does not have (null: not known, every row drawn). */
  setAbsentMailboxes(accountId: string, keys: string[] | null) {
    const next = { ...absentSignal() };
    if (keys) next[accountId] = keys.slice();
    else delete next[accountId];
    absentSignal.set(next);
  },
  canManage(accountId: string): boolean {
    const account = accountById(accountId);
    return !!account && canManage(account);
  },
  reloadLabels,
  labelById,
  labelPathOf,

  /** Creates `leaf` under `parentPath` ("" for the top level). False when refused before asking. */
  createLabel(accountId: string, parentPath: string, leaf: string): boolean {
    const account = owner(accountId);
    if (!account || !canManage(account)) return false;
    const labels = labelsSignal()[accountId] ?? [];
    const delimiter = labelDelimiter(labelByPath(accountId, parentPath) ?? labels[0] ?? null);
    const name = labelPathJoin(parentPath, leaf, delimiter);
    const problem = labelNestProblem(parentPath, delimiter) || labelNameProblem(leaf, delimiter) || takenProblem(accountId, name);
    if (problem !== "") {
      fail(problem);
      return false;
    }
    api.createLabel(account.provider, accountId, name).then(
      () => {
        note(`Created ${name}`);
        void reloadLabels(accountId);
      },
      (error) => fail(`Could not create ${name}: ${errorText(error)}`),
    );
    return true;
  },

  /** Renames a label within its parent; the labels beneath it move with it. */
  renameLabel(accountId: string, id: string, leaf: string): boolean {
    const account = owner(accountId);
    const label = labelById(accountId, id);
    if (!account || !canManage(account) || !label) return false;
    const delimiter = labelDelimiter(label);
    let problem = labelNameProblem(leaf, delimiter);
    if (problem !== "") {
      fail(problem);
      return false;
    }
    const path = labelPathOf(label);
    const name = labelPathJoin(labelParent(path, delimiter), leaf, delimiter);
    if (name === path) return false;
    problem = takenProblem(accountId, name);
    if (problem !== "") {
      fail(problem);
      return false;
    }
    const before = labelsSignal()[accountId] ?? [];
    api.renameLabel(account.provider, accountId, label.id, name).then(
      () => {
        note(`Renamed to ${name}`);
        afterLabelMoved(accountId, label, name, before);
      },
      (error) => fail(`Could not rename ${path}: ${errorText(error)}`),
    );
    return true;
  },

  /** Moves a label under `newParentPath` ("" for the top level). */
  moveLabel(accountId: string, id: string, newParentPath: string): boolean {
    const account = owner(accountId);
    const label = labelById(accountId, id);
    if (!account || !canManage(account) || !label) return false;
    const delimiter = labelDelimiter(label);
    let problem = labelNestProblem(newParentPath, delimiter);
    if (problem !== "") {
      fail(problem);
      return false;
    }
    const path = labelPathOf(label);
    const name = labelPathJoin(newParentPath, labelLeaf(path, delimiter), delimiter);
    if (name === path) return false;
    problem = takenProblem(accountId, name);
    if (problem !== "") {
      fail(problem);
      return false;
    }
    const before = labelsSignal()[accountId] ?? [];
    api.renameLabel(account.provider, accountId, label.id, name).then(
      () => {
        note(`Moved to ${name}`);
        afterLabelMoved(accountId, label, name, before);
      },
      (error) => fail(`Could not move ${path}: ${errorText(error)}`),
    );
    return true;
  },

  /** Deletes a label and every label beneath it on the server. Ask first. */
  deleteLabel(accountId: string, id: string): boolean {
    const account = owner(accountId);
    const label = labelById(accountId, id);
    if (!account || !canManage(account) || !label) return false;
    const path = labelPathOf(label);
    const before = labelsSignal()[accountId] ?? [];
    api.deleteLabel(account.provider, accountId, label.id).then(
      () => {
        note(`Deleted ${path}`);
        if (app.accountId() === accountId && labelIdOfMailbox(app.mailbox()) === label.id) app.openMailbox("inbox");
        const p = pendingOf(accountId);
        p.migrations = p.migrations.concat([{ before, oldPath: path, newPath: "", delimiter: labelDelimiter(label) }]);
        void reloadLabels(accountId);
      },
      (error) => fail(`Could not delete ${path}: ${errorText(error)}`),
    );
    return true;
  },
};

function parseJson<T>(text: string | null, fallback: T, valid: (v: unknown) => boolean): T {
  if (!text) return fallback;
  try {
    const value = JSON.parse(text);
    return valid(value) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

const isStringArray = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === "string");

/**
 * Keeps the store in step with the window: restores the saved watches (the
 * shell keeps the collapse and the folds, in window.json), reads each account's labels as it appears, again on
 * the backend's mail updates, and counts watched labels on every poll the backend reports. Mounted
 * once, by the sidebar.
 */
export function useMailboxSync() {
  if (offline) return;
  synced.set(true);
  void (async () => {
    const watched = await Storage.getItem(KEY_MONITORED).catch(() => null);
    monitoredSignal.set(
      parseJson(watched, {} as Record<string, string[]>, (v) =>
        !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v as object).every(isStringArray)),
    );
  })();

  // Each account's labels, read once it appears; an account that went drops its own.
  effect(() => {
    const ids = app.accounts().map((a) => a.id);
    untracked(() => {
      const known = labelsSignal();
      for (const id of ids) if (!(id in known) && !pendingOf(id).reloading) void reloadLabels(id);
      const kept: Record<string, Label[]> = {};
      for (const id of ids) if (known[id]) kept[id] = known[id];
      if (Object.keys(kept).length !== Object.keys(known).length) labelsSignal.set(kept);
      for (const id of Object.keys(absentSignal())) if (ids.indexOf(id) < 0) mailboxStore.setAbsentMailboxes(id, null);
      for (const id of [...pending.keys()]) if (ids.indexOf(id) < 0) pending.delete(id);
    });
  });

  // What the open view's provider can do with a dragged message.
  effect(() => {
    const unified = app.unified();
    const account = app.account();
    setDropSpam(unified ? app.accounts().every((a) => capabilities(a.provider).spam) : !!account && capabilities(account.provider).spam);
  });

  // Becoming the account on screen earns a fresh listing (MailAccount.onActiveChanged).
  effect(() => {
    const id = app.accountId();
    untracked(() => {
      if (id !== "" && accountById(id) && id in labelsSignal()) void reloadLabels(id);
    });
  });

  // The backend's poll tick for an account: its watched labels are counted
  // again, as MailAccount.refresh() did on every tick.
  const off = on("mail.updated", (params: { accountId?: unknown }) => {
    const id = typeof params?.accountId === "string" ? params.accountId : "";
    if (id !== "" && accountById(id)) void refreshMonitored(id);
  });
  cleanup(off);
}
