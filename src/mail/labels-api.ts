// The label and folder requests each provider answers, with exactly the
// methods and parameters the Qt provider clients sent
// (omarchy/ui/providers/{GmailApiClient,ImapClient,JmapClient,HeyClient,M365Client}.qml).
// Every call names the account it is for: an IMAP folder id is a folder
// name, which another account may well have too.
import { call } from "../backend/client";
import type { Label } from "./labels";

export interface LabelCounts {
  unread: number;
  total: number;
}

let generation = 0;
const prefix = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);

/** The IMAP read token the backend cancels a read by. */
function imapToken(): string {
  return `${prefix}:${++generation}`;
}

function jmapRequestId(accountId: string): string {
  return `jmap-${accountId}-${Date.now()}-${++generation}`;
}

let heyProgram: Promise<string> | null = null;

/** The HEY executable the backend resolved (`hey.probe`), which every bound HEY read names. */
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

function isImap(provider: string): boolean {
  return provider === "imap" || provider === "outlook";
}

/** Keeps only well-formed rows: the list is the server's, the rail draws it. */
function sanitize(rows: unknown): Label[] {
  if (!Array.isArray(rows)) return [];
  const out: Label[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : "";
    if (id === "") continue;
    out.push({
      ...(r as object),
      id,
      name: typeof r.name === "string" ? r.name : undefined,
      rawName: typeof r.rawName === "string" ? r.rawName : undefined,
      system: r.system === true,
      unread: Math.max(0, Math.floor(Number(r.unread) || 0)),
      total: Math.max(0, Math.floor(Number(r.total) || 0)),
      delimiter: r.delimiter === undefined || r.delimiter === null ? undefined : String(r.delimiter),
    });
  }
  return out;
}

/** The account's labels or folders; an empty list for a provider that has none. */
export async function fetchLabels(provider: string, accountId: string, onJmapMailboxes?: (mailboxes: unknown) => void): Promise<Label[]> {
  if (provider === "gmail") return sanitize(await call("gmail.labels", { accountId }));
  if (isImap(provider)) {
    const result = await call<{ labels?: unknown }>("imap.folders", { refresh: true, accountId, requestToken: imapToken() });
    return sanitize(result?.labels);
  }
  if (provider === "jmap") {
    const result = await call<{ data?: unknown; state?: { mailboxes?: unknown } }>("jmap.labels", { accountId, requestId: jmapRequestId(accountId) });
    // The answer's state carries the account's mailboxes, which say which
    // optional rail rows it has (JmapClient.qml applyState).
    onJmapMailboxes?.(result?.state?.mailboxes ?? []);
    return sanitize(result?.data);
  }
  if (provider === "hey") return sanitize(await call("hey.labels", { accountId, program: await heyPath() }));
  return [];
}

/** One label's counts, for watched labels. */
export async function fetchLabelCounts(provider: string, accountId: string, id: string): Promise<LabelCounts | null> {
  let result: any = null;
  if (provider === "gmail") result = await call("gmail.labelCounts", { id, accountId });
  else if (isImap(provider)) result = await call("imap.count", { labelId: id, accountId, requestToken: imapToken() });
  else if (provider === "jmap") result = (await call<any>("jmap.labelCounts", { id, accountId, requestId: jmapRequestId(accountId) }))?.data;
  else return null;
  if (!result) return null;
  return { unread: Math.max(0, Math.floor(Number(result.unread) || 0)), total: Math.max(0, Math.floor(Number(result.total) || 0)) };
}

/** Refused before any request on a provider whose labels are managed elsewhere. */
export class LabelRefusal extends Error {}

function refuse(provider: string): never {
  throw new LabelRefusal(provider === "hey" ? "HEY labels are managed on HEY" : "This mailbox cannot change its labels here");
}

export async function createLabel(provider: string, accountId: string, name: string): Promise<void> {
  if (provider === "gmail") await call("gmail.createLabel", { name, accountId });
  else if (isImap(provider)) await call("imap.createFolder", { name, accountId });
  else refuse(provider);
}

export async function renameLabel(provider: string, accountId: string, id: string, name: string): Promise<void> {
  if (provider === "gmail") await call("gmail.renameLabel", { id, name, accountId });
  else if (isImap(provider)) await call("imap.renameFolder", { id, name, accountId });
  else refuse(provider);
}

export async function deleteLabel(provider: string, accountId: string, id: string): Promise<void> {
  if (provider === "gmail") await call("gmail.deleteLabel", { id, accountId });
  else if (isImap(provider)) await call("imap.deleteFolder", { id, accountId });
  else refuse(provider);
}
