#!/usr/bin/env python3
"""Exercise the production QML bridge with real Quickshell and Rust pipes.

No test QML imports, desktop session, credentials or network are needed.
"""
import base64
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import tomllib


ROOT = Path(__file__).resolve().parent.parent

QML = r'''
import QtQuick
import Quickshell
import __MODULE__ as BackendModule

Scope {
  id: root
  property bool began: false
  property int completed: 0
  property string body: "\x00\xff\r\n" + "abc123".repeat(200000)

  function check(ok, message) {
    if (!ok) {
      console.error("BACKEND_PROCESS_FAIL: " + message)
      Qt.quit()
      throw new Error(message)
    }
  }

  function done() {
    completed++
    if (completed !== 7) return
    backend.shutdown(function(error) {
      check(!error, "shutdown error")
      check(backend.shutdownFinished && !backend.connected, "shutdown not confirmed")
      console.log("BACKEND_PROCESS_PASS")
      Qt.quit()
    })
  }

  BackendModule.Backend {
    id: backend
    executable: __BINARY__
    expectedVersion: __VERSION__
    expectedApiVersion: 1
    onReadyChanged: {
      if (!ready || root.began) return
      root.began = true
      root.check(protocolInfo.name === "omamail", "handshake")
      call("accounts.list", {}, function(result, error) {
        root.check(!error && result.accounts.length === 1, "account listing")
        root.check(result.accounts[0].id === "local@example.org", "account identity")
        root.check(JSON.stringify(result).indexOf("synthetic-secret") === -1,
                   "credential projection")
        root.done()
      })
      call("providers.list", {}, function(result, error) {
        root.check(!error && JSON.stringify(result).indexOf("gmail") !== -1,
                   "provider listing correlation")
        root.done()
      })
      call("system.info", { unexpected: true }, function(result, error) {
        root.check(!result && error && error.code === -32602, "error correlation")
        root.done()
      })
      var cacheText = "合成📨".repeat(200000)
      call("cache.bodyPut", {accountId:"local@example.org",id:"large:Inbox",body:{text:cacheText}}, function(result, error) {
        root.check(!error && result.stored, "automatic JSON upload to native cache")
        backend.call("cache.bodyRead", {accountId:"local@example.org",id:"large:Inbox"}, function(body, failure) {
          root.check(!failure && body.text === cacheText, "native cache Unicode and response chunks")
          backend.call("cache.bodyClear", {accountId:"local@example.org"}, function(answer, failed) {
            root.check(!failed && answer.cleared, "native cache clear")
            backend.call("cache.bodyRead", {accountId:"local@example.org",id:"large:Inbox"}, function(miss, failedRead) {
              root.check(!failedRead && miss === null, "cleared cache must miss")
              root.done()
            })
          })
        })
      })
      call("cache.resourcePut", {accountId:"local@example.org", id:"prefetched", resource:{
        id:"prefetched", payload:{mimeType:"multipart/mixed", headers:[], parts:[
          {mimeType:"text/plain",body:{data:"aGVsbG8"}},
          {mimeType:"text/html",body:{data:"PHA-TmF0aXZlIHJlYWRlcjwvcD48c2NyaXB0PmhpZGRlbkV4ZWN1dGFibGUoKTwvc2NyaXB0PjxpbWcgc3JjPSJodHRwczovL2V4YW1wbGUub3JnL3BpeGVsLnBuZyI-"}},
          {mimeType:"application/octet-stream",filename:"large.bin",body:{attachmentId:"part-one",size:300000,data:"eHh4".repeat(100000)}}
        ]}
      }}, function(result, error) {
        root.check(!error && result.stored, "native resource cache write")
        backend.call("message.prepareCached", {accountId:"local@example.org",id:"prefetched"}, function(prepared, failure) {
          root.check(!failure && prepared.nativeContent.body.text === "hello", "native cache prepares reader")
          root.check(prepared.nativeContent.attachments[0].attachmentId === "part-one", "cached attachment locator")
          root.check(prepared.payload.parts[1].body.data === undefined, "cached attachment bytes stay native")
          root.check(JSON.stringify(prepared).length < 8192, "cached reader projection stays small")
          backend.call("reader.open", {accountId:"local@example.org",id:"prefetched",
            requestId:"reader-integration",cacheOnly:true,now:Date.now(),options:{allowRemoteImages:false}}, function(view, failed) {
            root.check(!failed && view.readerKey && view.nativeContent.body.text === "hello", "native cached full reader pipeline")
            root.check(view.nativeContent.html === undefined && view.hasHtml, "raw HTML remains native")
            root.check(view.payload.parts.length === 0, "MIME octets remain native")
            root.check(view.nativeRender.html === undefined && view.nativeRender.reader.html === undefined,
                       "duplicate HTML does not cross the bridge")
            root.check(JSON.stringify(view.nativeRender.document).indexOf("hiddenExecutable") === -1
                       && JSON.stringify(view.nativeRender.reader.document).indexOf("hiddenExecutable") === -1,
                       "both reader documents are sanitized")
            root.check(view.nativeContent.attachments[0].attachmentId === "part-one", "reader attachment locator retained")
            root.check(JSON.stringify(view).length < 16384, "full reader projection excludes large attachments")
            backend.call("reader.render", {accountId:"local@example.org",id:"prefetched",readerKey:view.readerKey,
              now:Date.now(),options:{allowRemoteImages:false}}, function(rendered, renderFailure) {
              root.check(!renderFailure && rendered.nativeRender.revision === view.nativeRender.revision
                         && JSON.stringify(rendered.nativeRender.document) === JSON.stringify(view.nativeRender.document)
                         && JSON.stringify(rendered.nativeRender.reader.document) === JSON.stringify(view.nativeRender.reader.document),
                         "rerender uses native identity without raw HTML upload")
              backend.call("reader.render", {accountId:"local@example.org",id:"another-message",readerKey:view.readerKey,
                now:Date.now(),options:{}}, function(wrong, wrongError) {
                root.check(!wrong && wrongError, "reader source cannot cross message identity")
                root.done()
              })
            })
          })
          root.done()
        })
      })
      parseMessage("Content-Type: application/octet-stream\r\n\r\n" + root.body,
                   function(result, error) {
        root.check(!error && result.body.size === root.body.length, "large upload")
        root.check(result.body.data === __EXPECTED__, "chunked response bytes")
        root.done()
      })
    }
    onFailureChanged: {
      if (failure !== "") root.check(false, failure)
    }
  }

  Timer {
    interval: 20000
    running: true
    onTriggered: root.check(false, "integration deadline")
  }
}
'''


