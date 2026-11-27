import { expect, test } from "nsh/test";
import * as Draft from "./draft";

test("a fresh draft is not meaningful; a typed field is", () => {
  const d = Draft.emptyDraft("k");
  expect(Draft.meaningful(d)).toBe(false);
  expect(Draft.meaningful({ ...d, subject: " Hi " })).toBe(true);
  // A placed sign-off is no edit; changing it is.
  expect(Draft.meaningful({ ...d, body: "-- \nMe", placedBody: "-- \nMe" })).toBe(false);
  expect(Draft.meaningful({ ...d, body: "Hello\n-- \nMe", placedBody: "-- \nMe" })).toBe(true);
  expect(Draft.meaningful({ ...d, draftAttachments: [{ filename: "a", mimeType: "x", size: 1, data: "AA==" }] })).toBe(true);
  // Forwarded originals count only on a forward.
  const fwd = [{ filename: "a", mimeType: "x", size: 1, data: "AA==" }];
  expect(Draft.meaningful({ ...d, forwardedAttachments: fwd })).toBe(false);
  expect(Draft.meaningful({ ...d, mode: "forward", forwardedAttachments: fwd })).toBe(true);
});

test("fieldsForDraft blanks thread fields on a forward and joins its files", () => {
  const d = {
    ...Draft.emptyDraft("k"),
    mode: "forward" as const,
    accountId: "a",
    sourceDraftId: "d1",
    fromEmail: "me@example.com",
    threadId: "t",
    inReplyTo: "<m@x>",
    forwardedAttachments: [{ filename: "f", mimeType: "x", size: 1, data: "AA==" }],
    draftAttachments: [{ filename: "o", mimeType: "x", size: 1, data: "AA==" }],
  };
  const fields = Draft.fieldsForDraft(d);
  expect(fields.threadId).toBe("");
  expect(fields.inReplyTo).toBe("");
  expect(fields.draftId).toBe("d1");
  expect(fields.from).toBe("me@example.com");
  expect(fields.attachments.map((a) => a.filename)).toEqual(["f", "o"]);
  const reply = Draft.fieldsForDraft({ ...d, mode: "reply" });
  expect(reply.threadId).toBe("t");
  expect(reply.attachments.map((a) => a.filename)).toEqual(["o"]);
});

test("restore reads an untrusted record and derives userModified for legacy ones", () => {
  const d = Draft.restore({ mode: "evil", to: "a@example.com", replyTo: "r@example.com", ccVisible: "yes" });
  expect(d.mode).toBe("new");
  expect(d.replyToVisible).toBe(true);
  expect(d.ccVisible).toBe(false);
  expect(d.userModified).toBe(true);
  expect(Draft.restore({ to: "a@example.com", userModified: false }).userModified).toBe(false);
  expect(Draft.restore(null).draftKey.length > 0).toBe(true);
  expect(Draft.restore({ deliveryUnknown: true }).deliveryUnknown).toBe(true);
});

test("replyOnly and toggleQuote take the quoted history out and put it back", () => {
  expect(Draft.replyOnly("Hi\n\n> old", "> old")).toBe("Hi");
  expect(Draft.replyOnly("> old", "> old")).toBe("");
  expect(Draft.replyOnly("Hi", "")).toBe("Hi");
  const d = { ...Draft.emptyDraft("k"), mode: "reply" as const, body: "Hi\n\n> old", bodyQuote: "> old" };
  expect(Draft.hasQuote(d)).toBe(true);
  expect(Draft.toggleQuote(d)).toBe("Hi");
  expect(Draft.toggleQuote({ ...d, body: "Hi" })).toBe("Hi\n\n> old");
  expect(Draft.toggleQuote({ ...d, mode: "forward" })).toBe(d.body);
});

test("sizes and counts read as words", () => {
  expect(Draft.formatSize(512)).toBe("512 B");
  expect(Draft.formatSize(2048)).toBe("2.0 KB");
  expect(Draft.formatSize(20 * 1024)).toBe("20 KB");
  expect(Draft.formatSize(3 * 1024 * 1024)).toBe("3.0 MB");
  expect(Draft.formatCount(1, "original attachment")).toBe("1 original attachment");
  expect(Draft.formatCount(2, "original attachment")).toBe("2 original attachments");
});

test("unified ids name their mailbox", () => {
  expect(Draft.accountOf("acc\u001fid")).toBe("acc");
  expect(Draft.sourceIdOf("acc\u001fid")).toBe("id");
  expect(Draft.accountOf("id")).toBe("");
  expect(Draft.draftOwner({ accountId: "", draftId: "b\u001fx" })).toBe("b");
  expect(Draft.draftOwner({ accountId: "a", draftId: "b\u001fx" })).toBe("a");
});

test("only local file URLs become paths", () => {
  expect(Draft.pathFromUri("file:///home/me/a%20b.pdf")).toBe("/home/me/a b.pdf");
  expect(Draft.pathFromUri("file://localhost/tmp/x")).toBe("/tmp/x");
  expect(Draft.pathFromUri("https://example.com/x")).toBe("");
  expect(Draft.pathFromUri("file://relative")).toBe("");
  expect(Draft.pathFromUri("file:///tmp/a%0Ab")).toBe("");
});
