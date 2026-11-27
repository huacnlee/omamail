// Start-up: read the account registry the way the Qt client's
// Service.restoreAccountRegistry does (`accounts.read`), hand the usable
// accounts to the store, and send a first run to setup. The full registry
// (drafts, credentials flow, writes) is the accounts feature's; this only
// decides where the window starts.
import { call } from "../backend/client";
import * as Accounts from "../mail/accounts";
import { app, type AccountRef, type AccountStatus } from "./store";

interface AccountsRead {
  revision?: unknown;
  registry?: unknown;
}

/** The accounts a window can open: those with an address, not drafts. */
export function accountRefs(registry: unknown): { refs: AccountRef[]; activeId: string } {
  const list = Accounts.load(JSON.stringify(registry ?? null));
  const refs = list.accounts
    .filter((a) => a.id !== "" && a.pending !== true)
    .map((a) => {
      const ref: AccountRef = {
        id: a.id,
        email: a.email,
        provider: a.provider,
        label: Accounts.label(a),
        name: String(a.label || ""),
      };
      const host = String(a.imap?.imapHost ?? "").trim();
      if (host !== "") ref.imapHost = host;
      return ref;
    });
  return { refs, activeId: refs.some((r) => r.id === list.activeId) ? list.activeId : "" };
}

let lastRevision: string | null = null;

/** Reads the registry and applies it; with no account, opens setup. A
 * failed read is treated as a first run, as the Qt client did, so the
 * window never waits on a registry that will not come. */
export async function loadAccounts(): Promise<void> {
  let refs: AccountRef[] = [];
  let activeId = "";
  try {
    const result = await call<AccountsRead>("accounts.read", {});
    const revision = String(result?.revision ?? "");
    if (lastRevision !== null && revision === lastRevision && app.accounts().length > 0) return;
    lastRevision = revision;
    ({ refs, activeId } = accountRefs(result?.registry));
  } catch {
    refs = [];
  }
  // The registry says nothing of the sessions; a reload keeps what they reported.
  const known = new Map(app.accounts().map((a) => [a.id, a]));
  refs = refs.map((r) => {
    const before = known.get(r.id);
    if (!before) return r;
    const status: AccountStatus = {};
    if (before.signedIn !== undefined) status.signedIn = before.signedIn;
    if (before.busy !== undefined) status.busy = before.busy;
    if (before.error !== undefined) status.error = before.error;
    return { ...r, ...status };
  });
  app.setAccounts(refs);
  if (refs.length === 0) {
    app.openPage("setup");
    return;
  }
  if (activeId !== "" && refs.length > 1 && app.accountId() === "") app.openAccount(activeId);
  // Leaving the first-run picker once an account exists.
  if (app.showPage() && app.nav()[0]?.kind === "picker") app.resetNav([{ kind: "list" }]);
}
