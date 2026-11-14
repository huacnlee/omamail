import QtQuick
import QtTest
import "../.." as Omamail

// A keepLoaded service is not recreated by a plugin rescan: Omarchy hands it a
// fresh manifest and keeps the old QML instance. Without a re-probe the pinned
// backend stays the one from before the update until the shell restarts.
// The first manifest arrives at construction, when Runtime's own startup probe
// already runs; every later one is a rescan that has to probe again.
Item {
  Component { id: factory; Omamail.Service {} }

  TestCase {
    name: "ServiceRescan"

    function runtimeProcess(runtime) {
      for (var i = 0; i < runtime.children.length; i++)
        if (runtime.children[i].command) return runtime.children[i]
      return null
    }

    function answer(runtime, version) {
      var process = runtimeProcess(runtime)
      process.running = false
      process.stdout.read(JSON.stringify({
        state: "ready", requiredVersion: version, requiredApiVersion: 1,
        installedVersion: version, executable: "/synthetic/runtime/bin/omamail",
        error: "", cliInstalled: false
      }))
      process.exited(0)
    }

    function test_rescan_reprobes_the_pinned_backend() {
      var service = createTemporaryObject(factory, parent)
      var runtime = service.backendRuntime
      var process = runtimeProcess(runtime)
      verify(process !== null, "the service owns its backend runtime process")

      // The shell constructs the service first and injects the manifest after.
      service.manifest = ({ id: "omamail", version: "0.11.3", __sourceDir: "" })
      answer(runtime, "0.11.3")
      compare(runtime.state, "ready")
      compare(process.running, false)

      // `omarchy plugin update` only rescans: a kept service gets a fresh copy.
      service.manifest = ({ id: "omamail", version: "0.11.4", __sourceDir: "" })
      wait(0)
      compare(process.command[2], "status")
      verify(process.running, "a rescan must re-probe the backend pin")
    }

    function test_rescan_during_a_status_check_is_not_dropped() {
      var service = createTemporaryObject(factory, parent)
      var runtime = service.backendRuntime
      var process = runtimeProcess(runtime)
      // The startup probe for the old pin is still in flight.
      service.manifest = ({ id: "omamail", version: "0.11.3", __sourceDir: "" })
      compare(process.command[2], "status")
      verify(process.running, "the startup probe is still in flight")

      // An update swaps the manifest before that probe answers.
      service.manifest = ({ id: "omamail", version: "0.11.4", __sourceDir: "" })
      wait(0)
      verify(process.running, "the older probe must not be interrupted")

      answer(runtime, "0.11.3")
      wait(0)
      verify(process.running, "a rescan during an in-flight check must be queued")
      compare(process.command[2], "status")

      // The follow-up probe reads the new checkout, not the older answer.
      answer(runtime, "0.11.4")
      wait(0)
      wait(0)
      compare(runtime.requiredVersion, "0.11.4")
    }
  }
}
