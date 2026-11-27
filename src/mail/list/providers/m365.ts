// Microsoft 365 over Graph for the list (M365Client.qml); changes may report failedIds.
import { labelChangesFor, nextToken, pageOf, pageSize, sentenceFor, type MailClient, type Rpc } from "./shared";

export function m365Client(rpc: Rpc, accountId: string): MailClient {
  const prefix = "m365-list-" + accountId;
  let tokens: string[] = [];
  async function longRequest(method: string, params: object): Promise<any> {
    const requestToken = nextToken(prefix);
    tokens.push(requestToken);
    try {
      return await rpc.call(method, { ...params, accountId, requestToken });
    } finally {
      tokens = tokens.filter((t) => t !== requestToken);
    }
  }
  return {
    provider: "m365",
    async list(query, limit, pageToken) {
      const result = await longRequest("m365.list", { query: String(query ?? ""), limit: pageSize(limit), pageToken: String(pageToken ?? "") });
      const page = pageOf(result?.page);
      if (result?.warning) page.warning = "The mailbox search could not be completed";
      return page;
    },
    async read(ids) {
      if (ids.length === 0) return { messages: [], warning: "" };
      const result = await longRequest("m365.messages", { ids, full: false });
      const partial = !!result && (!!result.warning || !!result.continuation);
      return { messages: Array.isArray(result?.messages) ? result.messages : [], warning: partial ? "Some messages could not be loaded" : "" };
    },
    async act(action, ids, sourceLabelId = "") {
      try {
        let result: any;
        if (action === "trash" || action === "untrash") result = await rpc.call("m365." + action, { ids, accountId });
        else {
          const change = labelChangesFor(action, sourceLabelId);
          if (!change) return { failedIds: [], error: "" };
          result = await rpc.call("m365.modify", { ids, addLabelIds: change.add, removeLabelIds: change.remove, accountId });
        }
        const failed = Array.isArray(result?.failedIds) ? result.failedIds.map(String) : [];
        const code = result?.error ? String(result.error) : "";
        if (failed.length === 0 && code === "") return { failedIds: [], error: "" };
        return { failedIds: failed.length > 0 ? failed : ids.slice(), error: code !== "" ? sentenceFor("m365", code) : "Microsoft 365 did not apply this change to every message" };
      } catch (e) {
        return { failedIds: ids.slice(), error: sentenceFor("m365", e) };
      }
    },
    cancel() {
      for (const requestToken of tokens) rpc.call("m365.cancel", { accountId, requestToken }).catch(() => {});
      tokens = [];
    },
  };
}
