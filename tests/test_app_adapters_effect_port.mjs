import assert from "node:assert/strict";

import { createEffectPort, redactError, requestIdentity } from "../app/adapters/effect-port.js";
import { createMailState, reduceMailState } from "../app/application/mail-state.js";

const identity = requestIdentity({
  accountId: "me@example.com",
  query: "in:inbox",
  objectId: "message-1",
  revision: 4,
});
let sent = null;
let reply = null;
assert.throws(() => createEffectPort(() => {}), /current identity getter is required/);

const port = createEffectPort((effect, complete) => {
  sent = effect;
  reply = complete;
  return { cancel() {} };
}, () => identity);
let result = null;
port.dispatch({ kind: "gmail.http", identity, method: "GET" }, (value) => {
  result = value;
});

assert.equal(sent.kind, "gmail.http");
assert.deepEqual(sent.identity, identity);
reply({ status: 200, value: { messages: [] } });
assert.deepEqual(result, {
  ok: true,
  value: { messages: [] },
  error: "",
  identity,
});

result = null;
port.dispatch({ kind: "gmail.http", identity, method: "GET" }, (value) => {
  result = value;
});
reply({
  status: 200,
  identity: { ...identity, revision: identity.revision + 1 },
  value: { messages: ["stale"] },
});
assert.equal(result.discarded, true, "a completion for another request identity settles as discarded");

let current = createMailState("me@example.com", "gmail");
current = reduceMailState(current, { type: "load", query: "in:inbox" });
const currentIdentity = requestIdentity(current.request);
let delayedReply = null;
const guardedPort = createEffectPort((effect, complete) => {
  delayedReply = complete;
  return { cancel() {} };
}, () => current.request);
let guardedResult = null;
guardedPort.dispatch({ kind: "gmail.http", identity: currentIdentity }, (value) => { guardedResult = value; });
current = reduceMailState(current, { type: "load", query: "from:later@example.com" });
delayedReply({ status: 200, identity: currentIdentity, value: { messages: ["old"] } });
assert.equal(guardedResult.discarded, true, "a completion is discarded when current reducer state has advanced");

let failed = null;
port.dispatch({ kind: "gmail.http", identity, method: "GET" }, (value) => { failed = value; });
reply({ ok: false, status: 200, error: "the server refused this" });
assert.equal(failed.ok, false, "an explicit false success flag wins over an HTTP status");
assert.equal(failed.error, "the server refused this");

let redacted = null;
port.dispatch({ kind: "gmail.http", identity, method: "GET" }, (value) => { redacted = value; });
reply({
  ok: false,
  error: {
    headers: { Authorization: "Bearer top-secret", nested: { Cookie: "session=secret" } },
    endpoint: "https://alice:password@example.com/inbox",
  },
});
assert.equal(redacted.error.includes("top-secret"), false);
assert.equal(redacted.error.includes("password"), false);
assert.equal(redacted.error.includes("[redacted]"), true, "nested credentials are redacted");

assert.equal(
  redactError({ pass: "one", pwd: "two", apiKey: "three", api_key: "four", accessKey: "five", secretKey: "six", message: "ordinary text" }),
  "pass: [redacted], pwd: [redacted], apiKey: [redacted], api_key: [redacted], accessKey: [redacted], secretKey: [redacted], message: ordinary text",
);
assert.equal(
  redactError("PASS=one Pwd:two apiKey=three API_KEY:four accessKey=five SECRETKEY:six, pass this message onward"),
  "PASS=[redacted] Pwd:[redacted] apiKey=[redacted] API_KEY:[redacted] accessKey=[redacted] SECRETKEY:[redacted], pass this message onward",
);
assert.equal(
  redactError('{"apiKey":"alpha beta","message":"keep"}'),
  '{"apiKey":"[redacted]","message":"keep"}',
);
assert.equal(
  redactError('{"password":"correct \\\"horse\\\"","message":"keep"}'),
  '{"password":"[redacted]","message":"keep"}',
);
assert.equal(
  redactError('{\\"secretKey\\":\\"alpha beta\\",\\"message\\":\\"keep\\"}'),
  '{"secretKey":"[redacted]","message":"keep"}',
  "a complete JSON object escaped once for a transport is decoded safely before redaction",
);
assert.equal(
  redactError('{\\"secretKey\\":\\"alpha beta\\"'),
  '{"secretKey":[redacted]',
  "an invalid escaped JSON object falls back to plaintext redaction without leaking its secret",
);
assert.equal(
  redactError({ bypass: "retain", compass: "retain", pass: "hide" }),
  "bypass: retain, compass: retain, pass: [redacted]",
  "sensitive keys are an explicit normalized set rather than substring matches",
);
assert.equal(
  redactError('password=correct horse, message=keep; "accessKey" : "alpha beta"\npass this message onward'),
  'password=[redacted], message=keep; "accessKey" : [redacted]\npass this message onward',
);

let detailReply = null;
const detailPort = createEffectPort((effect, complete) => {
  detailReply = complete;
  return { cancel() {} };
}, () => current.request);
const detailIdentity = requestIdentity({
  accountId: current.accountId,
  query: "older query is harmless for detail",
  objectId: "message-1",
  revision: current.request.revision,
});
let detailResult = null;
detailPort.dispatch({ kind: "gmail.http", scope: "object", identity: detailIdentity }, (value) => { detailResult = value; });
detailReply({ status: 200, identity: detailIdentity, value: { id: "message-1" } });
assert.equal(detailResult.ok, true, "a current detail survives when MailState has no objectId");

let lateDetailReply = null;
const lateDetailPort = createEffectPort((effect, complete) => {
  lateDetailReply = complete;
  return { cancel() {} };
}, () => current.request);
let lateDetail = null;
lateDetailPort.dispatch({ kind: "gmail.http", scope: "object", identity: detailIdentity }, (value) => { lateDetail = value; });
current = reduceMailState(current, { type: "load", query: "newer query" });
lateDetailReply({ status: 200, identity: detailIdentity, value: { id: "message-1" } });
assert.equal(lateDetail.discarded, true, "a detail from an older revision is discarded");

console.log("app adapter effect-port tests passed");
