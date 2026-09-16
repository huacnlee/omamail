import QtQuick
import QtTest
import "../../providers" as Providers

// A Gmail message mutation answers with a ticket and settles later, when the
// backend announces the outcome of its queued send. The client keeps the
// request in flight until then, hands the outcome to the same callback, and
// gives up on tickets a stopped backend can no longer settle.
Item {
  Component {
    id: backendFactory
    QtObject {
      property string executable: "/test/omamail"
      property bool ready: true
      property var calls: []
      signal notification(string method, var params)
      function call(method, params, callback) {
        calls = calls.concat([{ method: method, params: params, callback: callback }])
      }
      function answer(index, result) { calls[index].callback(result, null) }
    }
  }
  Component {
    id: authFactory
    QtObject {
      property string accountId: "queue@example.org"
      property bool loggedIn: true
      property var signedInProfile: null
      signal loggedOut()
    }
  }
  Component {
    id: clientFactory
    Providers.GmailApiClient {}
  }

  TestCase {
    name: "GmailQueue"
    function client() {
      var backend = createTemporaryObject(backendFactory, parent)
      var auth = createTemporaryObject(authFactory, parent)
      var api = createTemporaryObject(clientFactory, parent, { auth: auth, backend: backend })
      verify(api !== null)
      return api
    }
    function test_ticket_settles_the_callback_that_sent_it() {
      var api = client()
      var outcomes = []
      api.trashMessage("one", function(payload, error) { outcomes.push({ payload: payload, error: error }) })
      api.trashMessage("two", function(payload, error) { outcomes.push({ payload: payload, error: error }) })
      compare(api.backend.calls.length, 2)
      api.backend.answer(0, { queued: true, ticket: "7" })
      api.backend.answer(1, { queued: true, ticket: "8" })
      compare(outcomes.length, 0, "a ticket is not an answer")
      compare(api.inFlight, 2, "the sends are still in flight")
      api.backend.notification("gmail.settled", { accountId: "queue@example.org", ticket: "8", method: "gmail.trash", ok: false, error: "gmail_rate_limited" })
      compare(outcomes.length, 1)
      compare(outcomes[0].payload, null)
      verify(outcomes[0].error.indexOf("rate limiting") >= 0, outcomes[0].error)
      api.backend.notification("gmail.settled", { accountId: "queue@example.org", ticket: "7", method: "gmail.trash", ok: true, error: "" })
      compare(outcomes.length, 2)
      compare(outcomes[1].error, "")
      compare(api.inFlight, 0)
      api.backend.notification("gmail.settled", { ticket: "7", ok: true })
      compare(outcomes.length, 2, "a ticket settles once")
    }
    function test_direct_answers_still_arrive_at_once() {
      var api = client()
      var outcomes = []
      api.modifyMessage("one", ["STARRED"], [], function(payload, error) { outcomes.push(error) })
      api.backend.answer(0, {})
      compare(outcomes, [""])
    }
    function test_a_stopped_backend_fails_what_it_still_held() {
      var api = client()
      var outcomes = []
      api.trashMessage("one", function(payload, error) { outcomes.push(error) })
      api.backend.answer(0, { queued: true, ticket: "1" })
      api.backend.ready = false
      compare(outcomes.length, 1)
      verify(outcomes[0].indexOf("backend stopped") >= 0, outcomes[0])
      compare(api.inFlight, 0)
    }
    function test_an_aborted_request_ignores_its_settlement() {
      var api = client()
      var outcomes = []
      var handle = api.trashMessage("one", function(payload, error) { outcomes.push(error) })
      api.backend.answer(0, { queued: true, ticket: "1" })
      api.abortRequest(handle)
      api.backend.notification("gmail.settled", { ticket: "1", ok: true, error: "" })
      compare(outcomes.length, 0)
      compare(api.inFlight, 0)
    }
  }
}
