import { expect, test } from "nsh/test";
import { attachmentRequest, clientFor, draftRequest } from "./host";

test("each provider saves a draft with its own method and parameters", () => {
  const payload = { raw: "UkFX", draftId: "d", threadId: "t", attachments: [{ path: "/p" }] };
  expect(draftRequest("imap", payload)).toEqual({ method: "imap.saveDraft", params: { raw: "UkFX", draftId: "d" } });
  expect(draftRequest("outlook", payload).method).toBe("imap.saveDraft");
  expect(draftRequest("m365", payload)).toEqual({ method: "m365.saveDraft", params: { raw: "UkFX", draftId: "d" } });
  expect(draftRequest("hey", payload)).toEqual({
    method: "hey.saveDraft",
    params: { raw: "UkFX", threadId: "t", attachments: [{ path: "/p" }], draftId: "d" },
  });
  expect(draftRequest("jmap", payload)).toEqual({ method: "jmap.saveDraft", params: payload });
  expect(draftRequest("gmail", payload)).toEqual({ method: "gmail.updateDraft", params: { raw: "UkFX", threadId: "t", id: "d" } });
  expect(draftRequest("", { raw: "UkFX" })).toEqual({ method: "gmail.saveDraft", params: { raw: "UkFX" } });
});

test("part reads go to the provider that holds the message", () => {
  expect(attachmentRequest("imap", "m", "a")).toEqual({ method: "imap.attachment", params: { messageId: "m", attachmentId: "a" } });
  expect(attachmentRequest("jmap", "m", "a")).toEqual({ method: "jmap.attachment", params: { attachmentId: "a" } });
  expect(attachmentRequest("hey", "m", "a")).toBe(null);
  expect(clientFor("OUTLOOK")).toBe("imap");
});
