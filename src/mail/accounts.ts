// The account list: every mailbox, what it needs to connect (never its
// secret) and which one is active. Port of account/Accounts.js; the rules
// keep their meaning because the backend reads and writes the same registry
// (accounts.read / accounts.save).
//
// Every function returns a new list and leaves its input alone. An account's
// id is derived from its address and provider, so a row still being filled in
// has the empty id and is a draft (`pending`) until its address is known.
import * as Aliases from "./aliases";

export const VERSION = 1;
export const EMAIL_PATTERN = /^[^\s@]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
/** Every provider an account can name; anything else reads as the default. */
export const PROVIDERS = ["gmail", "outlook", "m365", "hey", "imap", "jmap"] as const;
export type ProviderId = (typeof PROVIDERS)[number];
export const DEFAULT_PROVIDER: ProviderId = "gmail";

export interface ImapSettings {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  username: string;
  aliases: Aliases.Alias[];
  insecure: boolean;
  tenant: string;
  send: string;
}

export interface JmapSettings {
  sessionUrl: string;
  username: string;
  authScheme: "basic" | "bearer";
  accountId: string;
}

export interface Account {
  id: string;
  email: string;
  provider: ProviderId;
  clientId: string;
  clientSecret: string;
  imap: ImapSettings;
  jmap: JmapSettings;
  label: string;
  senderName: string;
  signature: string;
  signatureHtml: string;
  monitored: string[];
  pending: boolean;
}

export interface AccountList {
  version: number;
  accounts: Account[];
  activeId: string;
}

/** What a removal dialog asked about: the row it named, by id and position. */
export interface RemovalRequest {
  id: string;
  email: string;
  index: number;
}

function trimmed(value: unknown): string {
  return String(value === undefined || value === null ? "" : value).trim();
}

function isObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseJson(text: unknown, fallback: any): any {
  try {
    const parsed = JSON.parse(String(text || ""));
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

export function emptyList(): AccountList {
  return { version: VERSION, accounts: [], activeId: "" };
}

export function isSerializedList(text: unknown): boolean {
  const raw = parseJson(text, null);
  return isObject(raw) && Number(raw.version) === VERSION && Array.isArray(raw.accounts);
}

export function isValidEmail(value: unknown): boolean {
  return EMAIL_PATTERN.test(trimmed(value));
}

/** Which calendar service an account's sign-in also reaches. */
export function calendarProvider(raw: Partial<Account> | null | undefined): "google" | "microsoft" | "icloud" | "" {
  const account: any = raw || {};
  const provider = trimmed(account.provider).toLowerCase();
  if (provider === "gmail" || provider === "") return "google";
  if (provider === "outlook" || provider === "m365") return "microsoft";
  if (provider !== "imap") return "";
  const host = trimmed(account.imap && account.imap.imapHost).toLowerCase();
  const email = trimmed(account.email).toLowerCase();
  const domain = email.lastIndexOf("@") >= 0 ? email.substring(email.lastIndexOf("@") + 1) : "";
  return host === "imap.mail.me.com" || ["icloud.com", "me.com", "mac.com"].indexOf(domain) >= 0 ? "icloud" : "";
}

export function normalizeProvider(value: unknown): ProviderId {
  const name = trimmed(value).toLowerCase();
  return (PROVIDERS as readonly string[]).indexOf(name) >= 0 ? (name as ProviderId) : DEFAULT_PROVIDER;
}

/** Gmail's id is the lower-cased address; every other provider's is `<provider>:<address>`. */
export function accountId(email: unknown, provider: unknown): string {
  if (!isValidEmail(email)) return "";
  const address = trimmed(email).toLowerCase();
  const kind = normalizeProvider(provider);
  return kind === DEFAULT_PROVIDER ? address : kind + ":" + address;
}

function portOr(value: unknown, fallback: number): number {
  const port = Math.floor(Number(value));
  if (!isFinite(port) || port < 1 || port > 65535) return fallback;
  return port;
}

export function makeImapSettings(raw: any): ImapSettings {
  const values = raw || {};
  return {
    imapHost: trimmed(values.imapHost),
    imapPort: portOr(values.imapPort, 993),
    smtpHost: trimmed(values.smtpHost),
    smtpPort: portOr(values.smtpPort, 465),
    username: trimmed(values.username),
    aliases: Aliases.parse(values.aliases),
    insecure: values.insecure === true,
    tenant: trimmed(values.tenant),
    send: trimmed(values.send),
  };
}

/** Basic or Bearer and nothing else: anything unrecognised is Basic. */
function jmapScheme(value: unknown): "basic" | "bearer" {
  return trimmed(value).toLowerCase() === "bearer" ? "bearer" : "basic";
}

export function makeJmapSettings(raw: any): JmapSettings {
  const values = raw || {};
  return {
    sessionUrl: trimmed(values.sessionUrl),
    username: trimmed(values.username),
    authScheme: jmapScheme(values.authScheme),
    accountId: trimmed(values.accountId),
  };
}

/** What a JMAP sign-in learned about its server, over what the entry had. */
export function jmapSettingsAfterSignIn(settings: any, result: any): JmapSettings {
  const current = makeJmapSettings(settings);
  const learned = result || {};
  return makeJmapSettings({
    sessionUrl: trimmed(learned.sessionUrl) !== "" ? learned.sessionUrl : current.sessionUrl,
    username: current.username,
    authScheme: trimmed(learned.authScheme) !== "" ? learned.authScheme : current.authScheme,
    accountId: trimmed(learned.accountId) !== "" ? learned.accountId : current.accountId,
  });
}

/** Control characters become spaces: a From name is one line. */
export function senderNameText(value: unknown): string {
  return trimmed(
    String(value === undefined || value === null ? "" : value)
      .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
      .replace(/ {2,}/g, " "),
  );
}

export function idList(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [];
  const out: string[] = [];
  for (const raw of list) {
    const item = trimmed(raw);
    if (item !== "" && out.indexOf(item) < 0) out.push(item);
  }
  return out;
}

export function makeAccount(account: any): Account {
  const raw = account || {};
  const email = trimmed(raw.email);
  const provider = normalizeProvider(raw.provider);
  return {
    id: accountId(email, provider),
    email,
    provider,
    clientId: trimmed(raw.clientId),
    clientSecret: trimmed(raw.clientSecret),
    imap: makeImapSettings(raw.imap),
    jmap: makeJmapSettings(raw.jmap),
    label: trimmed(raw.label),
    senderName: senderNameText(raw.senderName),
    signature: trimmed(raw.signature),
    signatureHtml: trimmed(raw.signatureHtml),
    monitored: idList(raw.monitored),
    pending: raw.pending === true && !isValidEmail(email),
  };
}

/** An IMAP or Outlook row saved without its address takes its login, when that is one. */
export function repairedAddress(entry: any): any {
  const raw = entry || {};
  if (isValidEmail(raw.email)) return raw;
  const provider = normalizeProvider(raw.provider);
  if (provider !== "imap" && provider !== "outlook") return raw;
  const username = trimmed((raw.imap || {}).username);
  if (!isValidEmail(username)) return raw;
  return { ...raw, email: username };
}

export function copyList(list: AccountList | null | undefined): AccountList {
  const source: any = list || emptyList();
  return {
    version: VERSION,
    accounts: Array.isArray(source.accounts) ? source.accounts.slice() : [],
    activeId: String(source.activeId || ""),
  };
}

export function indexOfId(accounts: readonly { id: string }[], id: unknown): number {
  const key = trimmed(id);
  if (!key) return -1;
  for (let i = 0; i < accounts.length; i++) if (accounts[i] && accounts[i].id === key) return i;
  return -1;
}

export function find(list: AccountList, id: unknown): Account | null {
  const source = copyList(list);
  const at = indexOfId(source.accounts, id);
  return at < 0 ? null : source.accounts[at];
}

export function active(list: AccountList): Account | null {
  return find(list, (list || ({} as AccountList)).activeId);
}

export function count(list: AccountList | null | undefined): number {
  return list && Array.isArray(list.accounts) ? list.accounts.length : 0;
}

export function hasSavedAccounts(list: AccountList | null | undefined): boolean {
  const values: any[] = list && Array.isArray(list.accounts) ? list.accounts : [];
  return values.some((entry) => trimmed((entry || {}).id) !== "" || isValidEmail((entry || {}).email));
}

/** What a row is called: its name, else its address's local part. */
export function label(account: Partial<Account> | null | undefined): string {
  const raw: any = account || {};
  const name = trimmed(raw.label);
  if (name) return name;
  const local = trimmed(raw.email).split("@")[0];
  return local || "New account";
}

export function add(list: AccountList, account: any): AccountList {
  const next = copyList(list);
  const entry = makeAccount(account);
  const at = indexOfId(next.accounts, entry.id);
  if (at >= 0) next.accounts[at] = entry;
  else next.accounts.push(entry);
  if (entry.id && indexOfId(next.accounts, next.activeId) < 0) next.activeId = entry.id;
  return next;
}

/** The id `account` would take at `index` when another row already has it; else "". */
export function collidingId(list: AccountList, index: number, account: any): string {
  const entry = makeAccount(account);
  if (!entry.id) return "";
  const other = indexOfId((list || ({} as AccountList)).accounts || [], entry.id);
  const at = Math.floor(Number(index));
  return other >= 0 && other !== at ? entry.id : "";
}

export function replaceAt(list: AccountList, index: number, account: any): AccountList {
  const next = copyList(list);
  const at = Math.floor(Number(index));
  if (!isFinite(at) || at < 0 || at >= next.accounts.length) return next;
  if (collidingId(next, at, account)) return next;
  const entry = makeAccount(account);
  next.accounts[at] = entry;
  if (entry.id && (next.activeId === "" || indexOfId(next.accounts, next.activeId) < 0)) next.activeId = entry.id;
  return next;
}

export function namedIds(list: AccountList | null | undefined): string[] {
  const values: any[] = list && Array.isArray(list.accounts) ? list.accounts : [];
  return values.map((entry) => trimmed((entry || {}).id)).filter((id) => id !== "");
}

export function withoutId(ids: string[], id: string): string[] {
  return (Array.isArray(ids) ? ids : []).filter((value) => value !== id);
}

/** Whether `payload` is missing any of `ids`: what stops a save from dropping a mailbox it did not mean to. */
export function dropsAnyId(ids: string[], payload: AccountList): boolean {
  const kept = namedIds(payload);
  return (Array.isArray(ids) ? ids : []).some((id) => kept.indexOf(id) < 0);
}

function nextActiveId(accounts: Account[], from: number): string {
  for (let i = 0; i < accounts.length; i++) {
    const entry = accounts[(from + i) % accounts.length];
    if (entry && entry.id) return entry.id;
  }
  return "";
}

export function remove(list: AccountList, id: string): AccountList {
  const next = copyList(list);
  const at = indexOfId(next.accounts, id);
  if (at < 0) return next;
  const wasActive = next.accounts[at].id === next.activeId;
  next.accounts.splice(at, 1);
  if (wasActive) next.activeId = nextActiveId(next.accounts, at);
  return next;
}

export function removeAt(list: AccountList, index: number): AccountList {
  const source = copyList(list);
  const at = Math.floor(Number(index));
  if (!isFinite(at) || at < 0 || at >= source.accounts.length) return source;
  const removed = source.accounts[at];
  source.accounts.splice(at, 1);
  if (removed.id !== "" && source.activeId === removed.id) source.activeId = nextActiveId(source.accounts, at);
  return source;
}

/** What a Remove dialog asks about: never the last mailbox, never a draft. */
export function removalRequest(list: AccountList, index: number): RemovalRequest | null {
  const values: any[] = list && Array.isArray(list.accounts) ? list.accounts : [];
  if (values.length <= 1) return null;
  const at = Math.floor(Number(index));
  if (!isFinite(at) || at < 0 || at >= values.length) return null;
  const entry = values[at] || {};
  if (!entry.id) return null;
  return { id: String(entry.id || ""), email: String(entry.email || ""), index: at };
}

/** The row a confirmed request still names, or -1 when the list moved under the dialog. */
export function confirmRemoval(list: AccountList, request: RemovalRequest | null): number {
  if (!request) return -1;
  const values: any[] = list && Array.isArray(list.accounts) ? list.accounts : [];
  const at = Math.floor(Number(request.index));
  if (!isFinite(at) || at < 0 || at >= values.length) return -1;
  const id = String(request.id || "");
  return id !== "" && String((values[at] || {}).id || "") === id ? at : -1;
}

export function discardDraftAt(list: AccountList, index: number): AccountList {
  const source = copyList(list);
  const at = Math.floor(Number(index));
  if (!isFinite(at) || at < 0 || at >= source.accounts.length) return source;
  if (source.accounts[at].pending !== true) return source;
  return removeAt(source, at);
}

function editAt(list: AccountList, id: string, change: (entry: Account) => void): AccountList {
  const next = copyList(list);
  const at = indexOfId(next.accounts, id);
  if (at < 0) return next;
  const entry = makeAccount(next.accounts[at]);
  change(entry);
  next.accounts[at] = entry;
  return next;
}

export function setMonitored(list: AccountList, id: string, labelIds: unknown): AccountList {
  return editAt(list, id, (entry) => (entry.monitored = idList(labelIds)));
}

export function toggleMonitored(list: AccountList, id: string, labelId: string): AccountList {
  const key = trimmed(labelId);
  if (key === "") return copyList(list);
  return editAt(list, id, (entry) => {
    const at = entry.monitored.indexOf(key);
    if (at >= 0) entry.monitored.splice(at, 1);
    else entry.monitored.push(key);
  });
}

export function setLabel(list: AccountList, id: string, text: string): AccountList {
  return editAt(list, id, (entry) => (entry.label = trimmed(text)));
}

/** Only these providers send with a From name the app supplies; the others use the provider's own. */
export function namesSender(provider: unknown): boolean {
  const id = String(provider || "");
  return id === "imap" || id === "outlook";
}

export function setSenderName(list: AccountList, id: string, text: string): AccountList {
  return editAt(list, id, (entry) => (entry.senderName = senderNameText(text)));
}

export function setSignatureHtml(list: AccountList, id: string, html: string): AccountList {
  return editAt(list, id, (entry) => (entry.signatureHtml = trimmed(html)));
}

export function setSignature(list: AccountList, id: string, text: string): AccountList {
  return editAt(list, id, (entry) => (entry.signature = trimmed(text)));
}

export function setActive(list: AccountList, id: string): AccountList {
  const next = copyList(list);
  const at = indexOfId(next.accounts, id);
  if (at >= 0) next.activeId = next.accounts[at].id;
  return next;
}

/** A registry's text to a list: unknown shapes give the empty list, duplicates keep the first. */
export function load(text: unknown): AccountList {
  if (!isSerializedList(text)) return emptyList();
  const raw = parseJson(text, null);
  const next = emptyList();
  for (const item of raw.accounts as unknown[]) {
    if (!isObject(item)) continue;
    const entry = makeAccount(repairedAddress(item));
    if (entry.id && indexOfId(next.accounts, entry.id) >= 0) continue;
    next.accounts.push(entry);
  }
  const wanted = trimmed(raw.activeId).toLowerCase();
  next.activeId = indexOfId(next.accounts, wanted) >= 0 ? wanted : nextActiveId(next.accounts, 0);
  return next;
}

/** Whether a row holds anything worth writing: an id, a server or a client. */
export function carriesData(entry: any): boolean {
  const raw = entry || {};
  if (trimmed(raw.id) !== "") return true;
  const imap = raw.imap || {};
  return (
    trimmed(imap.username) !== "" ||
    trimmed(imap.imapHost) !== "" ||
    trimmed(raw.clientId) !== "" ||
    trimmed(raw.clientSecret) !== ""
  );
}

/** Whether writing `payload` would lose a named mailbox `list` holds. */
export function dropsNamedMailbox(list: AccountList, payload: AccountList): boolean {
  const kept = (payload && payload.accounts) || [];
  return ((list && list.accounts) || []).some((entry) => {
    const id = trimmed((entry || ({} as Account)).id);
    return id !== "" && indexOfId(kept, id) < 0;
  });
}

export function draftCount(list: AccountList): number {
  return ((list && list.accounts) || []).filter((entry) => entry && entry.pending === true).length;
}

/** The rows a save writes: no drafts, nothing empty. */
export function savedOnly(list: AccountList): AccountList {
  const next = copyList(list);
  const kept = next.accounts.filter((entry) => entry && entry.pending !== true && carriesData(entry));
  next.accounts = kept;
  if (indexOfId(kept, next.activeId) < 0) next.activeId = nextActiveId(kept, 0);
  return next;
}

export function serialize(list: AccountList): string {
  return JSON.stringify(copyList(list));
}
