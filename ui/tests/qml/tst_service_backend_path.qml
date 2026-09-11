import QtQuick
import QtTest
import "../.." as Omamail

Item {
  Component {
    id: factory
    Omamail.Service {}
  }
  TestCase {
    name: "ServiceBackendPath"
    function test_resolved_runtime_path_starts_backend() {
      var service = createTemporaryObject(factory, parent)
      verify(service !== null)
      var runtime = service.backendRuntime
      var resolved = "/synthetic/real-checkout/runtime/bin/omamail"
      verify(resolved !== service.pluginDir + "/runtime/bin/omamail")
      runtime.applyResult({ state: "ready", requiredVersion: "0.8.2", requiredApiVersion: 1,
        installedVersion: "0.8.2", executable: resolved, error: "" }, 0)
      tryCompare(service.backend, "launchEnabled", true)
      compare(service.backend.executable, resolved)
      var process = null
      for (var i = 0; i < service.backend.children.length; i++) {
        var child = service.backend.children[i]
        if (child.command) process = child
      }
      verify(process !== null)
      tryCompare(process, "running", true)
      process.started()
      var request = JSON.parse(process.written.trim())
      process.stdout.read(JSON.stringify({jsonrpc: "2.0", id: request.id,
        result: {name: "omamail", version: "0.8.2", apiVersion: 1, protocol: 1,
                 methods: ["system.info", "system.quit"]}}))
      tryCompare(service.backend, "ready", true)
    }
  }
}
