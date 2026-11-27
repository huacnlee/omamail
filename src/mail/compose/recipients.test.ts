import { expect, test } from "nsh/test";
import * as recipients from "./recipients";

const contacts = [
  { name: "Jane Doe", email: "jane@example.com" },
  { name: "Morgan Reed", email: "morgan@example.com" },
  { name: "Jane Duplicate", email: "JANE@example.com" },
  { name: "", email: "invalid" },
];

test("normalize keeps the first spelling of each valid address", () => {
  expect(recipients.normalize(contacts)).toEqual([
    { name: "Jane Doe", email: "jane@example.com" },
    { name: "Morgan Reed", email: "morgan@example.com" },
  ]);
});

test("suggest matches the token being typed and skips used addresses", () => {
  expect(recipients.suggest(contacts, "ja", 5)).toEqual([{ name: "Jane Doe", email: "jane@example.com" }]);
  expect(recipients.suggest(contacts, "Morgan <morgan@example.com>, ja", 5)).toEqual([
    { name: "Jane Doe", email: "jane@example.com" },
  ]);
  expect(recipients.suggest(contacts, "jane@example.com, ", 5).length).toBe(0);
  expect(recipients.suggest(contacts, "jane@example.com", 5).length).toBe(0);
});

test("accept and append write a contact into a field", () => {
  expect(recipients.accept("other@example.com, ja", contacts[0])).toBe(
    "other@example.com, Jane Doe <jane@example.com>",
  );
  expect(recipients.accept("ja", { name: "", email: "jane@example.com" })).toBe("jane@example.com");
  expect(recipients.append("first@example.com", contacts[0])).toBe("first@example.com, Jane Doe <jane@example.com>");
  expect(recipients.append("", contacts[0])).toBe("Jane Doe <jane@example.com>");
  expect(recipients.append("Jane Doe <jane@example.com>", contacts[0])).toBe("Jane Doe <jane@example.com>");
});

// A harvested name holding a special is quoted, or `Team: eve@example.net;`
// in front of an address would be a group that sends a copy to eve.
test("a contact name with a header special is quoted", () => {
  const quoted = (name: string) => '"' + name.replace(/([\\"])/g, "\\$1") + '" <dave@example.org>';
  const cases: [string, string][] = '()<>[]:;@\\,."'
    .split("")
    .map((c) => ["Ada " + c + " Lovelace", quoted("Ada " + c + " Lovelace")]);
  cases.push(
    ["Team: eve@example.net;", '"Team: eve@example.net;" <dave@example.org>'],
    ['Say "hi" \\ bye', '"Say \\"hi\\" \\\\ bye" <dave@example.org>'],
    ["Smith (Sales)", '"Smith (Sales)" <dave@example.org>'],
    ["Dr. Dave", '"Dr. Dave" <dave@example.org>'],
    ["eve@example.net", '"eve@example.net" <dave@example.org>'],
    ["[ops]", '"[ops]" <dave@example.org>'],
    ["Müller, Jörg", '"Müller, Jörg" <dave@example.org>'],
    ["Jörg Müller", "Jörg Müller <dave@example.org>"],
    ["Dave\u0000Lovelace", "Dave Lovelace <dave@example.org>"],
    ["\u0000", "dave@example.org"],
  );
  for (const [name, text] of cases) {
    const written = recipients.append("ada@example.org", { name, email: "dave@example.org" });
    expect(written).toBe("ada@example.org, " + text);
    // The chip view reads the same text back as two entries.
    const parsed = recipients.tokens(written + ",").done.map((t) => t.email);
    expect(parsed).toEqual(["ada@example.org", "dave@example.org"]);
  }
});

test("filter finds by name or address, sorted by name", () => {
  expect(recipients.filter(contacts, "morgan")).toEqual([{ name: "Morgan Reed", email: "morgan@example.com" }]);
  expect(recipients.filter(contacts, "").length).toBe(2);
  expect(recipients.filter(contacts, "", 1).length).toBe(1);
});

test("replyFields addresses the sender or, for our own mail, its recipients", () => {
  const own = [{ email: "me@example.com" }, { email: "alias@example.com" }];
  const sent = {
    from: { email: "ALIAS@example.com" },
    replyTo: { email: "different-reply@example.com" },
    to: [{ email: "person@example.com" }, { email: "second@example.com" }, { email: "me@example.com" }],
    cc: [{ email: "copy@example.com" }, { email: "PERSON@example.com" }, { email: "alias@example.com" }],
    bcc: [{ email: "private@example.com" }],
  };
  expect(recipients.replyFields(sent, "reply", own)).toEqual({
    to: "person@example.com, second@example.com",
    cc: "",
    outgoing: true,
  });
  expect(recipients.replyFields(sent, "replyAll", own)).toEqual({
    to: "person@example.com, second@example.com",
    cc: "copy@example.com",
    outgoing: true,
  });
  expect(
    recipients.replyFields(
      {
        from: { email: "sender@example.com" },
        replyTo: { email: "reply@example.com" },
        to: [{ email: "me@example.com" }, { email: "other-account@example.com" }],
        cc: [{ email: "copy@example.com" }, { email: "REPLY@example.com" }, { email: "alias@example.com" }],
      },
      "replyAll",
      own,
    ),
  ).toEqual({ to: "reply@example.com", cc: "other-account@example.com, copy@example.com", outgoing: false });
  expect(recipients.replyFields({ from: own[0], to: own, cc: own }, "replyAll", own)).toEqual({
    to: "",
    cc: "",
    outgoing: true,
  });
  expect(recipients.replyFields(null, "reply", own)).toEqual({ to: "", cc: "", outgoing: false });
});

test("reply fields cannot carry a header break", () => {
  const hostile = recipients.replyFields(
    {
      from: { email: "sender@example.com" },
      to: [{ email: "me@example.com" }],
      cc: [{ email: "copy@example.com\r\nBcc: hidden@example.com" }],
    },
    "replyAll",
    [{ email: "me@example.com" }],
  );
  expect(/[\r\n]/.test(hostile.to + hostile.cc)).toBe(false);
});

test("tokens splits finished entries, respecting quotes", () => {
  const field = recipients.tokens('"Doe, Jane" <jane@example.com>, bob@example.com, not an address, mor');
  expect(field.done.map((t) => t.label)).toEqual(["Doe, Jane", "bob@example.com", "not an address"]);
  expect(field.done.map((t) => t.invalid)).toEqual([false, false, true]);
  expect(field.pending).toBe("mor");
  expect(recipients.removeToken('"Doe, Jane" <jane@example.com>, bob@example.com, mor', 0)).toBe(
    "bob@example.com, mor",
  );
  expect(recipients.removeToken("a@example.com, b@example.com, ", 1)).toBe("a@example.com, ");
  expect(recipients.removeToken("a@example.com, ", 0)).toBe("");
});

test("committed lists end in a separator and header lists do not", () => {
  expect(recipients.committed("a@x.test, b@y.test")).toBe("a@x.test, b@y.test, ");
  expect(recipients.committed("a@x.test,")).toBe("a@x.test, ");
  expect(recipients.committed("  ")).toBe("");
  expect(recipients.tokens(recipients.committed("Ann <a@x.test>")).done.length).toBe(1);
  expect(recipients.addressList("a@x.test, b@y.test, ")).toBe("a@x.test, b@y.test");
  expect(recipients.addressList(" ; ")).toBe("");
});
