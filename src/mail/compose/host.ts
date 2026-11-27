// What compose needs from the mailbox that owns a draft: its provider, its
// From addresses, its sign-off, and the provider calls that save a draft and
// read an original's parts. The accounts feature owns the mailbox hosts; it
// can hand compose its own with `setComposeHost`. Until it does, the default
// here reads the saved account registry and speaks to each provider with the
// same methods and parameters as the Qt clients (providers/*Client.qml).
//
// Every provider call names the account it is for. A draft is never saved or
// sent through a mailbox other than the one that owns it.
import { call as backendCall, on as backendOn } from "../../backend/client";
import type { SendIdentity } from "./senders";

/**
 * How compose reaches the mail backend: the real client by default. A
 * preview or fixture swaps in a synthetic one (`setComposeRpc`) so it never
 * reads this machine's configuration, accounts or mail.
 */
export interface ComposeRpc {
  call<T = any>(method: string, params?: object): Promise<T>;
  on(method: string, listener: (params: any) => void): () => void;
}

let rpc: ComposeRpc = { call: backendCall, on: backendOn };

/** Replaces the backend compose talks to (fixtures and previews only). */
export function setComposeRpc(next: ComposeRpc) {
  rpc = next;
}

/** The backend compose talks to now. */
export function composeRpc(): ComposeRpc {
  return rpc;
}

function call<T = any>(method: string, params?: object): Promise<T> {
  return rpc.call<T>(method, params);
}

export interface Alias {
  email: string;
  displayName?: string;
  isDefault?: boolean;
  isPrimary?: boolean;
}

export interface Signature {
  text: string;
  html: string;
}

/** A message being answered or forwarded, as `message.prepare` gives it. */
export interface PreparedMessage {
  summary: any;
  body: string;
  attachments: any[];
}

export interface ComposeHost {
  /** The provider id the outbox and the draft calls use (`gmail`, `imap`, `outlook`, `m365`, `jmap`, `hey`). */
  providerFor(accountId: string): string;
  /** The account's own address, for a Message-ID and reply addressing. */
  ownAddressFor(accountId: string): string;
  /** The addresses it may send as. */
  aliasesFor(accountId: string): Alias[];
  signatureFor(accountId: string): Signature;
  /** Every From row across signed-in mailboxes (`account.identities`). */
  identities(): Promise<SendIdentity[]>;
  /** Saves a `message.compose` payload as the provider's draft. */
  saveDraft(accountId: string, payload: Record<string, any>): Promise<any>;
  /** The base64 bytes of an original's part. */
  attachment(accountId: string, messageId: string, attachmentId: string): Promise<string>;
  /** An original, read for a reply or forward the caller did not hand over. */
  readMessage?(accountId: string, messageId: string): Promise<PreparedMessage>;
  /** The delay the user set for undo send, in seconds. */
  undoSendSeconds?(): number;
}

interface RegistryAccount {
  id?: string;
  email?: string;
  provider?: string;
  label?: string;
  senderName?: string;
  signature?: string;
  signatureHtml?: string;
  aliases?: unknown;
}

let registry: RegistryAccount[] = [];
let loaded: Promise<void> | null = null;

/** Reads the saved accounts (signatures, names) once; `refresh` reads again. */
export function loadRegistry(refresh = false): Promise<void> {
  if (loaded && !refresh) return loaded;
  loaded = call<{ registry?: { accounts?: RegistryAccount[] } }>("accounts.read", {})
    .then((result) => {
      registry = Array.isArray(result?.registry?.accounts) ? result.registry!.accounts! : [];
    })
    .catch(() => {
      loaded = null;
    });
  return loaded ?? Promise.resolve();
}

function entry(accountId: string): RegistryAccount | undefined {
  return registry.find((a) => String(a.id || "") === accountId);
}

