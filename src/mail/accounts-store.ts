// The account registry, in memory: the one list every feature reads, kept in
// step with the backend's `accounts.read` / `accounts.save` and its
// `accounts.changed` notification. Port of the registry half of Service.qml
// (saveAccounts, restoreAccountRegistry, applyAccounts, addAccount,
// configureAccount, nameAccount, removeAccountAt, discardCurrentDraft).
//
// The guards are the Qt client's, for the same reasons: a nameless row is
// working state and is never written; a save that would drop a mailbox it
// did not mean to is refused; a save that arrives while one is running is
// queued, never dropped; reading back our own write changes nothing.
// Secrets never pass through here: only the non-secret registry is saved.
import { batch, computed, signal, untracked } from "nsh";
import { app, type AccountRef } from "../app/store";
import { call, on } from "../backend/client";
import * as Accounts from "./accounts";
import "./accounts-cache";

interface ReadResult {
  revision?: unknown;
  registry?: unknown;
}

const listSignal = signal<Accounts.AccountList>(Accounts.emptyList());
const loadedSignal = signal(false);
/** The draft row the setup form is editing, by position: it has no id yet. -1 for none. */
const draftIndexSignal = signal(-1);
const errorSignal = signal("");

let revision = "";
let reading = false;
let writing = false;
let saveQueued = false;
let saveQueuedAllowDrop = false;
let reloadQueued = false;
let releasedIds: string[] = [];
let lastPersistedIds: string[] = [];
let started = false;

function refsOf(list: Accounts.AccountList): AccountRef[] {
  return list.accounts
    .filter((a) => a.id !== "" && a.pending !== true)
    .map((a) => ({ id: a.id, email: a.email, provider: a.provider, label: Accounts.label(a) }));
}

const listeners = new Set<(accounts: Accounts.Account[]) => void>();

function publish() {
  app.setAccounts(refsOf(listSignal()));
  const accounts = untracked(() => listSignal().accounts);
  for (const listener of listeners) listener(accounts);
}

function setList(next: Accounts.AccountList) {
  listSignal.set(next);
  publish();
}

function apply(raw: string) {
  if (loadedSignal() && !Accounts.isSerializedList(raw)) return;
  let loaded = Accounts.load(raw);
  if (Accounts.count(loaded) === 0)
    loaded = Accounts.add(loaded, { email: "", clientId: "", clientSecret: "", pending: true });
  if (
    loadedSignal() &&
    Accounts.serialize(Accounts.savedOnly(loaded)) === Accounts.serialize(Accounts.savedOnly(listSignal()))
  )
    return;
  if (writing || saveQueued) return;
  batch(() => {
    // An open draft survives an outside edit: it is not on disk to be replaced.
    const draft = draftIndexSignal() >= 0 ? listSignal().accounts[draftIndexSignal()] : null;
    let next = loaded;
    if (draft && draft.pending) {
      next = Accounts.copyList(loaded);
      next.accounts.push(Accounts.makeAccount(draft));
      draftIndexSignal.set(next.accounts.length - 1);
    } else if (draftIndexSignal() >= 0) {
      draftIndexSignal.set(-1);
    }
    loadedSignal.set(true);
    lastPersistedIds = Accounts.namedIds(Accounts.savedOnly(loaded));
    setList(next);
  });
}

async function reload(): Promise<void> {
  if (reading || writing || saveQueued) {
    reloadQueued = true;
    return;
  }
  reading = true;
  let result: ReadResult | null = null;
  let failed = false;
  try {
    result = await call<ReadResult>("accounts.read", {});
  } catch {
    failed = true;
  }
  reading = false;
  const again = reloadQueued;
  reloadQueued = false;
  if (!failed && result && !writing && !saveQueued && (!loadedSignal() || revision !== String(result.revision ?? ""))) {
    revision = String(result.revision ?? "");
    apply(JSON.stringify(result.registry ?? null));
  } else if (failed && !loadedSignal()) {
    // A first-run storage failure still settles on a placeholder, so nothing waits on a read that will not come.
    apply("");
  }
  if (again) void reload();
}

