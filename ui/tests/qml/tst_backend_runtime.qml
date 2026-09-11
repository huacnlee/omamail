import QtQuick
import QtTest
import "../../backend" as BackendModule

Item {
  Component {
    id: factory
    BackendModule.Runtime { pluginDir: "/synthetic/plugin" }
  }
  Component {
    id: backendFactory
    BackendModule.Backend {
      property var runtime
      executable: "/synthetic/plugin/runtime/bin/omamail"
      expectedVersion: runtime.requiredVersion
      expectedApiVersion: runtime.requiredApiVersion
      launchEnabled: runtime.state === "ready" && runtime.executable === executable
      Connections {
        target: runtime
        function onValidated() { Qt.callLater(reconcileProcess) }
      }
    }
  }
  TestCase {
    name: "PrivateRuntime"
    function make() { return createTemporaryObject(factory, parent) }
    function processOf(runtime) {
      for (var i = 0; i < runtime.children.length; i++)
        if (runtime.children[i].command) return runtime.children[i]
      fail("Missing runtime process")
    }
    function reply(runtime, state, version, error, cliInstalled) {
      var process = processOf(runtime)
      process.running = false
      process.stdout.read(JSON.stringify({ state: state, requiredVersion: "0.8.2", requiredApiVersion: 1,
        installedVersion: version, executable: "/synthetic/plugin/runtime/bin/omamail", error: error || "",
        cliInstalled: cliInstalled === true }))
      process.exited(error ? 1 : 0)
    }
    function test_missing_requires_explicit_install() {
      var runtime = make()
      compare(processOf(runtime).command[2], "status")
      compare(runtime.executable, "")
      reply(runtime, "missing", "")
      compare(runtime.executable, "")
      compare(runtime.canInstall, true)
      compare(processOf(runtime).command[2], "status")
      runtime.install()
      compare(processOf(runtime).command[2], "install")
      reply(runtime, "ready", "0.8.2")
      compare(runtime.executable, "")
      verify(runtime.state !== "ready")
      wait(0)
      compare(processOf(runtime).command[2], "status")
      compare(runtime.executable, "")
      reply(runtime, "ready", "0.8.2")
      compare(runtime.executable, "/synthetic/plugin/runtime/bin/omamail")
    }
    function test_failed_install_is_retryable_and_never_exposes_binary() {
      var runtime = make()
      reply(runtime, "mismatch", "0.8.1")
      runtime.install()
      reply(runtime, "error", "0.8.1", "Download failed")
      compare(runtime.executable, "")
      compare(runtime.error, "Download failed")
      compare(runtime.canInstall, true)
    }
    function test_development_disables_mutations() {
      var runtime = make()
      runtime.developmentExecutable = "/tmp/dev/omamail"
      reply(runtime, "mismatch", "0.8.1")
      runtime.install()
      runtime.enableCli()
      runtime.disableCli()
      compare(processOf(runtime).command[2], "status")
    }
    function test_cli_install_updates_state_and_cannot_repeat() {
      var runtime = make()
      reply(runtime, "ready", "0.8.2")
      compare(runtime.cliInstalled, false)
      runtime.enableCli()
      compare(processOf(runtime).command[2], "enable-cli")
      reply(runtime, "ready", "0.8.2", "", true)
      compare(runtime.cliInstalled, true)
      runtime.enableCli()
      compare(processOf(runtime).running, false)
      runtime.disableCli()
      compare(processOf(runtime).command[2], "disable-cli")
      reply(runtime, "ready", "0.8.2", "", false)
      compare(runtime.cliInstalled, false)
    }
    function test_initial_status_recognizes_existing_cli_link() {
      var runtime = make()
      reply(runtime, "ready", "0.8.2", "", true)
      compare(runtime.cliInstalled, true)
      runtime.enableCli()
      compare(processOf(runtime).command[2], "status")
      compare(processOf(runtime).running, false)
      runtime.refresh()
      reply(runtime, "error", "", "Probe failed", true)
      compare(runtime.cliInstalled, false)
    }
    function readyBackend(runtime) {
      var backend = createTemporaryObject(backendFactory, parent, { runtime: runtime })
      var process = processOf(backend)
      process.started()
      var handshake = JSON.parse(process.written.trim())
      backend.receive(JSON.stringify({ jsonrpc: "2.0", id: handshake.id,
        result: { name: "omamail", apiVersion: 1, protocol: 1, version: "0.8.2",
          methods: ["system.info", "system.quit"] } }))
      verify(backend.ready)
      return backend
    }
    function test_chunked_response_delivers_once_after_complete_json() {
      var runtime = make()
      reply(runtime, "ready", "0.8.2")
      var backend = readyBackend(runtime)
      var process = processOf(backend)
      var calls = 0
      var received = null
      backend.call("reader.render", {}, function(value, error) { calls++; received = value; compare(error, null) })
      var request = JSON.parse(process.written.trim().split("\n").pop())
      var result = {text: "مرحبا📨", document: {type: "root", children: []}}
      var encoded = JSON.stringify({jsonrpc: "2.0", id: request.id, result: result})
      var middle = Math.floor(encoded.length / 2)
      backend.receive(JSON.stringify({jsonrpc: "2.0", method: "transport.chunk", params: {
        transfer: "4", index: 0, total: 2, size: encoded.length, data: encoded.slice(0, middle)}}))
      compare(calls, 0)
      backend.receive(JSON.stringify({jsonrpc: "2.0", method: "transport.chunk", params: {
        transfer: "4", index: 1, total: 2, size: encoded.length, data: encoded.slice(middle)}}))
      compare(calls, 1)
      compare(received, result)
      compare(backend.responseTransfer, null)
    }

    function test_successful_recheck_preserves_pending_request() {
      var runtime = make()
      reply(runtime, "ready", "0.8.2")
      var backend = readyBackend(runtime)
      var process = processOf(backend)
      var calls = 0
      var result = null
      backend.call("gmail.modify", {}, function(value, error) {
        calls++
        compare(error, null)
        result = value
      })
      var request = JSON.parse(process.written.trim().split("\n").pop())
      runtime.refresh()
      wait(0)
      verify(process.running)
      verify(backend.ready)
      compare(calls, 0)
      reply(runtime, "ready", "0.8.2")
      wait(0)
      verify(process.running)
      verify(backend.ready)
      compare(calls, 0)
      backend.receive(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true } }))
      compare(calls, 1)
      compare(result.ok, true)
    }
    function test_failed_recheck_revokes_pending_request_data() {
      return [ { tag: "mismatch", state: "mismatch", version: "0.8.1", error: "" },
        { tag: "missing", state: "missing", version: "", error: "" },
        { tag: "failure", state: "error", version: "", error: "Probe failed" },
        { tag: "invalid-ready", state: "ready", version: "0.8.1", error: "" } ]
    }
    function test_failed_recheck_revokes_pending_request(data) {
      var runtime = make()
      reply(runtime, "ready", "0.8.2")
      var backend = readyBackend(runtime)
      var calls = 0
      var failure = null
      backend.call("gmail.modify", {}, function(_result, error) { calls++; failure = error })
      runtime.refresh()
      wait(0)
      compare(calls, 0)
      reply(runtime, data.state, data.version, data.error)
      wait(0)
      verify(!backend.ready)
      verify(!processOf(backend).running)
      compare(calls, 1)
      verify(failure !== null)
    }
    function test_successful_recheck_restarts_failed_backend() {
      var runtime = make()
      reply(runtime, "ready", "0.8.2")
      var backend = readyBackend(runtime)
      backend.stopForFailure("Incompatible backend")
      verify(!processOf(backend).running)
      runtime.refresh()
      reply(runtime, "ready", "0.8.2")
      wait(0)
      verify(processOf(backend).running)
      verify(!backend.ready)
    }
    function test_changed_required_version_requires_new_handshake() {
      var runtime = make()
      reply(runtime, "ready", "0.8.2")
      var backend = readyBackend(runtime)
      runtime.refresh()
      var process = processOf(runtime)
      process.running = false
      process.stdout.read(JSON.stringify({ state: "ready", requiredVersion: "0.8.3", requiredApiVersion: 1,
        installedVersion: "0.8.3", executable: runtime.executable, error: "" }))
      process.exited(0)
      verify(!backend.launchEnabled)
      wait(0)
      wait(0)
      compare(backend.expectedVersion, "0.8.3")
      verify(!backend.ready)
      verify(processOf(backend).running)
      processOf(backend).started()
      var request = JSON.parse(processOf(backend).written.trim().split("\n").pop())
      backend.receive(JSON.stringify({ jsonrpc: "2.0", id: request.id,
        result: { name: "omamail", apiVersion: 1, protocol: 1, version: "0.8.2",
          methods: ["system.info", "system.quit"] } }))
      verify(!backend.ready)
      verify(!processOf(backend).running)
    }
  }
}
