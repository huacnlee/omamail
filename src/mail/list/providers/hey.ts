// HEY for the list (HeyClient.qml): verbs, and a listing that carries every
// row's resource, so reading is the cache. Needs the CLI path from sign-in.
import { errorCode, labelChangesFor, pageOf, pageSize, sentenceFor, type MailClient, type ProviderContext, type Rpc } from "./shared";

/** HEY's verbs for the label pairs the list speaks (HeyCli.verbForLabels). */
export function heyVerbFor(action: string): string {
  if (action === "trash" || action === "untrash") return action;
  const change = labelChangesFor(action);
  if (!change) return "";
  if (change.remove.includes("UNREAD")) return "markRead";
  if (change.add.includes("UNREAD")) return "markUnread";
  if (change.add.includes("SPAM")) return "spam";
  return "";
}

/** HEY's listing carries every row's resource, so reading is the cache. */
export function heyClient(rpc: Rpc, accountId: string, context: () => ProviderContext): MailClient {
  const resources = new Map<string, any>();
  const params = (extra: object) => {
    const program = String(context().heyProgram ?? "");
    if (program === "") throw new Error("Sign in to the configured HEY account first");
    return { ...extra, accountId, program };
  };
  return {
    provider: "hey",
    async list(query, limit, pageToken) {
      const result: any = await rpc.call("hey.list", params({ query: String(query ?? ""), pageToken: String(pageToken ?? ""), pageSize: pageSize(limit) }));
      const messages: any[] = Array.isArray(result?.messages) ? result.messages : [];
      for (const message of messages) if (message && message.id != null) resources.set(String(message.id), message);
      const page = pageOf(result);
      if (page.ids.length === 0 && messages.length > 0) page.ids = messages.map((m) => String(m.id));
      return page;
    },
    async read(ids) {
      const out = ids.map((id) => resources.get(String(id))).filter((m) => !!m);
      return { messages: out, warning: out.length > 0 || ids.length === 0 ? "" : "Those messages are no longer in the mailbox" };
    },
    async act(action, ids) {
      const verb = heyVerbFor(action);
      if (verb === "") return { failedIds: [], error: "" };
      try {
        await rpc.call("hey.act", params({ verb, ids }));
        if (verb === "markRead" || verb === "markUnread") {
          for (const id of ids) {
            const known = resources.get(String(id));
            if (!known) continue;
            const labels = (Array.isArray(known.labelIds) ? known.labelIds : []).filter((l: string) => l !== "UNREAD");
            if (verb === "markUnread") labels.push("UNREAD");
            resources.set(String(id), { ...known, labelIds: labels });
          }
        }
        return { failedIds: [], error: "" };
      } catch (e) {
        const code = errorCode(e);
        return { failedIds: ids.slice(), error: code.startsWith("Sign in") ? code : sentenceFor("hey", e) };
      }
    },
    cancel() {},
  };
}

/** The client for one account's provider. */
