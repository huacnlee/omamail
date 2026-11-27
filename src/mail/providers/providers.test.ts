import { expect, test } from "nsh/test";
import { Buffer } from "buffer";
import * as Google from "./google";
import * as Imap from "./imap";
import * as Jmap from "./jmap";
import * as M365 from "./m365";
import * as Microsoft from "./microsoft";
import * as Registry from "./registry";

test("the chooser lists the specific protocols before the catch-all", () => {
  expect(Registry.ids()).toEqual(["gmail", "outlook", "m365", "hey", "jmap", "imap"]);
  expect(Registry.get("nope").id).toBe("gmail");
  expect(Registry.detail("jmap", { jmap: { sessionUrl: "https://mail.example.org/jmap/session" } })).toBe(
    "JMAP · mail.example.org",
  );
  expect(Registry.mailboxes("imap", [], 6).map((box) => box.key)).toEqual([
    "inbox", "unread", "starred", "drafts", "sent", "all", "spam", "trash",
  ]);
  expect(Registry.mailboxes("imap", ["spam"], 5).map((box) => box.key)).toContain("archive");
});

test("IMAP presets fill the servers and only loopback skips certificates", () => {
  const icloud = Imap.suggestedSettings("Jane@ME.com");
  expect(icloud).toMatchObject({ imapHost: "imap.mail.me.com", smtpPort: 587, preset: "icloud", insecure: false });
  expect(icloud.guideUrl).toBe("https://support.apple.com/102654");
  expect(Imap.suggestedSettings("a@example.org")).toMatchObject({ imapHost: "imap.example.org", smtpHost: "smtp.example.org" });
  expect(Imap.suggestedSettings("a@proton.me").insecure).toBe(true);
  expect(Imap.normalizeSettings({ imapHost: "mail.example.org", insecure: true }).insecure).toBe(false);
  expect(Imap.setupSettings({ address: "a@pm.me", imapHost: "127.0.0.1" })).toMatchObject({ username: "a@pm.me", insecure: true });
  expect(Imap.isValidHost("imap.example.org")).toBe(true);
  for (const bad of ["https://x", "x:993", "a b", "user@host", ""]) expect(Imap.isValidHost(bad)).toBe(false);
  expect(Imap.validateSettings({ username: "u", imapHost: "" })).toEqual({ ok: false, error: "Add the IMAP server address" });
  expect(Imap.validateSettings({ username: "u", imapHost: "h.org", smtpHost: "bad host" }).error).toBe(
    "That is not a valid SMTP server address",
  );
  expect(Imap.normalizedPort("70000", 993)).toBe(993);
});

test("an IMAP password is checked and never echoed", () => {
  expect(Imap.checkedPassword("secret\r\n")).toEqual({ ok: true, value: "secret" });
  expect(Imap.checkedPassword("se\u0000cret").ok).toBe(false);
  expect(Imap.checkedPassword("")).toEqual({ ok: false, error: "Enter the password for this mailbox" });
  expect(Imap.redact("A1 LOGIN jane hunter2")).toBe("A1 LOGIN [redacted]");
  expect(Imap.redact("imaps://jane:hunter2@host")).toBe("imaps://[redacted]@host");
  expect(Imap.backendError("mail_auth_failed")).toBe("The server rejected the sign-in. Sign in again.");
  expect(Imap.backendError("anything else")).toBe("Mail request failed");
});

test("JMAP discovery is HTTPS only", () => {
  expect(Jmap.discoveryPlan("ada@example.org", "").steps).toEqual([
    { kind: "well-known", url: "https://example.org/.well-known/jmap" },
  ]);
  expect(Jmap.discoveryPlan("ada@example.org", "mail.example.org").steps[0].url).toBe(
    "https://mail.example.org/jmap/session",
  );
  expect(Jmap.discoveryPlan("ada@example.org", "http://mail.example.org").error).toBe(
    "The server must be reached over HTTPS",
  );
  expect(Jmap.typedSessionUrl("mail.example.org:8443")).toBe("https://mail.example.org:8443/jmap/session");
  expect(Jmap.typedSessionUrl("mail.example.org:99999")).toBe("");
  expect(Jmap.sessionHost("https://user@Mail.Example.org/x")).toBe("mail.example.org");
  expect(Jmap.schemeLabel("Bearer")).toBe("API token");
  expect(Jmap.verifyError("jmap_discovery_failed")).toMatchObject({ needsServer: true, rejected: false });
  expect(Jmap.verifyError("jmap_unauthorized").rejected).toBe(true);
});

