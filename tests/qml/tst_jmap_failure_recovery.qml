import QtQuick 2.15
import QtTest 1.3
import "../../providers" as Providers
import "transports.js" as Transports

Item {
  Component {
    id: fixture
    Item {
      property alias api: client
      QtObject {
        id: fakeAuth
        property string pluginDir: "/tmp/omamail-test"
        property bool loggedIn: false
        property var settings: ({
            sessionUrl: "https://example.org/session",
            username: "ada@example.org",
            accountId: "t"
          })
        signal verifyRequested(var settings, string address, string secret)
        signal loggedOut
        function withCredentials(callback) {
          callback({
            scheme: "basic",
            username: "ada",
            secret: "synthetic-secret"
          }, "")
        }
      }
      QtObject {
        id: fakeCache
        property var stored: null
        function getSession(url) {
          return stored ? {
            session: stored
          } : null
        }
        function putSession(url, state, session) {
          stored = session
        }
      }
      property alias stored: fakeCache.stored
      Providers.JmapClient {
        id: client
        auth: fakeAuth
        cache: fakeCache
      }
    }
  }
  TestCase {
    name: "JmapFailureRecovery"
    when: windowShown
    function session() {
      return {
        capabilities: {
          "urn:ietf:params:jmap:core": {},
          "urn:ietf:params:jmap:mail": {}
        },
        accounts: {
          t: {
            accountCapabilities: {
              "urn:ietf:params:jmap:mail": {
                emailQuerySortOptions: ["receivedAt"]
              }
            }
          }
        },
        primaryAccounts: {
          "urn:ietf:params:jmap:mail": "t"
        },
        apiUrl: "https://old.example.org/api",
        uploadUrl: "https://example.org/upload/{accountId}",
        state: "s0"
      }
    }
    function setup() {
      var f = createTemporaryObject(fixture, this)
      f.api.session = session()
      f.api.mailboxList = [
        {
          id: "D",
          role: "drafts"
        },
        {
          id: "S",
          role: "sent"
        }
      ]
      f.api.mailboxesLoaded = true
      return f
    }
    function callArgs(p) {
      return JSON.parse(Transports.requested(p).fields[4]).methodCalls
    }
    function test_discovery_starts_at_original_domain_without_credentials() {
      var f = setup()
      var before = Transports.transports(f.api)
      f.api.verifyCredentials({}, "ada@example.org", "synthetic-secret", function () {})
      var requests = Transports.newSince(f.api, before)
      compare(requests.length, 1)
      var first = Transports.requested(requests[0])
      compare(first.url, "https://example.org/.well-known/jmap")
      compare(first.scheme, "none")
      compare(first.fields[3], "")
    }
    function test_failed_import_never_deletes_existing_draft() {
      var f = setup()
      var initial = Transports.transports(f.api)
      var failure = ""
      f.api.saveDraft({
        raw: Qt.btoa("From: ada@example.org\r\n\r\nDraft"),
        draftId: "old"
      }, function (r, e) {
        failure = e
      })
      var upload = Transports.newSince(f.api, initial)[0]
      var before = Transports.transports(f.api)
      Transports.answer(upload, 201, {
        blobId: "blob"
      })
      var imported = Transports.newSince(f.api, before)[0]
      compare(callArgs(imported).length, 1)
      before = Transports.transports(f.api)
      Transports.answer(imported, 200, {
        methodResponses: [["Email/import",
            {
              notCreated: {
                m: {
                  type: "overQuota"
                }
              }
            },
            "0"]],
        sessionState: "s0"
      })
      verify(failure !== "")
      compare(Transports.newSince(f.api, before).length, 0, "failed import must never issue a destroy")
    }
    function test_successful_send_retires_old_draft_after_confirmation() {
      var f = setup()
      var before = Transports.transports(f.api)
      var sent = false
      f.api.submitMessage("blob", "identity", "old", f.api.newHandle(), function (r, e) {
        sent = !!r && !e
      })
      var pending = Transports.newSince(f.api, before)[0]
      before = Transports.transports(f.api)
      Transports.answer(pending, 200, {
        methodResponses: [["Email/import",
            {
              created: {
                m: {
                  id: "new"
                }
              }
            },
            "0"], ["EmailSubmission/set",
            {
              created: {
                s: {
                  id: "submission"
                }
              }
            },
            "1"]],
        sessionState: "s0"
      })
      verify(sent)
      var cleanup = Transports.newSince(f.api, before)
      compare(cleanup.length, 1)
      compare(callArgs(cleanup[0])[0][1].destroy[0], "old")
    }
    function test_404_fetches_session_instead_of_restoring_stale_cache() {
      var f = setup()
      f.stored = session()
      f.api.readCall({
        exit: 0,
        status: 404,
        body: "",
        stderr: ""
      }, function () {})
      var before = Transports.transports(f.api)
      f.api.ensureSession(function () {})
      var pending = Transports.newSince(f.api, before)
      compare(pending.length, 1, "the stale cached session must cause a network GET")
      compare(Transports.requested(pending[0]).verb, "session")
    }
    function test_failed_submission_preserves_original_draft() {
      var f = setup()
      var done = false
      var initial = Transports.transports(f.api)
      f.api.submitMessage("blob", "identity", "old", f.api.newHandle(), function (result, error) {
        done = !!error
      })
      var p = Transports.newSince(f.api, initial)[0]
      var calls = callArgs(p)
      for (var i = 0; i < calls.length; i++)
        verify(!calls[i][1].destroy, "no old draft deletion before submission success")
      var before = Transports.transports(f.api)
      Transports.answer(p, 200, {
        methodResponses: [["Email/import",
            {
              created: {
                m: {
                  id: "new"
                }
              }
            },
            "0"], ["EmailSubmission/set",
            {
              notCreated: {
                s: {
                  type: "noRecipients"
                }
              }
            },
            "1"]],
        sessionState: "s0"
      })
      verify(done)
      var cleanup = Transports.newSince(f.api, before)
      compare(cleanup.length, 1)
      compare(callArgs(cleanup[0])[0][1].destroy[0], "new", "only the refused import is removed")
    }
    function test_save_failure_preserves_original_and_cleanup_failure_keeps_saved_result() {
      var f = setup()
      var result = null
      var failure = ""
      var initial = Transports.transports(f.api)
      f.api.saveDraft({
        raw: Qt.btoa("From: ada@example.org\r\n\r\nDraft"),
        draftId: "old"
      }, function (r, e) {
        result = r
        failure = e
      })
      var upload = Transports.newSince(f.api, initial)[0]
      var before = Transports.transports(f.api)
      Transports.answer(upload, 201, {
        blobId: "blob"
      })
      var imported = Transports.newSince(f.api, before)[0]
      compare(callArgs(imported).length, 1, "replacement import cannot delete the original")
      before = Transports.transports(f.api)
      Transports.answer(imported, 200, {
        methodResponses: [["Email/import",
            {
              created: {
                m: {
                  id: "new"
                }
              }
            },
            "0"]],
        sessionState: "s0"
      })
      var cleanup = Transports.newSince(f.api, before)
      compare(cleanup.length, 1, "successful import can now retire the old draft")
      compare(callArgs(cleanup[0])[0][1].destroy[0], "old")
      Transports.answer(cleanup[0], 503, {})
      compare(failure, "")
      verify(result.saved)
      compare(result.draftId, "new")
      verify(result.warning !== "")
    }
  }
}
