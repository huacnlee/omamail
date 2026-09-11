#!/usr/bin/env python3
"""Exercise the plugin's API contract against an explicitly selected binary.

Uses the production QML JavaScript request, frame and response codecs in Node.
Only synthetic data and cache-only operations are used; no real account, credential,
mail server, or external agent is configured. This is a compatibility gate, not
an exhaustive provider/network integration suite.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import signal
import tempfile

ROOT = Path(__file__).resolve().parents[1]

HARNESS = r"""
const fs = require('fs');
const assert = require('assert/strict');
const {spawn} = require('child_process');
const {load} = require(process.env.CONTRACT_ROOT + '/ui/tests/load.js');
const Wire = load('backend/Wire.js');
const Chunks = load('backend/Chunks.js');
const contract = JSON.parse(fs.readFileSync(process.env.CONTRACT_ROOT + '/backend-api.json'));
const child = spawn(process.env.CONTRACT_BINARY, ['serve'], {stdio:['pipe','pipe','pipe']});
let buffer = '', state = null, serial = 0, finished = false;
const pending = new Map();
const tested = new Set();
function fail(error) { console.error(error.stack || error); child.kill('SIGKILL'); process.exit(1); }
child.on('error', fail);
child.on('exit', code => { if (!finished) fail(new Error('Backend exited before contract completed: ' + code)); });
// Stderr is consumed, bounded and never printed: errors must not dump mail data.
let stderrBytes = 0;
child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 1048576) fail(new Error('Excessive backend stderr')); });
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => {
  try {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      const decoded = Chunks.decode(state, line); state = decoded.state;
      assert.ok(!decoded.error, 'production chunk decoder accepts frame');
      if (decoded.line === null) continue;
      if (Wire.notificationValue(decoded.value)) continue;
      const reply = Wire.responseValue(decoded.value);
      assert.ok(reply && pending.has(reply.id), 'production response codec and request correlation');
      const entry = pending.get(reply.id); pending.delete(reply.id); clearTimeout(entry.timer);
      entry.resolve(reply);
    }
    assert.ok(buffer.length < 1048576, 'bounded unfinished frame');
  } catch (error) { fail(error); }
});
async function call(method, params = {}, errorCode = null) {
  assert.ok(contract.methods.includes(method), 'tested method belongs to contract: ' + method);
  tested.add(method);
  const id = String(++serial);
  const reply = await new Promise(resolve => {
    pending.set(id, {resolve, timer:setTimeout(() => fail(new Error('RPC deadline: ' + method)), 10000)});
    child.stdin.write(Wire.request(id, method, params));
  });
  if (errorCode !== null) { assert.equal(reply.error && reply.error.code, errorCode, method); return reply.error; }
  assert.ok(!reply.error, method + ': ' + JSON.stringify(reply.error));
  return reply.result;
}
function safeDocument(value) {
  assert.ok(value && typeof value === 'object');
  assert.ok(!JSON.stringify(value).includes('forbiddenScript'));
}
(async () => {
  const info = await call('system.info');
  assert.equal(info.name, 'omamail');
  assert.equal(info.protocol, contract.protocolVersion);
  if (process.env.CONTRACT_VERSION) assert.equal(info.version, process.env.CONTRACT_VERSION);
  const api = info.apiVersion === undefined && info.version === '0.9.0' ? 1 : info.apiVersion;
  assert.equal(api, contract.apiVersion, 'API version (only released 0.9.0 has a legacy fallback)');
  assert.ok(Array.isArray(info.methods));
  for (const method of contract.methods) assert.ok(info.methods.includes(method), 'advertised API method: ' + method);
  // Versioned request/response fixtures live with the published API inventory.
  function at(value, path) { return path ? path.split('.').reduce((v, key) => v === undefined || v === null ? undefined : v[key], value) : value; }
  assert.ok(Array.isArray(contract.contractCases) && contract.contractCases.length);
  for (const fixture of contract.contractCases) {
    const value = await call(fixture.method, fixture.params, fixture.errorCode === undefined ? null : fixture.errorCode);
    for (const [path, expected] of Object.entries(fixture.equals || {}))
      assert.deepEqual(at(value, path), expected, fixture.name + ': ' + path);
    for (const [path, expected] of Object.entries(fixture.types || {})) {
      const actual = at(value, path);
      const type = Array.isArray(actual) ? 'array' : actual === null ? 'null' : typeof actual;
      assert.equal(type, expected, fixture.name + ': ' + path);
    }
  }

  await call('message.parse', {raw:17}, -32602);
  const providers = await call('providers.snapshot');
  for (const id of ['gmail','outlook','hey','jmap','imap']) {
    assert.ok(providers[id] && providers[id].queries && providers[id].capabilities);
    assert.equal(typeof providers[id].nativeSync, 'boolean');
  }
  const text = 'Hello 合成 📨';
  const raw = 'From: Sender <sender@example.org>\r\nTo: reader@example.org\r\nSubject: Contract message\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n' + text;
  const payload = await call('message.parse', {raw:Buffer.from(raw).toString('base64url')});
  assert.equal(payload.mimeType, 'text/plain');
  assert.equal(Buffer.from(payload.body.data, 'base64url').toString(), text);
  const message = {id:'contract-message',labelIds:['INBOX','UNREAD'],internalDate:'1700000000000',payload};
  const prepared = await call('message.prepare', {message, now:1700000000000});
  assert.equal(prepared.body.text, text);
  assert.equal(prepared.summary.subject, 'Contract message');
  assert.ok(Array.isArray(prepared.attachments));
  const summary = await call('message.summarize', {message, now:1700000000000});
  assert.deepEqual(summary, prepared.summary);
  const html = '<p>Safe text</p><script>forbiddenScript()</script><img src="https://example.org/pixel.png">';
  const rendered = await call('message.render', {html, options:{allowRemoteImages:false,withReader:true}});
  safeDocument(rendered.document); safeDocument(rendered.reader.document);
  assert.ok(!JSON.stringify(rendered.document).includes('https://example.org/pixel.png'));
  const accountId = 'contract@example.org', id = 'cached';
  const resource = {id,payload:{mimeType:'multipart/alternative',headers:payload.headers,parts:[payload,
    {mimeType:'text/html',body:{data:Buffer.from(html).toString('base64url')}}]}};
  assert.equal((await call('cache.resourcePut', {accountId,id,resource})).stored, true);
  const cached = await call('message.prepareCached', {accountId,id});
  assert.equal(cached.nativeContent.body.text, text);
  assert.equal(cached.payload.parts[0].body.data, undefined);
  assert.equal(await call('message.prepareCached', {accountId,id:'missing'}), null);
  const view = await call('reader.open', {accountId,id,requestId:'contract-reader',now:1700000000000,cacheOnly:true,options:{allowRemoteImages:false}});
  assert.equal(typeof view.readerKey, 'string'); assert.ok(view.readerKey.length);
  assert.equal(view.hasHtml, true); assert.equal(view.nativeContent.body.text, text);
  assert.equal(view.nativeContent.html, undefined); assert.equal(view.payload.parts.length, 0);
  safeDocument(view.nativeRender.document); safeDocument(view.nativeRender.reader.document);
  const again = await call('reader.render', {accountId,id,readerKey:view.readerKey,now:1700000000000,options:{allowRemoteImages:false}});
  assert.equal(again.nativeRender.revision, view.nativeRender.revision);
  assert.deepEqual(again.nativeRender.document, view.nativeRender.document);
  // Cross-message identity must fail, without falling through to a network read.
  const wrong = await call('reader.render', {accountId,id:'other',readerKey:view.readerKey,now:1700000000000,options:{}}, -32000);
  assert.equal(typeof wrong.message, 'string');
  // More than one transport frame, with Unicode preserved by the actual QML decoder.
  const large = '合成 📨'.repeat(30000);
  assert.equal((await call('cache.bodyPut', {accountId,id:'chunked',body:{text:large}})).stored, true);
  assert.equal((await call('cache.bodyRead', {accountId,id:'chunked'})).text, large);
  assert.equal((await call('cache.bodyClear', {accountId})).cleared, true);
  assert.equal(await call('cache.bodyRead', {accountId,id:'chunked'}), null);
  console.log(`Backend API ${api} contract PASS: ${tested.size} methods, ${contract.methods.length} advertised methods; binary ${info.version}`);
  finished = true;
  child.stdin.end();
  child.kill('SIGTERM');
})().catch(fail);
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--expected-version')
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    contract = json.loads((ROOT / 'backend-api.json').read_text())
    if (type(contract.get('apiVersion')) is not int or contract['apiVersion'] < 1
            or type(contract.get('protocolVersion')) is not int
            or not isinstance(contract.get('methods'), list)
            or not all(isinstance(method, str) and method for method in contract['methods'])
            or len(contract['methods']) != len(set(contract['methods']))):
        raise SystemExit('Invalid backend-api.json')
    with tempfile.TemporaryDirectory(prefix='omamail-api-contract-') as directory:
        home = Path(directory)
        env = {key: value for key, value in os.environ.items()
               if key in ('PATH', 'LANG', 'LC_ALL', 'SYSTEMROOT')}
        env.update(HOME=str(home), XDG_CONFIG_HOME=str(home / 'config'),
                   XDG_CACHE_HOME=str(home / 'cache'), XDG_DATA_HOME=str(home / 'data'),
                   XDG_STATE_HOME=str(home / 'state'), XDG_RUNTIME_DIR=str(home / 'run'),
                   CONTRACT_ROOT=str(ROOT), CONTRACT_BINARY=str(binary),
                   CONTRACT_VERSION=args.expected_version or '')
        (home / 'run').mkdir(mode=0o700)
        registry = home / 'config/omamail/accounts.json'
        registry.parent.mkdir(parents=True)
        registry.write_text(json.dumps({'version': 1, 'accounts': [{'email': 'contract@example.org'}]}))
        registry.chmod(0o600)
        process = subprocess.Popen(['node', '-e', HARNESS], env=env, cwd=home,
                                   start_new_session=True)
        try:
            status = process.wait(timeout=60)
        finally:
            # A failed/expired harness must not leave its backend running.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
        if status:
            raise SystemExit(status)


if __name__ == '__main__':
    main()
