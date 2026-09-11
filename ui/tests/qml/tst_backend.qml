import QtQuick
import QtTest
import "../../backend" as BackendModule

Item {
  Component {
    id: backendFactory
    BackendModule.Backend {
      executable: "/tmp/omamail-synthetic-backend"
      expectedVersion: "0.8.2"
      expectedApiVersion: 1
    }
  }

  TestCase {
    name: "BackendLifecycle"

    function test_agent_context_deadline_includes_uploaded_operation() {
      var backend = makeBackend()
      makeReady(backend)
      var before = Date.now()
      backend.call("agent.context", {}, function() {})
      backend.call("request.upload", {method:"agent.context",upload:"synthetic"}, function() {})
      backend.call("message.prepare", {}, function() {})
      var pending = Object.keys(backend.pending).map(function(id) { return backend.pending[id] })
      compare(pending.length, 3)
      verify(pending[0].deadline >= before + 65000)
      verify(pending[1].deadline >= before + 65000)
      verify(pending[2].deadline >= before + 30000 && pending[2].deadline < before + 31000)
    }

    function test_cancelled_upload_discards_staged_data_without_domain_dispatch() {
      var backend = makeBackend()
      var process = makeReady(backend)
      var callbacks = 0
      var handle = backend.call("agent.context", {prompt:"x".repeat(210000)}, function() { callbacks++ })
      var all = requests(process)
      compare(all[all.length - 1].method, "upload.begin")
      reply(process, all[all.length - 1], {upload:"synthetic",chunkSize:65536})
      all = requests(process)
      var append = all[all.length - 1]
      compare(append.method,"upload.append")
      handle.cancel()
      reply(process,append,{offset:65536})
      all=requests(process)
      compare(all[all.length - 1].method,"upload.discard")
      for (var i=0;i<all.length;i++) verify(all[i].method!=="request.upload")
      compare(callbacks,0)
    }

    function makeBackend() {
      var backend = createTemporaryObject(backendFactory, parent)
      verify(backend !== null)
      return backend
    }

    function processOf(backend) {
      for (var i = 0; i < backend.children.length; i++) {
        var child = backend.children[i]
        if (child.command && child.command.length === 2
            && child.command[1] === "serve") return child
      }
      fail("No backend process")
      return null
    }

    function deadlineOf(backend) {
      for (var i = 0; i < backend.data.length; i++) {
        var child = backend.data[i]
        if (child.interval === 5000 && child.repeat === false) return child
      }
      fail("No backend shutdown deadline")
      return null
    }

    function stopConfirmationOf(backend) {
      for (var i = 0; i < backend.data.length; i++) {
        var child = backend.data[i]
        if (child.interval === 1000 && child.repeat === false) return child
      }
      fail("No backend stop confirmation deadline")
      return null
    }

    function requests(process) {
      var lines = process.written.split("\n")
      var result = []
      for (var i = 0; i < lines.length; i++) {
        if (lines[i] !== "") result.push(JSON.parse(lines[i]))
      }
      return result
    }

    function start(backend) {
      var process = processOf(backend)
      process.started()
      compare(requests(process).length, 1)
      compare(requests(process)[0].method, "system.info")
      return process
    }

    function reply(process, request, result, error) {
      var value = { jsonrpc: "2.0", id: request.id }
      if (error) value.error = error
      else value.result = result
      process.stdout.read(JSON.stringify(value))
    }

    function makeReady(backend) {
      var process = start(backend)
      reply(process, requests(process)[0], {
        name: "omamail",
        apiVersion: 1, protocol: 1,
        version: "0.8.2",
        methods: ["system.info", "system.quit"]
      }, null)
      compare(backend.ready, true)
      return process
    }

    function test_business_call_is_not_written_before_handshake() {
      var backend = makeBackend()
      var process = processOf(backend)
      var error = null
      backend.call("gmail.sendAs", {}, function(_result, failure) { error = failure })
      verify(error !== null)
      compare(error.message, "Backend unavailable")
      compare(process.written, "")

      process.started()
      var before = process.written
      error = null
      backend.call("gmail.sendAs", {}, function(_result, failure) { error = failure })
      verify(error !== null)
      compare(error.message, "Backend is not ready")
      compare(process.written, before)
      compare(requests(process).length, 1, "only the private system.info request was written")
    }

    function test_recheck_restarts_after_a_failed_handshake() {
      var backend = makeBackend()
      var process = start(backend)
      reply(process, requests(process)[0], { apiVersion: 1, protocol: 1, version: "0.8.1" }, null)
      process.exited(1)
      backend.executable = ""
      wait(0)
      backend.executable = "/tmp/omamail-synthetic-backend"
      wait(0)
      compare(process.running, true)
      compare(backend.ready, false)
    }

    function test_api_mismatch_stops_without_business_dispatch_data() {
      return [{ tag: "missing", info: { protocol: 1, version: "0.8.2" } },
        { tag: "wrong", info: { protocol: 1, version: "0.8.2", apiVersion: 2 } }]
    }
    function test_api_mismatch_stops_without_business_dispatch(data) {
      var backend = makeBackend()
      var process = start(backend)
      reply(process, requests(process)[0], data.info, null)
      compare(backend.ready, false)
      verify(!process.running)
      var before = process.written
      var error = null
      backend.call("gmail.sendAs", {}, function(_result, failure) { error = failure })
      verify(error !== null)
      compare(process.written, before)
    }

    function test_unvalidated_runtime_never_starts_or_dispatches() {
      var backend = createTemporaryObject(backendFactory, parent, { launchEnabled: false })
      var process = processOf(backend)
      wait(0)
      compare(process.running, false)
      verify(backend.executable !== "", "provider migration stays selected")
      var error = null
      backend.call("gmail.sendAs", {}, function(_result, failure) { error = failure })
      verify(error !== null)
      compare(process.written, "")
      backend.launchEnabled = true
      wait(0)
      compare(process.running, true)
      compare(backend.ready, false)
    }

    function test_version_mismatch_stops_without_business_dispatch() {
      var backend = makeBackend()
      var process = start(backend)
      reply(process, requests(process)[0], {
        name: "omamail",
        apiVersion: 1, protocol: 1,
        version: "0.8.1",
        methods: ["system.info", "system.quit"]
      }, null)
      compare(backend.ready, false)
      compare(backend.failure, "Incompatible backend")
      compare(process.running, false)
      compare(requests(process).length, 1)
    }

    function test_shutdown_during_mismatched_handshake_keeps_failure_until_exit() {
      var backend = makeBackend()
      var process = start(backend)
      var calls = 0
      var stoppedWith = null
      backend.shutdown(function(error) { calls++; stoppedWith = error })

      reply(process, requests(process)[0], {
        name: "omamail",
        apiVersion: 1, protocol: 1,
        version: "0.8.1",
        methods: ["system.info", "system.quit"]
      }, null)
      compare(backend.shutdownFinished, false,
        "a disconnected failure still waits for process exit acknowledgement")
      compare(calls, 0)
      compare(process.running, false)

      process.exited(0)
      compare(calls, 1)
      verify(stoppedWith !== null)
      compare(stoppedWith.message, "Incompatible backend")
    }

    function test_shutdown_drains_then_completes_after_clean_exit() {
      var backend = makeBackend()
      var process = makeReady(backend)
      var businessResult = null
      backend.call("gmail.sendAs", {}, function(result, _error) { businessResult = result })
      compare(requests(process).length, 2)

      var shutdownCalls = 0
      var shutdownError = "not called"
      backend.shutdown(function(error) {
        shutdownCalls++
        shutdownError = error
      })
      compare(backend.ready, false)
      compare(requests(process).length, 2, "quit waits for the accepted business response")

      var refused = null
      backend.call("gmail.sendAs", {}, function(_result, error) { refused = error })
      verify(refused !== null)
      compare(refused.message, "Backend is shutting down")
      compare(requests(process).length, 2)

      reply(process, requests(process)[1], { accepted: true }, null)
      compare(businessResult.accepted, true)
      compare(requests(process).length, 3)
      compare(requests(process)[2].method, "system.quit")
      reply(process, requests(process)[2], { quitReady: true }, null)
      compare(shutdownCalls, 0, "the quit reply alone does not prove the process stopped")
      process.exited(0)
      compare(shutdownCalls, 1)
      compare(shutdownError, null)
    }

    function test_failed_quit_response_cannot_be_reported_clean() {
      var backend = makeBackend()
      var process = makeReady(backend)
      var calls = 0
      var stoppedWith = null
      backend.shutdown(function(error) { calls++; stoppedWith = error })
      compare(requests(process)[1].method, "system.quit")
      reply(process, requests(process)[1], null,
        { code: -32601, message: "Unknown method" })
      compare(calls, 0, "failure still waits for process exit acknowledgement")
      process.exited(0)
      compare(calls, 1)
      verify(stoppedWith !== null)
      compare(stoppedWith.message, "Backend shutdown failed")
    }

    function test_nonzero_exit_after_quit_is_an_error() {
      var backend = makeBackend()
      var process = makeReady(backend)
      var stoppedWith = null
      backend.shutdown(function(error) { stoppedWith = error })
      reply(process, requests(process)[1], { quitReady: true }, null)
      process.exited(1)
      verify(stoppedWith !== null)
      compare(stoppedWith.message, "Backend stopped")
    }

    function test_shutdown_timeout_forces_stop_but_waits_for_exit_signal() {
      var backend = makeBackend()
      var process = makeReady(backend)
      var businessError = null
      backend.call("gmail.sendAs", {}, function(_result, error) { businessError = error })
      var calls = 0
      var stoppedWith = null
      backend.shutdown(function(error) { calls++; stoppedWith = error })

      deadlineOf(backend).triggered()
      verify(businessError !== null)
      compare(businessError.message, "Backend shutdown timed out")
      compare(process.running, false)
      compare(calls, 0)
      process.exited(0)
      compare(calls, 1)
      verify(stoppedWith !== null)
      compare(stoppedWith.message, "Backend shutdown timed out")
    }

    function test_forced_stop_without_exit_signal_is_reported_unconfirmed() {
      var backend = makeBackend()
      var process = makeReady(backend)
      backend.call("gmail.sendAs", {}, function() {})
      var calls = 0
      var stoppedWith = null
      backend.shutdown(function(error) { calls++; stoppedWith = error })

      deadlineOf(backend).triggered()
      compare(process.running, false)
      compare(calls, 0)
      stopConfirmationOf(backend).triggered()
      compare(calls, 1)
      verify(stoppedWith !== null)
      compare(stoppedWith.message, "Backend stop was not confirmed")
    }
  }
}
