import QtQuick
import QtTest
import "../../providers" as Providers
import "transports.js" as Transports

Item {
  Component {
    id: fixture
    Item {
      property alias api: client
      QtObject {
        id: auth
        property string accountId: "jmap:ada@example.org"
        property bool loggedIn: false
        property var settings: ({sessionUrl:"https://example.org/session",username:"ada"})
        signal verifyRequested(var settings, string address, string secret)
        signal loggedOut()
      }
      Providers.JmapClient { id: client; auth: auth }
    }
  }
  TestCase {
    when: windowShown
    function setup() {
      var f = createTemporaryObject(fixture, this)
      Transports.install(f.api)
      return f
    }
    name: "JmapNativeRequestLifetime"
    function test_abandoned_requests_cancel_by_id_and_late_reply_cannot_apply_state() {
      var f = setup()
      var called = 0
      for (var i = 0; i < 4; i++) {
        var before = Transports.transports(f.api)
        var handle = f.api.getMessage("m" + i, true, function() { called++ })
        var request = Transports.newSince(f.api, before)[0]
        compare(request.method, "jmap.read")
        compare(request.params.accountId, "jmap:ada@example.org")
        compare(request.params.credential, undefined)
        compare(f.api.inFlight, 1)
        f.api.abortRequest(handle)
        var cancel = f.api.backend.testCalls.slice(-1)[0]
        compare(cancel.method, "jmap.cancel")
        compare(cancel.params.requestId, request.params.requestId)
        f.api.abortRequest(handle)
        compare(f.api.backend.testCalls.slice(-1)[0], cancel)
        Transports.complete(request, {id:"m" + i}, {session:{state:"stale"},mailboxes:[]})
        compare(f.api.inFlight, 0)
        compare(called, 0)
        compare(f.api.session, null)
      }
      var before = Transports.transports(f.api)
      f.api.getMessage("next", true, function(result,error) { compare(error, ""); called++ })
      Transports.complete(Transports.newSince(f.api,before)[0], {id:"next"})
      compare(called, 1)
      compare(f.api.inFlight, 0)
    }
    function test_server_change_ignores_pending_result_and_completes_busy_accounting() {
      var f = setup()
      var called = false
      f.api.getLabels(function() { called = true })
      var request = Transports.transports(f.api)[0]
      f.api.forgetServer()
      Transports.complete(request, [], {session:{state:"old"},mailboxes:[{id:"old"}]})
      compare(called, false)
      compare(f.api.session, null)
      compare(f.api.mailboxList.length, 0)
      compare(f.api.inFlight, 0)
    }
  }
}