def main():
    qs = shutil.which("qs")
    if not qs:
        raise SystemExit("Quickshell is required: install it, then rerun make test-backend-process")
    binary = ROOT / "target/debug/omamail"
    version = tomllib.loads((ROOT / "Cargo.toml").read_text())["package"]["version"]
    with tempfile.TemporaryDirectory(prefix="omamail-backend-process-") as directory:
        temporary = Path(directory)
        env = os.environ.copy()
        for key in list(env):
            if key.startswith(("QML", "QS_")):
                del env[key]
        env.pop("WAYLAND_DISPLAY", None)
        for key in ("HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR"):
            path = temporary / key.lower()
            path.mkdir(mode=0o700)
            env[key] = str(path)
        env.update(QT_QPA_PLATFORM="offscreen", QT_QUICK_BACKEND="software", QT_QPA_PLATFORMTHEME="")
        registry = Path(env["XDG_CONFIG_HOME"]) / "omamail/accounts.json"
        registry.parent.mkdir()
        source = json.dumps({"version": 1, "accounts": [
            {"email": "local@example.org", "clientSecret": "synthetic-secret"}
        ]})
        registry.write_text(source)
        # Quickshell's scanner confines relative imports to the config root.
        # Copy the production modules unchanged, without the mock Io module.
        for module in ("backend", "message"):
            shutil.copytree(ROOT / "ui" / module, temporary / module)
        qml = QML.replace("__MODULE__", '"backend"')
        qml = qml.replace("__BINARY__", json.dumps(str(binary)))
        qml = qml.replace("__VERSION__", json.dumps(version))
        expected = base64.urlsafe_b64encode(b"\x00\xff\r\n" + b"abc123" * 200000).decode().rstrip("=")
        qml = qml.replace("__EXPECTED__", json.dumps(expected))
        config = temporary / "shell.qml"
        config.write_text(qml)
        process = subprocess.Popen(
            [qs, "--no-color", "--path", str(config)], env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            start_new_session=True,
        )
        try:
            output, _ = process.communicate(timeout=30)
        finally:
            # Also reap the backend if a failed QML assertion stopped its parent.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
        assert process.returncode == 0, output
        assert "BACKEND_PROCESS_PASS" in output, output
        assert "BACKEND_PROCESS_FAIL" not in output, output
        assert registry.read_text() == source, "read-only listing changed account settings"
    print("backend process: real handshake, concurrent calls, MIME/JSON uploads, native cache/chunks, reader projection/rerender isolation and confirmed shutdown passed")


if __name__ == "__main__":
    main()
