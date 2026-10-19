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
    function test_microsoft_connection_requirement_is_fixed_across_releases() {
      var service = createTemporaryObject(factory, parent)
      verify(service !== null)
      var backend = service.backend
      backend.launchEnabled = true
      backend.connected = true
      backend.protocolInfo = ({ apiVersion: 2 })
      compare(service.backendCanCheckMicrosoftConnection, false)
      compare(service.backendCanDiscoverCalendars, false)
      backend.protocolInfo = ({ apiVersion: 3 })
      compare(service.backendCanCheckMicrosoftConnection, false,
        "published API 3 adds mail CLI methods, not connection checks")
      compare(service.backendCanDiscoverCalendars, false,
        "published API 3 cannot address discovered account calendars")
      backend.protocolInfo = ({ apiVersion: 4 })
      compare(service.backendCanDiscoverCalendars, false)
      compare(service.backendCanCheckMicrosoftConnection, false,
        "published API 4 adds native credentials, not connection checks")
      backend.protocolInfo = ({ apiVersion: 5 })
      compare(service.backendCanCheckMicrosoftConnection, true)
      compare(service.backendCanDiscoverCalendars, true)
      compare(service.backendCanDiscoverCalendars, true)
      backend.latestApiVersion = 6
      compare(service.backendCanCheckMicrosoftConnection, true,
        "a later API must not disable an already supported connection check")
      backend.protocolInfo = ({ apiVersion: 6 })
      compare(service.backendCanCheckMicrosoftConnection, true)
      compare(service.backendCanDiscoverCalendars, true)
      backend.connected = false
      compare(service.backendCanCheckMicrosoftConnection, false)
      compare(service.backendCanDiscoverCalendars, false)
    }
    function test_sender_name_requirement_is_fixed_across_releases() {
      var service = createTemporaryObject(factory, parent)
      verify(service !== null)
      var backend = service.backend
      backend.launchEnabled = true
      backend.connected = true
      backend.protocolInfo = ({ apiVersion: 6 })
      compare(service.backendCanNameSender, false, "published API 6 ignores a stored sender name")
      backend.protocolInfo = ({ apiVersion: 7 })
      compare(service.backendCanNameSender, true)
      backend.latestApiVersion = 8
      backend.protocolInfo = ({ apiVersion: 8 })
      compare(service.backendCanNameSender, true,
        "a later API must not take the sender name away")
      backend.connected = false
      compare(service.backendCanNameSender, false)
    }
    function test_calendar_requests_obey_the_connected_api() {
      var service = createTemporaryObject(factory, parent)
      verify(service !== null)
      var backend = service.backend
      backend.launchEnabled = true
      backend.connected = true
      backend.protocolInfo = ({ apiVersion: 4 })
      var controller = service.calendarController
      var initialRequests = Object.keys(backend.pending).length
      var sources = [{kind: "microsoft", calendarId: "other-calendar"}, {kind: "icloud"}]
      var operations = ["list", "create", "update", "delete"]
      var refused = 0
      for (var s = 0; s < sources.length; s++) {
        for (var op = 0; op < operations.length; op++) {
          controller.nativeRequest(sources[s], operations[op], {}, function(result, error) {
            compare(result, null)
            compare(error, "Update the backend to access this calendar")
            refused++
          })
        }
      }
      compare(refused, 8)
      compare(Object.keys(backend.pending).length, initialRequests,
        "API 4 must not receive unsupported calendar.request parameters")
      controller.nativeRequest({kind: "microsoft", calendarId: ""}, "list", {}, function() {})
      compare(Object.keys(backend.pending).length, initialRequests + 1,
        "the established default calendar still works on API 4")
      backend.protocolInfo = ({ apiVersion: 5 })
      for (var supported = 0; supported < sources.length; supported++) {
        for (var action = 0; action < operations.length; action++) {
          controller.nativeRequest(sources[supported], operations[action], {}, function() {})
        }
      }
      compare(Object.keys(backend.pending).length, initialRequests + 9,
        "API 5 supports all discovered-calendar operations")
    }
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
