// JMAP for the list (JmapClient.qml): replies carry `{data, state}`.
import { labelChangesFor, nextSequence, pageOf, sentenceFor, type MailClient, type Rpc } from "./shared";

export function jmapClient(rpc: Rpc, accountId: string): MailClient {
  let live: string[] = [];
  async function request(method: string, params: object): Promise<any> {
    const requestId = "jmap-" + accountId + "-" + Date.now() + "-" + String(nextSequence());
    live.push(requestId);
    try {
      const result: any = await rpc.call(method, { ...params, accountId, requestId });
      return result ? result.data : null;
    } finally {
      live = live.filter((id) => id !== requestId);
    }
  }
  return {
    provider: "jmap",
    async list(query, limit, pageToken) {
      return pageOf(await request("jmap.list", { query: String(query ?? ""), maxResults: Number(limit) || 25, pageToken: String(pageToken ?? "") }));
    },
    async read(ids) {
      const data = await request("jmap.messages", { ids, withBlocks: true });
      return { messages: Array.isArray(data) ? data : [], warning: "" };
    },
    async act(action, ids, sourceLabelId = "") {
      try {
        let data: any;
        if (action === "trash" || action === "untrash") data = await request("jmap." + action, { ids });
        else {
          const change = labelChangesFor(action, sourceLabelId);
          if (!change) return { failedIds: [], error: "" };
          data = await request("jmap.batchModify", { ids, addLabelIds: change.add, removeLabelIds: change.remove });
        }
        const failed = Array.isArray(data?.failedIds) ? data.failedIds.map(String) : [];
        return { failedIds: failed, error: failed.length > 0 ? "The mail server could not complete this request" : "" };
      } catch (e) {
        return { failedIds: ids.slice(), error: sentenceFor("jmap", e) };
      }
    },
    cancel() {
      for (const requestId of live) rpc.call("jmap.cancel", { requestId }).catch(() => {});
      live = [];
    },
  };
}