async function save(allowDrop = false): Promise<void> {
  if (!loadedSignal()) return;
  const list = listSignal();
  const writable = Accounts.savedOnly(list);
  if (!Accounts.hasSavedAccounts(writable)) return;
  if (Accounts.dropsNamedMailbox(list, writable)) return;
  if (!allowDrop && Accounts.dropsAnyId(lastPersistedIds, writable)) return;
  if (writing) {
    saveQueued = true;
    if (allowDrop) saveQueuedAllowDrop = true;
    return;
  }
  saveQueued = false;
  saveQueuedAllowDrop = false;
  writing = true;
  const released = releasedIds.slice();
  try {
    const result = await call<{ revision?: unknown }>("accounts.save", {
      registry: writable,
      revision,
      allowDrop,
      releasedIds: released,
    });
    writing = false;
    revision = String(result?.revision ?? "");
    releasedIds = releasedIds.filter((id) => released.indexOf(id) < 0);
    lastPersistedIds = Accounts.namedIds(writable).filter((id) => releasedIds.indexOf(id) < 0);
  } catch {
    writing = false;
    saveQueued = false;
    saveQueuedAllowDrop = false;
    revision = "";
    errorSignal.set("Account changes could not be saved. Reloading saved accounts.");
    app.setNotice("Account changes could not be saved. Reloading saved accounts.");
    void reload();
    return;
  }
  if (saveQueued) void save(saveQueuedAllowDrop);
  else if (reloadQueued) {
    reloadQueued = false;
    void reload();
  }
}

function commit(next: Accounts.AccountList): boolean {
  if (Accounts.serialize(next) === Accounts.serialize(listSignal())) return false;
  setList(next);
  void save();
  return true;
}

function release(id: string) {
  if (id === "") return;
  releasedIds = releasedIds.concat([id]);
  lastPersistedIds = Accounts.withoutId(lastPersistedIds, id);
}

function duplicate(email: string) {
  app.setNotice(email.trim() + " is already added");
}

