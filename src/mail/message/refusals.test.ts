import { expect, test } from "nsh/test";
import { canSend, jmapSendRefusal, m365SendRefusal, REFUSAL_NO_SEND } from "./refusals";

const MAIL = "urn:ietf:params:jmap:mail";
const SUBMISSION = "urn:ietf:params:jmap:submission";
const session = (caps: Record<string, unknown>) => ({ primaryAccounts: { [MAIL]: "a1" }, accounts: { a1: { accountCapabilities: caps } } });
const BOXES = [{ id: "b1", role: "inbox" }];

test("JMAP refuses send without submission, and says nothing until read", () => {
  expect(jmapSendRefusal(session({ [MAIL]: {}, [SUBMISSION]: {} }), BOXES)).toBe("");
  expect(jmapSendRefusal(session({ [MAIL]: {} }), BOXES)).toBe(REFUSAL_NO_SEND);
  expect(jmapSendRefusal(JSON.stringify(session({ [MAIL]: {} })), BOXES)).toBe(REFUSAL_NO_SEND);
  expect(jmapSendRefusal(session({ [MAIL]: {} }), [])).toBe(null);
  expect(jmapSendRefusal(null, BOXES)).toBe(null);
  expect(jmapSendRefusal({ accounts: {} }, BOXES)).toBe(REFUSAL_NO_SEND);
});

test("Microsoft 365 reads the check's send refusal as one line", () => {
  expect(m365SendRefusal({ ok: true, refusals: {} })).toBe("");
  expect(m365SendRefusal({ ok: true, refusals: { send: "No Sent\nfolder" } })).toBe("No Sent folder");
  expect(m365SendRefusal({ ok: true, refusals: { send: true } })).toBe("This mailbox cannot do that");
  expect(m365SendRefusal({ ok: false, refusals: { send: "x" } })).toBe(null);
  expect(m365SendRefusal(null)).toBe(null);
  expect(canSend(null)).toBe(true);
  expect(canSend("")).toBe(true);
  expect(canSend(REFUSAL_NO_SEND)).toBe(false);
});
