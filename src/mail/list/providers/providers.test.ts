// The provider adapters send exactly what the Qt clients sent.
import { expect, test } from "nsh/test";
import { createClient as clientFor } from "./create";
import { heyVerbFor } from "./hey";
import type { Rpc } from "./shared";

function fakeRpc(answers: Record<string, (params: any) => any>) {
  const calls: { method: string; params: any }[] = [];
  const listeners = new Map<string, (params: any) => void>();
  const rpc: Rpc = {
    async call(method, params) {
      calls.push({ method, params });
      const answer = answers[method];
      if (!answer) throw new Error("unknown_method");
      return answer(params);
    },
    on(method, listener) {
      listeners.set(method, listener);
      return () => listeners.delete(method);
    },
  };
  return { rpc, calls, emit: (method: string, params: any) => listeners.get(method)?.(params) };
}

test("gmail lists, reads each id and batches label changes", async () => {
  const { rpc, calls } = fakeRpc({
    "gmail.list": () => ({ ids: ["a", "b"], threadIds: [], nextPageToken: "n", estimate: 9 }),
    "gmail.read": (p) => ({ id: p.id }),
    "gmail.batchModify": () => ({}),
    "gmail.modify": () => ({}),
  });
  const client = clientFor(rpc, "acct", "gmail");
  const page = await client.list("in:inbox", 25, "");
  expect(page).toEqual({ ids: ["a", "b"], nextPageToken: "n", estimate: 9, warning: "" });
  expect(calls[0]).toEqual({ method: "gmail.list", params: { query: "in:inbox", pageToken: "", pageSize: 25, accountId: "acct" } });
  const read = await client.read(["a", "b"]);
  expect(read.messages).toEqual([{ id: "a" }, { id: "b" }]);
  expect(calls[1].params).toEqual({ id: "a", full: false, accountId: "acct" });
  await client.act("archive", ["a", "b"]);
  expect(calls.at(-1)).toEqual({ method: "gmail.batchModify", params: { ids: ["a", "b"], addLabelIds: [], removeLabelIds: ["INBOX"], accountId: "acct" } });
  await client.act("markRead", ["a"]);
  expect(calls.at(-1)).toEqual({ method: "gmail.modify", params: { id: "a", addLabelIds: [], removeLabelIds: ["UNREAD"], accountId: "acct" } });
});

test("a queued gmail change waits for gmail.settled", async () => {
  const { rpc, emit } = fakeRpc({ "gmail.trash": () => ({ queued: true, ticket: "t1" }) });
  const client = clientFor(rpc, "acct", "gmail");
  const pending = client.act("trash", ["a"]);
  await Promise.resolve();
  await Promise.resolve();
  emit("gmail.settled", { accountId: "acct", ticket: "t1", ok: false, error: "gmail_rate_limited" });
  const result = await pending;
  expect(result.failedIds).toEqual(["a"]);
  expect(result.error).toContain("rate limiting");
});

test("imap follows a listing's continuation", async () => {
  const { rpc, calls } = fakeRpc({
    "imap.list": () => ({ page: { ids: ["1:INBOX"], nextPageToken: "", estimate: 2 }, continuation: "c1" }),
    "imap.listContinue": () => ({ page: { ids: ["2:INBOX"], nextPageToken: "p2", estimate: 2 } }),
    "imap.trash": () => ({}),
  });
  const client = clientFor(rpc, "acct", "imap");
  const page = await client.list("folder:INBOX", 25, "");
  expect(page.ids).toEqual(["1:INBOX", "2:INBOX"]);
  expect(page.nextPageToken).toBe("p2");
  expect(calls[1].params.continuation).toBe("c1");
  await client.act("trash", ["1:INBOX"]);
  expect(calls.at(-1)).toEqual({ method: "imap.trash", params: { ids: ["1:INBOX"], accountId: "acct" } });
});

test("m365 reports the ids it did not change", async () => {
  const { rpc } = fakeRpc({ "m365.modify": () => ({ failedIds: ["b"] }) });
  const result = await clientFor(rpc, "acct", "m365").act("star", ["a", "b"]);
  expect(result.failedIds).toEqual(["b"]);
});

test("hey speaks verbs and needs its program", async () => {
  expect(heyVerbFor("markRead")).toBe("markRead");
  expect(heyVerbFor("spam")).toBe("spam");
  expect(heyVerbFor("archive")).toBe("");
  const { rpc, calls } = fakeRpc({
    "hey.list": () => ({ ids: ["p:1"], messages: [{ id: "p:1", labelIds: ["UNREAD"] }], nextPageToken: "" }),
    "hey.act": () => null,
  });
  const client = clientFor(rpc, "acct", "hey", () => ({ heyProgram: "/usr/bin/hey" }));
  await client.list("box:imbox", 25, "");
  expect(calls[0].params.program).toBe("/usr/bin/hey");
  expect((await client.read(["p:1"])).messages.length).toBe(1);
  await client.act("markRead", ["p:1"]);
  expect(calls.at(-1)).toEqual({ method: "hey.act", params: { verb: "markRead", ids: ["p:1"], accountId: "acct", program: "/usr/bin/hey" } });
});

test("open in browser stays on the provider's own web mail", async () => {
  const { webMessageUrlAllowed } = await import("./facts");
  expect(webMessageUrlAllowed("gmail", "https://mail.google.com/mail/u/0/#all/18c2")).toBe(true);
  expect(webMessageUrlAllowed("hey", "https://app.hey.com/topics/123")).toBe(true);
  expect(webMessageUrlAllowed("gmail", "https://mail.google.com.evil.example/x")).toBe(false);
  expect(webMessageUrlAllowed("gmail", "https://user:pw@mail.google.com/x")).toBe(false);
  expect(webMessageUrlAllowed("gmail", "http://mail.google.com/x")).toBe(false);
  expect(webMessageUrlAllowed("gmail", "javascript:alert(1)")).toBe(false);
  expect(webMessageUrlAllowed("gmail", "https://mail.google.com/x\r\nHost: evil")).toBe(false);
  expect(webMessageUrlAllowed("hey", "https://mail.google.com/x")).toBe(false);
  expect(webMessageUrlAllowed("imap", "https://mail.google.com/x")).toBe(false);
  expect(webMessageUrlAllowed("gmail", "https://mail.google.com:8443/x")).toBe(false);
});

test("backend error text never reaches the screen unmapped", async () => {
  const { sentenceFor } = await import("./shared");
  expect(sentenceFor("imap", new Error("* NO [ALERT] visit http://evil.example to fix"))).toBe("The mail server could not complete this request");
  expect(sentenceFor("gmail", new Error("gmail_rate_limited"))).toContain("rate limiting");
});

test("web views match core's provider table: web for Gmail and HEY, webBox for Gmail only", async () => {
  const { capabilitiesOf, webMessageUrlAllowed } = await import("./facts");
  for (const provider of ["gmail", "hey", "imap", "outlook", "jmap", "m365"]) {
    expect(capabilitiesOf(provider).web).toBe(provider === "gmail" || provider === "hey");
    expect(capabilitiesOf(provider).webBox).toBe(provider === "gmail");
  }
  // The web inbox URL core builds for a query stays on Gmail's host.
  expect(webMessageUrlAllowed("gmail", "https://mail.google.com/mail/u/0/#search/in%3Ainbox")).toBe(true);
});
