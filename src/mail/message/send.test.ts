// Each provider sends a built message the way its Qt client did.
import { expect, test } from "nsh/test";
import { sendRequest } from "./send";

const PAYLOAD = { raw: "UkFX", threadId: "t1", draftId: "", attachments: [{ path: "/x", filename: "x" }] };

test("each provider gets the request its Qt client sent", () => {
  expect(sendRequest("gmail", PAYLOAD)).toEqual({ method: "gmail.send", params: { raw: "UkFX", threadId: "t1" } });
  expect(sendRequest("gmail", { raw: "UkFX" })).toEqual({ method: "gmail.send", params: { raw: "UkFX" } });
  expect(sendRequest("imap", PAYLOAD)).toEqual({ method: "imap.send", params: { raw: "UkFX" } });
  expect(sendRequest("m365", PAYLOAD)).toEqual({ method: "m365.send", params: { raw: "UkFX" } });
  expect(sendRequest("jmap", PAYLOAD)).toEqual({ method: "jmap.send", params: PAYLOAD });
  expect(sendRequest("hey", PAYLOAD)).toEqual({
    method: "hey.send", params: { raw: "UkFX", threadId: "t1", attachments: [{ path: "/x", filename: "x" }] },
  });
});
