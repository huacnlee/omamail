import { expect, test } from "nsh/test";
import * as mailto from "./mailto";

const draft = (to: string, cc: string, bcc: string, subject: string, body: string) => ({ to, cc, bcc, subject, body });

test("parse reads recipients, subject and body", () => {
  expect(mailto.parse("mailto:jane@example.com")).toEqual(draft("jane@example.com", "", "", "", ""));
  expect(mailto.parse("MAILTO:jane@example.com")).toEqual(draft("jane@example.com", "", "", "", ""));
  expect(mailto.parse("mailto:jane@example.com?subject=Lunch&body=Tuesday")).toEqual(
    draft("jane@example.com", "", "", "Lunch", "Tuesday"),
  );
  expect(mailto.parse("mailto:a@example.com,b@example.com")).toEqual(
    draft("a@example.com, b@example.com", "", "", "", ""),
  );
  expect(mailto.parse("mailto:a@example.com?to=b@example.com&cc=c@example.com")).toEqual(
    draft("a@example.com, b@example.com", "c@example.com", "", "", ""),
  );
  expect(mailto.parse("mailto:?bcc=hidden@example.com")).toEqual(draft("", "", "hidden@example.com", "", ""));
});

test("parse decodes the query", () => {
  expect(mailto.parse("mailto:jane@example.com?subject=Stop+these")?.subject).toBe("Stop these");
  expect(mailto.parse("mailto:jane@example.com?subject=%E4%B8%AD%E6%96%87")?.subject).toBe("中文");
  expect(mailto.parse("mailto:jane@example.com?body=line%0Abreak")?.body).toBe("line\nbreak");
  expect(mailto.parse("mailto:jane@example.com?body=line%0D%0Abreak")?.body).toBe("line\nbreak");
  expect(mailto.parse("mailto:jane@example.com?subject=100%")?.subject).toBe("100%");
});

test("a header value cannot hold a line break", () => {
  const injected = mailto.parse("mailto:jane@example.com?subject=Stop%0D%0ABcc:%20victim@example.com");
  expect(injected?.subject).toBe("Stop Bcc: victim@example.com");
});

test("parse refuses what is not a mailto", () => {
  expect(mailto.parse("https://example.com")).toBe(null);
  expect(mailto.parse("")).toBe(null);
  expect(mailto.parse(null)).toBe(null);
  expect(mailto.parse("mailto:")).toEqual(draft("", "", "", "", ""));
  expect(mailto.parse("mailto:jane@example.com#ignored")).toEqual(draft("jane@example.com", "", "", "", ""));
});

test("draftFromPayload opens compose only for a mailto or compose request", () => {
  expect(mailto.draftFromPayload({ mailto: "mailto:jane@example.com?subject=Hi" })).toEqual(
    draft("jane@example.com", "", "", "Hi", ""),
  );
  expect(mailto.draftFromPayload({ compose: true })).toEqual(draft("", "", "", "", ""));
  expect(mailto.draftFromPayload({})).toBe(null);
  expect(mailto.draftFromPayload({ mailbox: "inbox" })).toBe(null);
  expect(mailto.draftFromPayload({ mailto: "https://example.com" })).toBe(null);
  expect(mailto.draftFromPayload(null)).toBe(null);
});

test("a link longer than MAX_LENGTH is not read", () => {
  const long = "mailto:ann@example.net?body=" + "x".repeat(mailto.MAX_LENGTH);
  expect(mailto.parse(long)).toBe(null);
  expect(mailto.parse("mailto:ann@example.net?body=" + "x".repeat(100))?.to).toBe("ann@example.net");
});