function str(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

/** The client a provider id is served by (MailAccount.qml: outlook speaks IMAP, "" is Gmail). */
export function clientFor(provider: string): "gmail" | "imap" | "jmap" | "m365" | "hey" {
  const id = str(provider).toLowerCase();
  if (id === "imap" || id === "outlook") return "imap";
  if (id === "jmap" || id === "m365" || id === "hey") return id;
  return "gmail";
}

/** The parameters a provider's draft save takes, from a composed payload (providers/*Client.qml). */
export function draftRequest(provider: string, payload: Record<string, any>): { method: string; params: Record<string, unknown> } {
  const source = payload || {};
  switch (clientFor(provider)) {
    case "imap":
      return { method: "imap.saveDraft", params: { raw: str(source.raw), draftId: str(source.draftId) } };
    case "m365":
      return { method: "m365.saveDraft", params: { raw: str(source.raw), draftId: str(source.draftId) } };
    case "jmap":
      return { method: "jmap.saveDraft", params: { ...source } };
    case "hey":
      return {
        method: "hey.saveDraft",
        params: {
          raw: str(source.raw),
          threadId: str(source.threadId),
          attachments: Array.isArray(source.attachments) ? source.attachments : [],
          draftId: str(source.draftId),
        },
      };
    default: {
      // GmailApi.sendBody: the raw message and its thread; an id updates in place.
      const body: Record<string, unknown> = { raw: str(source.raw) };
      if (source.threadId) body.threadId = str(source.threadId);
      const id = str(source.draftId);
      if (id !== "") return { method: "gmail.updateDraft", params: { ...body, id } };
      return { method: "gmail.saveDraft", params: body };
    }
  }
}

/** The parameters a provider's part read takes. */
export function attachmentRequest(provider: string, messageId: string, attachmentId: string) {
  const client = clientFor(provider);
  if (client === "hey") return null;
  if (client === "jmap") return { method: "jmap.attachment", params: { attachmentId: str(attachmentId) } };
  return { method: `${client}.attachment`, params: { messageId: str(messageId), attachmentId: str(attachmentId) } };
}

let accountsSource: () => { id: string; email: string; provider: string; label: string }[] = () => [];

/** The app's account list, for the default host (set by the compose store). */
export function setAccountsSource(read: typeof accountsSource) {
  accountsSource = read;
}

function account(accountId: string) {
  return accountsSource().find((a) => a.id === accountId);
}

export const defaultHost: ComposeHost = {
  providerFor(accountId) {
    return str(account(accountId)?.provider ?? entry(accountId)?.provider);
  },
  ownAddressFor(accountId) {
    return str(account(accountId)?.email ?? entry(accountId)?.email);
  },
  aliasesFor(accountId) {
    const saved = entry(accountId);
    const listed = Array.isArray(saved?.aliases) ? (saved!.aliases as Alias[]) : [];
    const own = this.ownAddressFor(accountId);
    const name = str(saved?.senderName);
    const out: Alias[] = own ? [{ email: own, displayName: name, isPrimary: true }] : [];
    for (const alias of listed) {
      const email = str(alias && (alias as Alias).email).trim();
      if (email && !out.some((a) => a.email.toLowerCase() === email.toLowerCase())) {
        out.push({ email, displayName: str((alias as Alias).displayName), isDefault: (alias as Alias).isDefault === true });
      }
    }
    return out;
  },
  signatureFor(accountId) {
    const saved = entry(accountId);
    return { text: str(saved?.signature), html: str(saved?.signatureHtml) };
  },
  async identities() {
    await loadRegistry();
    const mailboxes = accountsSource().map((a) => ({
      id: a.id,
      email: a.email,
      label: a.label,
      ready: true,
      canSend: true,
      aliases: this.aliasesFor(a.id),
    }));
    const result = await call<{ identities?: SendIdentity[] }>("account.identities", { mailboxes });
    return Array.isArray(result?.identities) ? result.identities : [];
  },
  saveDraft(accountId, payload) {
    const { method, params } = draftRequest(this.providerFor(accountId), payload);
    return call(method, { ...params, accountId });
  },
  async attachment(accountId, messageId, attachmentId) {
    const request = attachmentRequest(this.providerFor(accountId), messageId, attachmentId);
    if (!request) throw new Error("HEY serves attachments through `hey attachments`, which this cannot read yet");
    const result = await call<{ data?: string }>(request.method, { ...request.params, accountId });
    return str(result?.data);
  },
  async readMessage(accountId, messageId) {
    const client = clientFor(this.providerFor(accountId));
    let message: unknown;
    if (client === "gmail" || client === "jmap") {
      message = await call(`${client}.read`, { id: messageId, full: true, accountId });
    } else if (client === "imap" || client === "m365") {
      const result = await call<any>(`${client}.messages`, { ids: [messageId], full: true, accountId });
      message = Array.isArray(result) ? result[0] : Array.isArray(result?.messages) ? result.messages[0] : null;
    } else {
      throw new Error("That message could not be read");
    }
    if (!message) throw new Error("That message is no longer in the mailbox");
    const prepared = await call<any>("message.prepare", { message });
    return {
      summary: prepared?.summary ?? null,
      body: str(prepared?.body?.text),
      attachments: Array.isArray(prepared?.attachments) ? prepared.attachments : [],
    };
  },
};

let current: ComposeHost = defaultHost;

/** Hands compose the mailbox hosts (the accounts feature). */
export function setComposeHost(host: ComposeHost) {
  current = host;
}

export function composeHost(): ComposeHost {
  return current;
}
