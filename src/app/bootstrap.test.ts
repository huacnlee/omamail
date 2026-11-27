import { expect, test } from "nsh/test";
import { accountRefs } from "./bootstrap";

test("only accounts with an address open", () => {
  const { refs, activeId } = accountRefs({
    version: 1,
    activeId: "imap:jane@example.com",
    accounts: [
      { email: "jane@example.com", provider: "imap", label: "", imap: { imapHost: " imap.example.com " } },
      { email: "Bob@Example.com", provider: "gmail", label: "Work" },
      { email: "", provider: "imap", pending: true },
    ],
  });
  expect(refs).toEqual([
    { id: "imap:jane@example.com", email: "jane@example.com", provider: "imap", label: "jane", name: "", imapHost: "imap.example.com" },
    { id: "bob@example.com", email: "Bob@Example.com", provider: "gmail", label: "Work", name: "Work" },
  ]);
  expect(activeId).toBe("imap:jane@example.com");
  expect(accountRefs(null).refs).toEqual([]);
  expect(accountRefs({ accounts: "nope" }).refs).toEqual([]);
});