test("Microsoft answers are checked before they are shown", () => {
  expect(Microsoft.verificationUri("https://microsoft.com/devicelogin")).toBe("https://microsoft.com/devicelogin");
  expect(Microsoft.verificationUri("https://evil.example/devicelogin")).toBe("");
  expect(Microsoft.verificationUri("http://microsoft.com/devicelogin")).toBe("");
  const started = Microsoft.parseDeviceResponse(
    200,
    JSON.stringify({ device_code: "D", user_code: "ABCD-1234", verification_uri: "https://microsoft.com/devicelogin", interval: 1 }),
  );
  expect(started).toMatchObject({ ok: true, userCode: "ABCD-1234", interval: 5 });
  expect(Microsoft.parseTokenResponse(400, '{"error":"slow_down"}')).toMatchObject({ pending: true, slowDown: true });
  expect(Microsoft.parseTokenResponse(400, '{"error":"access_denied"}')).toMatchObject({
    ok: false,
    error: "Microsoft sign-in was cancelled",
  });
  expect(Microsoft.missingMailScopes("openid IMAP.AccessAsUser.All")).toEqual(["https://outlook.office.com/SMTP.Send"]);
  expect(Microsoft.workTenant("")).toBe("organizations");
  expect(Microsoft.workTenant("contoso.com")).toBe("contoso.com");
  expect(Microsoft.workTenant("not a tenant")).toBe("");
  expect(Microsoft.outlookSettings("a@contoso.com", "contoso.com", "").smtpHost).toBe("smtp.office365.com");
  expect(Microsoft.outlookSettings("a@outlook.com", "", "").smtpHost).toBe("smtp-mail.outlook.com");
  expect(Microsoft.deviceTokenBody("cid", "d c")).toBe(
    "client_id=cid&grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&device_code=d%20c",
  );
  expect(Microsoft.redact('{"device_code":"abc"} eyJhbGciOiJIUzI1NiJ9.payloadpayload')).toBe(
    '{"device_code":"[redacted]"} [redacted]',
  );
});

test("Microsoft 365 sign-in answers are bounded", () => {
  const begin = M365.beginResult({
    requestId: "r1",
    userCode: "ABCD1234",
    verificationUri: "https://microsoft.com/devicelogin",
    interval: 99,
  });
  expect(begin).toEqual({ requestId: "r1", userCode: "ABCD1234", verificationUri: "https://microsoft.com/devicelogin", interval: 30 });
  expect(M365.beginResult({ requestId: "r1", userCode: "<b>", verificationUri: "https://microsoft.com/x" })).toBeNull();
  expect(M365.pollResult({ state: "failed", error: "weird" }).code).toBe("m365_auth_failed");
  expect(M365.pollResult({ state: "declined" })).toMatchObject({ state: "declined", code: "m365_declined" });
  expect(M365.pollResult({ state: "failed", error: "m365_wrong_account", signedInAs: "x\u202ey@z" }).who).toBe("x y@z");
  expect(M365.failureSentence("m365_wrong_account", "b@x.org", "a@x.org")).toMatch(/^The code was entered as b@x.org, not a@x.org/);
  expect(M365.pollMayHaveSaved({ state: "pending", warning: "m365_exchange_running" }, null)).toBe(true);
  expect(M365.pollMayHaveSaved(null, { message: "Backend stopped" })).toBe(true);
  expect(M365.clientId("ABCDEF01-2345-6789-ABCD-EF0123456789")).toBe("abcdef01-2345-6789-abcd-ef0123456789");
});

test("a Google client is parsed, kept to Desktop apps and redacted", () => {
  const id = "123456-abc_def.apps.googleusercontent.com";
  expect(Google.parse(id + " GOCSPX-synthetic")).toMatchObject({ ok: true, client: { clientId: id, clientSecret: "GOCSPX-synthetic" } });
  expect(Google.parse(JSON.stringify({ web: { client_id: id } })).error).toBe(
    "That is a Web application client. Create a Desktop app client instead",
  );
  expect(Google.parse("nothing").ok).toBe(false);
  const file = Google.serialize({ clientId: id, clientSecret: "s", projectId: "p" });
  expect(Google.effective(file, "gmail:a@b.c", null)).toEqual({ clientId: id, clientSecret: "s", projectId: "p" });
  expect(Google.usingBuiltin("", "x", { clientId: id })).toBe(true);
  expect(Google.builtin({ clientId: id + "\n" }).clientId).toBe("");
  expect(Google.describe({ clientId: id, clientSecret: "", projectId: "p" })).toBe("p · 123456");
  expect(Google.redact("refresh_token=1//abc ya29.token GOCSPX-x")).toBe("refresh_token=[redacted] [redacted] [redacted]");
  expect(Google.signInErrorMessage({ message: "auth_cancelled" })).toBe("Google sign-in was cancelled. Try again");
  expect(Google.signInErrorMessage("unknown")).toBe(Google.SIGN_IN_GENERIC);
  expect(Google.normalizedPort(80)).toBe(9481);
});

test("a Graph code is held to the mailbox's own account", () => {
  const encode = (claims: object) =>
    "x." + Buffer.from(JSON.stringify(claims)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") + ".y";
  const jane = encode({ preferred_username: "Jane@Example.org", tid: "t1", oid: "o1" });
  const other = encode({ preferred_username: "mallory@example.org", tid: "t1", oid: "o2" });
  expect(Microsoft.signedInAs(jane)).toBe("jane@example.org");
  expect(Microsoft.accountKey(jane)).toBe("t1/o1");
  expect(Microsoft.sameAccount(jane, "jane@example.org", "")).toBe(true);
  expect(Microsoft.sameAccount(other, "jane@example.org", "")).toBe(false);
  // Known by id, a matching name is not enough.
  expect(Microsoft.sameAccount(other, "mallory@example.org", "t1/o1")).toBe(false);
  expect(Microsoft.sameAccount("not a token", "jane@example.org", "")).toBe(true);
  expect(Microsoft.missingGraphScope("https://graph.microsoft.com/Mail.Send offline_access")).toBe(false);
  expect(Microsoft.missingGraphScope("Calendars.ReadWrite")).toBe(true);
  expect(Microsoft.graphRefusedMessage("x")).toContain("Mail.Send and Calendars.ReadWrite");
});