export const accountsStore = {
  list: () => listSignal(),
  accounts: computed(() => listSignal().accounts),
  /** Saved mailboxes, without setup's working rows. */
  saved: computed(() => listSignal().accounts.filter((a) => a.id !== "" && !a.pending)),
  loaded: () => loadedSignal(),
  draftIndex: () => draftIndexSignal(),
  draft: computed(() => {
    const at = draftIndexSignal();
    return at >= 0 ? listSignal().accounts[at] ?? null : null;
  }),
  error: () => errorSignal(),

  /** Reads the registry once and follows the backend's changes. Safe to call from every page. */
  /** Hears the registry each time it changes, owner-free (a run-long listener); returns its removal. */
  onChange(listener: (accounts: Accounts.Account[]) => void): () => void {
    listeners.add(listener);
    listener(untracked(() => listSignal().accounts));
    return () => listeners.delete(listener);
  },
  start(): void {
    if (started) return;
    started = true;
    on("accounts.changed", (params) => {
      if (params && String(params.revision ?? "") !== revision) void reload();
    });
    void reload();
  },
  reload,

  indexOf(id: string): number {
    return Accounts.indexOfId(listSignal().accounts, id);
  },
  find(id: string): Accounts.Account | null {
    return Accounts.find(listSignal(), id);
  },

  /** Opens a working row for `provider`; it is saved by the first `configure`. Returns its index. */
  addDraft(provider: Accounts.ProviderId): number {
    // One draft at a time: a second Add replaces the first.
    accountsStore.discardDraft();
    const next = Accounts.add(listSignal(), {
      email: "",
      clientId: "",
      clientSecret: "",
      provider,
      pending: true,
    });
    batch(() => {
      // The first-run placeholder is reused rather than stacked under a new row.
      const placeholder = next.accounts.findIndex((a, i) => a.pending && a.id === "" && i < next.accounts.length - 1);
      let list = next;
      if (placeholder >= 0) list = Accounts.removeAt(next, placeholder);
      draftIndexSignal.set(list.accounts.length - 1);
      setList(list);
    });
    return draftIndexSignal();
  },

  /** Back out of Add: the working row goes, nothing is written. */
  discardDraft(): boolean {
    const at = draftIndexSignal();
    if (at < 0) return false;
    const next = Accounts.discardDraftAt(listSignal(), at);
    draftIndexSignal.set(-1);
    if (Accounts.count(next) === Accounts.count(listSignal())) return false;
    setList(next);
    return true;
  },

  /**
   * What a setup form saves: the address and the non-secret configuration,
   * written before the secret is tried. False when it collides with another
   * mailbox; the caller must then not sign in, since the secret belongs to the
   * refused one.
   */
  configure(index: number, values: Partial<Accounts.Account>): boolean {
    const list = listSignal();
    const current = list.accounts[index];
    if (!current) return false;
    const entry: any = { ...current };
    const keys = ["provider", "email", "clientId", "clientSecret", "imap", "jmap", "label", "senderName"] as const;
    for (const key of keys) if ((values as any)[key] !== undefined) entry[key] = (values as any)[key];
    if (Accounts.collidingId(list, index, entry)) {
      duplicate(String(entry.email || ""));
      return false;
    }
    let updated = Accounts.replaceAt(list, index, entry);
    const id = Accounts.accountId(entry.email, entry.provider);
    const isDraft = draftIndexSignal() === index;
    if (id !== "" && isDraft) updated = Accounts.setActive(updated, id);
    const oldId = String(current.id || "");
    batch(() => {
      if (isDraft && id !== "") draftIndexSignal.set(-1);
      if (oldId !== "" && id !== oldId) release(oldId);
      setList(updated);
    });
    void save();
    return true;
  },

  /** The address a provider reported for the row (Gmail and HEY learn theirs at sign-in). */
  name(index: number, email: string): void {
    const accounts = listSignal().accounts;
    const row = accounts[index];
    if (!row) return;
    const named = Accounts.accountId(email, row.provider);
    if (row.id === named || named === "") return;
    release(String(row.id || ""));
    if (accounts.some((other, i) => i !== index && other.id === named)) {
      batch(() => {
        if (draftIndexSignal() === index) draftIndexSignal.set(-1);
        setList(Accounts.removeAt(listSignal(), index));
      });
      void save();
      duplicate(email);
      return;
    }
    let updated = Accounts.replaceAt(listSignal(), index, { ...row, email });
    const isDraft = draftIndexSignal() === index;
    if (isDraft) updated = Accounts.setActive(updated, named);
    batch(() => {
      if (isDraft) draftIndexSignal.set(-1);
      setList(updated);
    });
    void save();
  },

  /** Removes the mailbox at `index` (never the last one: the caller asks `removalRequest` first). */
  removeAt(index: number): void {
    batch(() => {
      draftIndexSignal.set(-1);
      setList(Accounts.removeAt(listSignal(), index));
    });
    void save(true);
  },

  setLabel(id: string, text: string) {
    return commit(Accounts.setLabel(listSignal(), id, text));
  },
  setSenderName(id: string, text: string) {
    return commit(Accounts.setSenderName(listSignal(), id, text));
  },
  setSignature(id: string, text: string) {
    return commit(Accounts.setSignature(listSignal(), id, text));
  },
  setSignatureHtml(id: string, html: string) {
    return commit(Accounts.setSignatureHtml(listSignal(), id, html));
  },
  setActive(id: string) {
    return commit(Accounts.setActive(listSignal(), id));
  },
  setMonitored(id: string, labelIds: string[]) {
    return commit(Accounts.setMonitored(listSignal(), id, labelIds));
  },
  toggleMonitored(id: string, labelId: string) {
    return commit(Accounts.toggleMonitored(listSignal(), id, labelId));
  },
};

/** For tests: the store back to a cold start. */
export function resetAccountsStoreForTests(): void {
  batch(() => {
    listSignal.set(Accounts.emptyList());
    loadedSignal.set(false);
    draftIndexSignal.set(-1);
    errorSignal.set("");
  });
  revision = "";
  reading = writing = saveQueued = saveQueuedAllowDrop = reloadQueued = false;
  releasedIds = [];
  lastPersistedIds = [];
  started = false;
}
