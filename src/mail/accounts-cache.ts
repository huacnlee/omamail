// Each mailbox's query cache belongs to the identity its server reports, as
// in Qt (MailAccount.loadProfile -> cacheStore.bindAccount): binding an
// address empties a cache another address left under this id, so one
// mailbox's rows never show under another's name. A registry address is what
// the user typed and can be wrong or edited later, so Gmail, JMAP and HEY bind
// the address their server answers with; IMAP and Microsoft 365 bind their
// configured address, as Qt's ImapClient and M365Client answered it, with no
// server call. Until a mailbox is bound, its cache is not shown (listCache).
// Signing out or removing a mailbox (by any client) empties its cache.
import { effect, untracked } from "nsh";
import { app, type AccountRef } from "../app/store";
import { call } from "../backend/client";
import { isValidEmail } from "./accounts";
import * as ListCache from "./listCache";

/** The address each id is bound to ("" while its profile is in flight). */
const bound = new Map<string, string>();
/** Every saved mailbox seen, so a removal (here or from another client) empties its cache. */
const known = new Set<string>();
let lastOpened = "";
let sequence = 0;
let heyProgram: Promise<string> | null = null;

function heyPath(): Promise<string> {
  if (!heyProgram) {
    heyProgram = call<{ program?: string }>("hey.probe", {})
      .then((r) => String(r?.program ?? ""))
      .catch((error) => {
        heyProgram = null;
        throw error;
      });
  }
  return heyProgram;
}

/** A server's answer is untrusted: an address or nothing. */
function address(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  return isValidEmail(text) ? text : "";
}

/** The identity the mailbox's server reports ("" when it cannot say now). */
export async function profileAddress(ref: Pick<AccountRef, "id" | "email" | "provider">): Promise<string> {
  const accountId = ref.id;
  switch (ref.provider) {
    case "gmail":
      return address((await call<{ email?: unknown }>("gmail.profile", { accountId }))?.email);
    case "jmap": {
      const requestId = `jmap-${accountId}-${Date.now()}-${++sequence}`;
      return address((await call<{ data?: { email?: unknown } }>("jmap.profile", { accountId, requestId }))?.data?.email);
    }
    case "hey":
      return address((await call<{ email?: unknown }>("hey.profile", { accountId, program: await heyPath() }))?.email);
    default:
      // IMAP, Outlook and Microsoft 365: the configured address (Qt asked no server).
      return address(ref.email);
  }
}

const ASKS_SERVER = ["gmail", "jmap", "hey"];

async function bind(ref: AccountRef): Promise<void> {
  // A configured address binds at once, in the same turn as the registry's load.
  if (!ASKS_SERVER.includes(ref.provider)) {
    const email = address(ref.email);
    if (email === "") return;
    bound.set(ref.id, email.toLowerCase());
    await ListCache.bindAccount(ref.id, email);
    return;
  }
  bound.set(ref.id, "");
  let email = "";
  try {
    email = await profileAddress(ref);
  } catch {
    email = "";
  }
  // Removed or signed out meanwhile: nothing to bind.
  if (!bound.has(ref.id)) return;
  if (email === "") {
    bound.delete(ref.id);
    return;
  }
  bound.set(ref.id, email.toLowerCase());
  await ListCache.bindAccount(ref.id, email);
}

/** Whether the mailbox's cache is bound to its server's identity (listCache shows it only then). */
export function isBound(id: string): boolean {
  return (bound.get(id) ?? "") !== "";
}

/** Signs the cache out with the mailbox: empties it, and binds again on the next sign-in. */
export function forget(id: string): void {
  if (!id) return;
  bound.delete(id);
  void ListCache.clear(id);
}

// Every saved mailbox once it can say who it is (load, reload, add, sign-in);
// the opened one again on each switch (to the address it reported). A failed profile read tries again on
// the next change of the accounts (a sign-in reports one).
effect(() => {
  const refs = app.accounts();
  const opened = app.accountId();
  untracked(() => {
    for (const ref of refs) {
      if (ref.signedIn === false) continue;
      const switched = ref.id === opened && opened !== lastOpened;
      const state = bound.get(ref.id);
      if (state === undefined) void bind(ref);
      // Known already: the switch binds it again without asking the server.
      else if (state !== "" && switched) void ListCache.bindAccount(ref.id, state);
    }
    for (const ref of refs) known.add(ref.id);
    // Removed: its cached mail must never paint again (Qt's reset path).
    for (const id of [...known]) {
      if (refs.some((ref) => ref.id === id)) continue;
      known.delete(id);
      forget(id);
    }
    lastOpened = opened;
  });
});
