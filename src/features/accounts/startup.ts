// What the accounts feature sets up once per run, from the shell's start
// (`startAccounts`): the live registry, each HEY mailbox's CLI path for the
// list, and compose's view of a mailbox (its provider, address, send-as
// addresses and signature) read from the registry as it stands, so a
// signature edited in Settings is what the next draft carries.
import { untracked } from "nsh";
import * as Accounts from "../../mail/accounts";
import { accountsStore } from "../../mail/accounts-store";
import { composeHost, setComposeHost, type Alias, type ComposeHost } from "../../mail/compose/host";
import { listStore } from "../list/store";
import { heyProgram } from "./flows";
import { verifyM365Account } from "../../mail/providers/m365-check";

let started = false;

function row(accountId: string): Accounts.Account | null {
  return untracked(() => accountsStore.find(accountId));
}

/** The registry's side of compose's host; the provider calls stay the default host's. */
export function accountsComposeHost(base: ComposeHost): ComposeHost {
  return {
    ...base,
    providerFor(accountId) {
      return row(accountId)?.provider ?? base.providerFor(accountId);
    },
    ownAddressFor(accountId) {
      return row(accountId)?.email ?? base.ownAddressFor(accountId);
    },
    aliasesFor(accountId) {
      const account = row(accountId);
      if (!account) return base.aliasesFor(accountId);
      // MailAccount.qml: the address under the sender's name, then the
      // send-as addresses an IMAP or Outlook mailbox lists in its settings.
      const out: Alias[] = [{ email: account.email, displayName: account.senderName, isPrimary: true }];
      const listed = account.provider === "imap" || account.provider === "outlook" ? account.imap.aliases : [];
      for (const alias of listed) {
        if (out.some((a) => a.email.toLowerCase() === alias.email.toLowerCase())) continue;
        out.push({ email: alias.email, displayName: alias.displayName, isDefault: alias.isDefault });
      }
      return out;
    },
    signatureFor(accountId) {
      const account = row(accountId);
      return account ? { text: account.signature, html: account.signatureHtml } : base.signatureFor(accountId);
    },
  };
}

/** Once per run; later calls do nothing. */
export function startAccounts(): void {
  if (started) return;
  started = true;
  accountsStore.start();

  // Installed over whatever host is current (the settings store's undo window included).
  setComposeHost(accountsComposeHost(composeHost()));

  // A restored Microsoft 365 mailbox is checked once, as M365Auth.check did on restore.
  const checked = new Set<string>();
  accountsStore.onChange((accounts) => {
    for (const account of accounts) {
      if (account.provider !== "m365" || account.id === "" || account.pending || checked.has(account.id)) continue;
      checked.add(account.id);
      void verifyM365Account(account.id).catch(() => {});
    }
  });

  // A HEY mailbox lists through the HEY CLI: the list needs its path.
  let program: Promise<string> | null = null;
  const told = new Set<string>();
  accountsStore.onChange((accounts) => {
    const hey = accounts.filter((a) => a.provider === "hey" && a.id !== "" && !told.has(a.id));
    if (hey.length === 0) return;
    if (!program) program = heyProgram();
    void program.then((path) => {
      if (!path) {
        program = null;
        return;
      }
      for (const account of hey) {
        told.add(account.id);
        listStore.setProviderContext(account.id, { heyProgram: path });
      }
    });
  });
}
