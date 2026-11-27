// Gmail for the list (GmailApiClient.qml): gmail.list / gmail.read per id /
// gmail.modify, gmail.batchModify, gmail.trash, gmail.untrash; queued changes
// settle by `gmail.settled`, or fail as lost after 180 s.
import { labelChangesFor, pageOf, pageSize, sentenceFor, type MailClient, type Rpc } from "./shared";

/** Gmail mutations answer `{queued, ticket}` and settle by `gmail.settled`. */
export function gmailClient(rpc: Rpc, accountId: string): MailClient {
  const parked = new Map<string, { resolve: () => void; reject: (code: string) => void; timer: number }>();
  rpc.on("gmail.settled", (params: any) => {
    if (String(params?.accountId ?? accountId) !== accountId) return;
    const entry = parked.get(String(params?.ticket ?? ""));
    if (!entry) return;
    parked.delete(String(params.ticket));
    clearTimeout(entry.timer);
    if (params.ok === true) entry.resolve();
    else entry.reject(String(params.error || "gmail_queue_lost"));
  });
  async function mutate(method: string, params: object): Promise<void> {
    const result: any = await rpc.call(method, { ...params, accountId });
    if (!result || result.queued !== true || String(result.ticket ?? "") === "") return;
    const ticket = String(result.ticket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        parked.delete(ticket);
        reject(new Error("gmail_queue_lost"));
      }, 180000);
      parked.set(ticket, { resolve, reject: (code) => reject(new Error(code)), timer });
    });
  }
  return {
    provider: "gmail",
    async list(query, limit, pageToken) {
      return pageOf(await rpc.call("gmail.list", { query: String(query ?? ""), pageToken: String(pageToken ?? ""), pageSize: pageSize(limit), accountId }));
    },
    async read(ids) {
      let warning = "";
      const answers = await Promise.all(ids.map((id) =>
        rpc.call("gmail.read", { id: String(id), full: false, accountId }).catch((error) => {
          if (!warning) warning = sentenceFor("gmail", error);
          return null;
        })));
      return { messages: answers.filter((m) => !!m), warning };
    },
    async act(action, ids, sourceLabelId = "") {
      const failed: string[] = [];
      let error = "";
      if (action === "trash" || action === "untrash") {
        await Promise.all(ids.map((id) => mutate("gmail." + action, { id: String(id) }).catch((e) => {
          failed.push(id);
          if (!error) error = sentenceFor("gmail", e);
        })));
        return { failedIds: failed, error };
      }
      const change = labelChangesFor(action, sourceLabelId);
      if (!change) return { failedIds: [], error: "" };
      try {
        if (ids.length > 1) await mutate("gmail.batchModify", { ids, addLabelIds: change.add, removeLabelIds: change.remove });
        else await mutate("gmail.modify", { id: String(ids[0] ?? ""), addLabelIds: change.add, removeLabelIds: change.remove });
        return { failedIds: [], error: "" };
      } catch (e) {
        return { failedIds: ids.slice(), error: sentenceFor("gmail", e) };
      }
    },
    cancel() {},
  };
}
