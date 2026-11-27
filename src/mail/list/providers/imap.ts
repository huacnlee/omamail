// IMAP and Outlook over IMAP for the list (ImapClient.qml): imap.list with its
// continuation, imap.messages, imap.modify, imap.trash / untrash, imap.cancel.
import { labelChangesFor, nextToken, pageOf, pageSize, sentenceFor, type MailClient, type Rpc } from "./shared";

export function imapClient(rpc: Rpc, accountId: string, provider: string): MailClient {
  const prefix = "list-" + accountId;
  let tokens: string[] = [];
  const request = (method: string, params: object) => rpc.call(method, { ...params, accountId });
  return {
    provider,
    async list(query, limit, pageToken) {
      const requestToken = nextToken(prefix);
      tokens.push(requestToken);
      const params: any = { query: String(query ?? ""), limit: pageSize(limit), pageToken: String(pageToken ?? ""), progressive: false, requestToken };
      try {
        let result: any = await request("imap.list", params);
        const page = pageOf(result?.page);
        while (result?.continuation) {
          params.continuation = result.continuation;
          result = await request("imap.listContinue", params);
          const more = pageOf(result?.page);
          for (const id of more.ids) if (!page.ids.includes(id)) page.ids.push(id);
          page.nextPageToken = more.nextPageToken;
          page.estimate = Math.max(page.estimate, more.estimate);
        }
        if (result?.warning) page.warning = "The mailbox search could not be completed";
        return page;
      } finally {
        tokens = tokens.filter((t) => t !== requestToken);
      }
    },
    async read(ids) {
      const params: any = { ids, full: false, progressive: false, requestToken: nextToken(prefix) };
      let messages: unknown[] = [];
      for (;;) {
        const result: any = await request("imap.messages", params);
        messages = messages.concat(Array.isArray(result?.messages) ? result.messages : []);
        if (result?.continuation && !result.warning) {
          params.continuation = result.continuation;
          continue;
        }
        return { messages, warning: result?.warning ? "Some messages could not be loaded" : "" };
      }
    },
    async act(action, ids, sourceLabelId = "") {
      try {
        let result: any;
        if (action === "trash" || action === "untrash") result = await request("imap." + action, { ids });
        else {
          const change = labelChangesFor(action, sourceLabelId);
          if (!change) return { failedIds: [], error: "" };
          result = await request("imap.modify", { ids, addLabelIds: change.add, removeLabelIds: change.remove });
        }
        const failed = Array.isArray(result?.failedIds) ? result.failedIds.map(String) : [];
        return { failedIds: failed, error: failed.length > 0 ? "The mail server did not apply this change to every message" : "" };
      } catch (e) {
        return { failedIds: ids.slice(), error: sentenceFor(provider, e) };
      }
    },
    cancel() {
      for (const requestToken of tokens) rpc.call("imap.cancel", { accountId, requestToken }).catch(() => {});
      tokens = [];
    },
  };
}
