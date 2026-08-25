import QtQuick 2.15
import QtTest 1.3
import "../../providers" as Providers

Item {
  QtObject {
    id: fakeAuth
    signal verifyRequested(string token)
  }

  Providers.JmapClient {
    id: client
    auth: fakeAuth
    email: "reader@example.com"
  }

  TestCase {
    name: "JmapReaderCapabilities"

    function session(limit, reportsLimit, serverReadOnly) {
      var mailCapabilities = {}
      if (reportsLimit) mailCapabilities.maxMailboxesPerEmail = limit
      return {
        capabilities: {
          "urn:ietf:params:jmap:core": {},
          "urn:ietf:params:jmap:mail": {}
        },
        accounts: {
          account: {
            isReadOnly: serverReadOnly,
            accountCapabilities: {
              "urn:ietf:params:jmap:mail": mailCapabilities
            }
          }
        },
        primaryAccounts: { "urn:ietf:params:jmap:mail": "account" },
        apiUrl: "https://phl.api.fastmail.com/jmap/api/"
      }
    }

    function init() {
      client.sessionInfo = null
    }

    function test_reader_refuses_writes_even_with_a_broader_token() {
      compare(client.adoptSession(session(1000, true, false)), "")
      compare(client.readOnly, true)
      compare(client.canCapability("archive"), false)
      compare(client.canCapability("batch"), false)
      compare(client.canCapability("send"), false)
      compare(client.canCapability("star"), false)
    }

    function test_labels_follow_the_server_mailbox_limit() {
      compare(client.adoptSession(session(1000, true, true)), "")
      compare(client.canCapability("labels"), true)
      compare(client.adoptSession(session(1, true, true)), "")
      compare(client.canCapability("labels"), false)
      compare(client.adoptSession(session(null, true, true)), "")
      compare(client.canCapability("labels"), true)
      compare(client.adoptSession(session(null, false, true)), "")
      compare(client.canCapability("labels"), false)
    }
  }
}
