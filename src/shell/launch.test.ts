// Launch links are untrusted: only a mailto: of a sane length is taken, and
// compose's parser keeps header values on one line. Synthetic URLs only.
import { expect, test } from "nsh/test";
import { parse } from "../mail/compose/mailto";
import { openGuarded } from "../testing/previewGuard";
import { acceptMailto, mailtoFromArgs, MAX_MAILTO_LENGTH } from "./launch";

test("a launch's first mailto argument is taken; flags and other schemes are not", () => {
  expect(mailtoFromArgs(["--new-window", "mailto:jane@example.com?subject=Hi"])).toBe("mailto:jane@example.com?subject=Hi");
  expect(mailtoFromArgs(["  MAILTO:jane@example.com  "])).toBe("MAILTO:jane@example.com");
  expect(mailtoFromArgs(["javascript:alert(1)"])).toBe(null);
  expect(mailtoFromArgs(["https://example.com/mailto:jane@example.com"])).toBe(null);
  expect(mailtoFromArgs(["/tmp/mailto:x"])).toBe(null);
  expect(mailtoFromArgs(["file:///etc/passwd"])).toBe(null);
  expect(mailtoFromArgs([])).toBe(null);
  expect(mailtoFromArgs("mailto:jane@example.com")).toBe(null);
  expect(mailtoFromArgs([42, null, { url: "mailto:x@example.com" }])).toBe(null);
});

test("a link past the length limit is refused, not cut", () => {
  const huge = "mailto:jane@example.com?body=" + "a".repeat(MAX_MAILTO_LENGTH);
  expect(acceptMailto(huge)).toBe(null);
  expect(mailtoFromArgs([huge, "mailto:ok@example.com"])).toBe("mailto:ok@example.com");
});

test("a CRLF in a header field cannot add a header; the body keeps its lines", () => {
  const link = acceptMailto("mailto:jane@example.com?subject=Hi%0D%0ABcc:%20evil@example.com&body=one%0D%0Atwo")!;
  const draft = parse(link)!;
  expect(draft.subject).toBe("Hi Bcc: evil@example.com");
  expect(draft.bcc).toBe("");
  expect(draft.to).toBe("jane@example.com");
  expect(draft.body).toBe("one\ntwo");
  const injected = parse(acceptMailto("mailto:jane@example.com%0D%0ABcc:evil@example.com")!)!;
  expect(injected.to.includes("\n") || injected.to.includes("\r")).toBe(false);
  expect(injected.bcc).toBe("");
});

test("headers beyond to, cc, bcc, subject and body are dropped", () => {
  const draft = parse(acceptMailto("mailto:a@example.com?from=boss@example.com&attach=/etc/passwd&in-reply-to=x&cc=b@example.com")!)!;
  expect(draft).toEqual({ to: "a@example.com", cc: "b@example.com", bcc: "", subject: "", body: "" });
});


const launched = async (link: string | null) => {
  const { app, guard } = await openGuarded("./fixtures/LaunchApp.tsx", { width: 400, height: 300 }, { launchMailto: link });
  await app.waitFor("id:launch-count");
  return { app, guard };
};

test("the link the app was launched with opens one draft", async () => {
  const { app, guard } = await launched("mailto:jane@example.com?subject=Hello");
  await app.waitFor("text:opened 1");
  expect(app.shows("text:to jane@example.com")).toBe(true);
  expect(app.shows("text:subject Hello")).toBe(true);
  guard?.assertNoCalls();
});

test("no launch link, or a hostile one, opens nothing or only fills fields", async () => {
  for (const link of [null, "javascript:alert(1)", "https://example.com", "mailto:x@example.com?body=" + "a".repeat(MAX_MAILTO_LENGTH)]) {
    const { app, guard } = await launched(link);
    await app.wait(100);
    expect(app.shows("text:opened 0")).toBe(true);
    guard?.assertNoCalls();
  }
  const { app } = await launched("mailto:jane@example.com?subject=Hi%0D%0ABcc:%20evil@example.com");
  await app.waitFor("text:opened 1");
  expect(app.shows("text:bcc ")).toBe(true);
  expect(app.shows("text:subject Hi Bcc: evil@example.com")).toBe(true);
});
