import { expect, test } from "nsh/test";
import * as senders from "./senders";

const all = [
  { accountId: "work@example.com", email: "work@example.com", displayName: "Work", label: "work" },
  { accountId: "work@example.com", email: "alias@example.com", displayName: "Alias", label: "work" },
  { accountId: "imap:home@example.com", email: "home@example.com", displayName: "", label: "home" },
];

test("a new message may be sent from any connected mailbox", () => {
  expect(senders.visible(all, "work@example.com", "new")).toEqual(all);
});

test("a reply or forward stays on the mailbox that received the message", () => {
  expect(senders.visible(all, "work@example.com", "reply").map((r) => r.email)).toEqual([
    "work@example.com",
    "alias@example.com",
  ]);
  expect(senders.visible(all, "work@example.com", "forward").length).toBe(2);
});

test("subtitle names the identity unless it repeats the address", () => {
  expect(senders.subtitle({ displayName: "Work", label: "work", email: "work@example.com" })).toBe("Work");
  expect(senders.subtitle({ displayName: "", label: "home", email: "home@example.com" })).toBe("home");
  expect(senders.subtitle({ displayName: "", label: "home@example.com", email: "home@example.com" })).toBe("");
});

test("preferredSendAs keeps a thread on the address it was sent to", () => {
  const aliases = [
    { email: "a@example.com" },
    { email: "b@example.com", isPrimary: true },
    { email: "c@example.com", isDefault: true },
  ];
  expect(senders.preferredSendAs(aliases, [{ email: "B@example.com" }])?.email).toBe("b@example.com");
  expect(senders.preferredSendAs(aliases, [{ email: "x@example.com" }])?.email).toBe("c@example.com");
  expect(senders.preferredSendAs(aliases.slice(0, 2), [])?.email).toBe("b@example.com");
  expect(senders.preferredSendAs([], [])).toBe(null);
});

test("sendAsFor refuses a From that is not an alias", () => {
  const aliases = [{ email: "a@example.com" }];
  expect(senders.sendAsFor(aliases, "A@example.com")?.email).toBe("a@example.com");
  expect(senders.sendAsFor(aliases, "evil@example.com")).toBe(null);
  expect(senders.sendAsFor(aliases, "")).toBe(null);
});
