#!/usr/bin/env python3
"""Exercise a frontend's API contract against an explicitly selected binary.

Uses the production QML JavaScript request, frame and response codecs in Node.
Only synthetic data, dry runs and local storage operations are used; no real account, credential,
mail server, or external agent is configured. This is a compatibility gate, not
an exhaustive provider/network integration suite.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import signal
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
WINDOWS_CREATE_NEW_PROCESS_GROUP = getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0x00000200)


def process_group_options(platform=None):
    """Start the Node harness in a group that can be torn down with its backend."""
    if (platform or os.name) == 'nt':
        return {'creationflags': WINDOWS_CREATE_NEW_PROCESS_GROUP}
    return {'start_new_session': True}


def terminate_process_group(process, platform=None):
    """Terminate a timed-out harness and every backend process it created."""
    if process.poll() is not None:
        return
    if (platform or os.name) == 'nt':
        subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        if process.poll() is None:
            process.kill()
    else:
        os.killpg(process.pid, signal.SIGKILL)

HARNESS = r"""
const fs = require('fs');
const assert = require('assert/strict');
const {spawn} = require('child_process');
const {load} = require(process.env.CONTRACT_ROOT + '/ui/tests/load.js');
const Wire = load('backend/Wire.js');
const Chunks = load('backend/Chunks.js');
const whole = JSON.parse(fs.readFileSync(process.env.CONTRACT_ROOT + '/backend-api.json'));
// The pinned, published binary is asked only for the released API; a binary
// built from this checkout for all of it.
const released = process.env.CONTRACT_RELEASED === '1';
const standalone = process.env.CONTRACT_STANDALONE === '1';
const unreleased = whole.unreleased || {methods: [], cases: []};
const selected = released ? {
  apiVersion: whole.releasedApiVersion, protocolVersion: whole.protocolVersion,
  methods: whole.methods.filter(m => !unreleased.methods.includes(m)),
  contractCases: whole.contractCases.filter(c => !unreleased.cases.includes(c.name))
} : whole;
// Agent RPC is a plugin-only capability. The standalone binary must omit its
// inventory and reject every agent method without touching storage.
const unavailable = standalone ? selected.methods.filter(m => m.startsWith('agent.')) : [];
const contract = standalone ? {
  ...selected,
  methods: selected.methods.filter(m => !m.startsWith('agent.')),
  contractCases: selected.contractCases.filter(c => !c.method.startsWith('agent.'))
} : selected;
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
async function call(method, params = {}, errorCode = null, advertised = true) {
  assert.equal(contract.methods.includes(method), advertised, 'method inventory: ' + method);
  if (advertised) tested.add(method);
  const id = String(++serial);
  const reply = await new Promise(resolve => {
    pending.set(id, {resolve, timer:setTimeout(() => fail(new Error('RPC deadline: ' + method)), 10000)});
    child.stdin.write(Wire.request(id, method, params));
  });
  if (errorCode !== null) { assert.equal(reply.error && reply.error.code, errorCode, method + ': ' + JSON.stringify(reply.error)); return reply.error; }
  assert.ok(!reply.error, method + ': ' + JSON.stringify(reply.error));
  return reply.result;
}
function safeDocument(value) {
  assert.ok(value && typeof value === 'object');
  assert.ok(!JSON.stringify(value).includes('forbiddenScript'));
}
function storageSnapshot(directory = process.env.HOME) {
  const snapshot = {};
  function visit(path) {
    const stat = fs.lstatSync(path, {bigint:true});
    snapshot[path] = [String(stat.mode), String(stat.ino), String(stat.mtimeNs),
      stat.isFile() ? fs.readFileSync(path).toString('base64') : null];
    if (stat.isDirectory()) for (const name of fs.readdirSync(path).sort()) visit(path + '/' + name);
  }
  visit(directory);
  return snapshot;
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
  if (standalone) assert.equal(info.capabilities && info.capabilities.agent, false, 'standalone disables agent capability');
  for (const method of unavailable) {
    assert.ok(!info.methods.includes(method), 'standalone does not advertise: ' + method);
    const before = storageSnapshot();
    const error = await call(method, {}, -32601, false);
    assert.equal(error.message, 'Method not found');
    assert.deepEqual(storageSnapshot(), before, method + ': disabled method has no effects');
  }
  if (!released) {
    for (const method of ['jmap.actionAvailability', 'jmap.actionRows']) {
      assert.ok(!info.methods.includes(method), 'internal planner is not advertised');
      const before = storageSnapshot();
      const error = await call(method, {}, -32000, false);
      assert.equal(error.message, 'method_not_found');
      assert.deepEqual(storageSnapshot(), before, 'unknown method has no account or provider effects');
    }
  }
  // Versioned request/response fixtures live with the published API inventory.
  function at(value, path) { return path ? path.split('.').reduce((v, key) => v === undefined || v === null ? undefined : v[key], value) : value; }
  assert.ok(Array.isArray(contract.contractCases) && contract.contractCases.length);
  for (const fixture of contract.contractCases) {
    const registryPath = process.env.CONTRACT_REGISTRY_PATH;
    const emptyRegistry = fixture.name === 'mail list requires an account';
    const registryBefore = emptyRegistry ? fs.readFileSync(registryPath) : null;
    if (emptyRegistry) fs.writeFileSync(registryPath, JSON.stringify({version:1,accounts:[]}));
    // The full isolated HOME includes seeded cache/config/state sentinels,
    // credential helper effects and any newly created outbox/draft files.
    const noWrites = fixture.method.startsWith('mail.') || fixture.name === 'recovery rejects invalid edit history';
    const before = noWrites ? storageSnapshot() : null;
    const value = await call(fixture.method, fixture.params, fixture.errorCode === undefined ? null : fixture.errorCode);
    if (noWrites) assert.deepEqual(storageSnapshot(), before, fixture.name + ': no storage or credential effects');
    if (emptyRegistry) fs.writeFileSync(registryPath, registryBefore);
    for (const [path, expected] of Object.entries(fixture.equals || {})) {
      const actual = at(value, path);
      // Production codecs run in a VM; compare JSON values across its realm,
      // not the Array/Object prototypes of the Node fixture loader.
      assert.deepEqual(actual === undefined ? undefined : JSON.parse(JSON.stringify(actual)), expected, fixture.name + ': ' + path);
    }
    for (const [path, expected] of Object.entries(fixture.types || {})) {
      const actual = at(value, path);
      const type = Array.isArray(actual) ? 'array' : actual === null ? 'null' : typeof actual;
      assert.equal(type, expected, fixture.name + ': ' + path);
    }
    if (fixture.name === 'recovery reads edit history')
      assert.equal(value.record.parked[1].userModified, undefined, 'legacy edit history remains absent');
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
  console.log(`Backend API ${api}${released ? ' (released view)' : ''} contract PASS: ${tested.size} methods, ${contract.methods.length} advertised methods; binary ${info.version}`);
  finished = true;
  child.stdin.end();
  child.kill('SIGTERM');
})().catch(fail);
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--expected-version')
    parser.add_argument('--released', action='store_true',
                        help='check only the released API, as the pinned published binary speaks it')
    parser.add_argument('--standalone', action='store_true',
                        help='check the standalone frontend subset and require agent RPC to be disabled')
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
        # macOS exposes its temporary root through /var, a symlink to
        # /private/var. The production storage boundary refuses symlinked
        # ancestors, so seed and advertise the canonical isolated root.
        home = Path(directory).resolve()
        env = {key: value for key, value in os.environ.items()
               if key in ('PATH', 'LANG', 'LC_ALL', 'SYSTEMROOT')}
        if os.name == 'nt':
            config_root = home / 'AppData/Roaming'
            local_root = home / 'AppData/Local'
            cache_root = local_root / 'OmamailData/Cache'
            state_root = local_root / 'OmamailData/State'
            data_root = local_root / 'OmamailData'
            runtime_root = local_root / 'OmamailData/Runtime'
            env.update(USERPROFILE=str(home), APPDATA=str(config_root),
                       LOCALAPPDATA=str(local_root))
        elif sys.platform == 'darwin':
            config_root = home / 'Library/Application Support'
            cache_root = home / 'Library/Caches'
            state_root = config_root
            data_root = config_root
            runtime_root = home / 'run'
        else:
            config_root = home / 'config'
            cache_root = home / 'cache'
            state_root = home / 'state'
            data_root = home / 'data'
            runtime_root = home / 'run'
            env.update(XDG_CONFIG_HOME=str(config_root), XDG_CACHE_HOME=str(cache_root),
                       XDG_DATA_HOME=str(data_root), XDG_STATE_HOME=str(state_root),
                       XDG_RUNTIME_DIR=str(runtime_root))
        registry = config_root / 'omamail/accounts.json'
        env.update(HOME=str(home), TMPDIR=str(runtime_root), TEMP=str(runtime_root),
                   TMP=str(runtime_root), CONTRACT_REGISTRY_PATH=str(registry),
                   CONTRACT_ROOT=str(ROOT), CONTRACT_BINARY=str(binary),
                   CONTRACT_VERSION=args.expected_version or '',
                   CONTRACT_RELEASED='1' if args.released else '',
                   CONTRACT_STANDALONE='1' if args.standalone else '')
        runtime_root.mkdir(parents=True, mode=0o700)
        registry.parent.mkdir(parents=True)
        # Every provider the contract cases name is registered in both views:
        # a released case is the same fixture it was while unreleased.
        accounts = [
            {'email': 'contract@example.org'},
            {'provider': 'imap', 'email': 'sender@example.org',
             'imap': {'username': 'sender@example.org'}},
            {'provider': 'hey', 'email': 'sender@example.org'},
            {'provider': 'outlook', 'email': 'sender@example.org'}]
        registry.write_text(json.dumps({'version': 1, 'activeId': 'contract@example.org',
                                        'accounts': accounts}))
        registry.chmod(0o600)
        for root in (cache_root, state_root, data_root):
            sentinel = root / 'omamail/sentinel'
            sentinel.parent.mkdir(parents=True, exist_ok=True)
            sentinel.write_bytes(b'preserve existing user state\n')
        helpers = home / 'bin'
        helpers.mkdir()
        credential_helper = helpers / 'secret-tool'
        credential_helper.write_text('#!/bin/sh\nprintf touched >> "$HOME/credential-touched"\nexit 1\n')
        credential_helper.chmod(0o700)
        env['PATH'] = str(helpers) + os.pathsep + env.get('PATH', '')
        if os.name == 'nt':
            # The private storage check wants what the backend itself creates:
            # owned by this user, with a protected DACL naming nobody else.
            # What mkdir made here inherits the runner's ACL and, from an
            # elevated token, belongs to Administrators. The whole fixture home
            # is made private the same way, files included.
            #
            # One object at a time: an inheritance flag on a file's ACE makes
            # it inherit-only, which grants the file's own reader nothing.
            user = os.environ['USERNAME']
            subprocess.run(['icacls', str(home), '/setowner', user, '/T', '/Q'],
                           check=True, capture_output=True)
            for path in [home] + sorted(home.rglob('*')):
                grant = user + (':(OI)(CI)F' if path.is_dir() else ':F')
                subprocess.run(['icacls', str(path), '/inheritance:r', '/grant:r', grant, '/Q'],
                               check=True, capture_output=True)
        process = subprocess.Popen(['node', '-e', HARNESS], env=env, cwd=home,
                                   **process_group_options())
        try:
            status = process.wait(timeout=60)
        finally:
            # A failed/expired harness must not leave its backend running.
            try:
                terminate_process_group(process)
            except (OSError, ProcessLookupError):
                pass
            process.wait(timeout=10)
        if status:
            raise SystemExit(status)


if __name__ == '__main__':
    main()
