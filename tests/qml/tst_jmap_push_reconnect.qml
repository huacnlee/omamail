import QtQuick 2.15
import QtTest 1.3
import "transports.js" as Transports
import "../../account" as Account

// A stream the server closes at once is a failure, however clean the close.
//
// The reconnect table reads curl's exit 0 as "the server finished with this
// connection" and reconnects at once, and it resets the backoff on the first
// line the server sends. A server — or a proxy in front of one — that answers
// a comment and closes cleanly therefore gave exit 0 sixty milliseconds after
// the handshake, with a line heard: the backoff reset, the table said at once,
// and the stream reconnected as fast as TLS allows, with the per-connect
// refresh behind every one. Measured against a local server before this
// test existed. A connection is believed only once it has lasted a whole
// ping interval; until then its close counts, and doubles.
//
// The push owner is found among the client's children, the way the transport
// processes are, and its clock can be pinned so the interval passes without the
// test waiting for it.
Item {
  width: 400
  height: 300

  Account.MailAccount {
    id: account

    pluginDir: "/tmp/omamail-test"
    accountId: "jmap:ada@example.org"
    configuredEmail: "ada@example.org"
    providerId: "jmap"
    jmapSettings: ({
      sessionUrl: "https://mail.example.org/jmap/session",
      username: "ada@example.org",
      authScheme: "basic",
      accountId: "t"
    })
    active: true
    windowOpen: true
  }

  TestCase {
    name: "JmapPushReconnect"
    when: windowShown

    readonly property var session: ({
      capabilities: {
        "urn:ietf:params:jmap:core": {},
        "urn:ietf:params:jmap:mail": {}
      },
      accounts: {
        t: {
          name: "ada@example.org",
          isPersonal: true,
          isReadOnly: false,
          accountCapabilities: {
            "urn:ietf:params:jmap:mail": { emailQuerySortOptions: ["receivedAt"] }
          }
        }
      },
      primaryAccounts: {
        "urn:ietf:params:jmap:core": "t",
        "urn:ietf:params:jmap:mail": "t"
      },
      apiUrl: "https://api.example.org/jmap/",
      eventSourceUrl: "https://api.example.org/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}",
      state: "s0"
    })

    property double nowMs: 1000000

    function pushOwner() {
      var kids = account.api.data
      for (var i = 0; i < kids.length; i++)
        if (kids[i] && kids[i].hasOwnProperty("connectedTemplate")) return kids[i]
      return null
    }

    // The push owner's one stream process, which is a fixed child rather than
    // one made per request. The stub never starts or stops on its own, so the
    // test plays the process: `started()` when the owner has asked for it,
    // `running = false` then `exited()` when the server closes.
    function streamOf(push) {
      var kids = push.data
      for (var i = 0; i < kids.length; i++)
        if (kids[i] && kids[i].hasOwnProperty("stdinEnabled")) return kids[i]
      return null
    }

    function opened(push, stream) {
      verify(stream.running, "the owner asked for a connection")
      compare(push.requestLine.substring(0, 7), "stream ", "with the stream verb")
      stream.started()
      compare(push.requestLine, "", "and the line was written on start")
    }

    function closedCleanly(stream) {
      stream.running = false
      stream.exited(0)
    }

    function test_an_instant_clean_close_backs_off_and_a_settled_one_does_not() {
      verify(!!account.auth && !!account.api)
      var push = pushOwner()
      verify(!!push, "the client holds its push owner")
      push.pinnedClockMs = nowMs
      var stream = streamOf(push)
      verify(!!stream, "and the owner holds its stream process")

      account.api.session = session
      account.auth.secret = "app-password"
      account.auth.secretChecked = true
      tryVerify(function() { return stream.running }, 2000,
        "a session with an event-source template opens the stream")
      opened(push, stream)
      compare(push.attempt, 0)

      // The server speaks once, sixty milliseconds in, and closes cleanly.
      nowMs += 60
      push.pinnedClockMs = nowMs
      stream.stdout.read(": hello")
      compare(push.attempt, 0, "a line on a fresh connection resets nothing yet")
      closedCleanly(stream)
      compare(push.attempt, 1, "the clean close of an unproven connection is a failure")
      wait(100)
      compare(stream.running, false, "and it is not reconnected at once")

      // Again, on the reconnect the backoff allows a second later: the count
      // climbs rather than resetting on the line.
      tryVerify(function() { return stream.running }, 3000,
        "the backoff reconnects after a second")
      opened(push, stream)
      nowMs += 60
      push.pinnedClockMs = nowMs
      stream.stdout.read(": hello")
      closedCleanly(stream)
      compare(push.attempt, 2, "the second instant close doubles rather than resets")
      wait(100)
      compare(stream.running, false)

      // A connection that lasted a whole ping interval is believed: its line
      // resets the backoff and its clean close reconnects at once.
      tryVerify(function() { return stream.running }, 5000,
        "the backoff reconnects after two seconds")
      opened(push, stream)
      nowMs += 30 * 1000
      push.pinnedClockMs = nowMs
      stream.stdout.read("event: ping\ndata: {\"interval\":30}")
      compare(push.attempt, 0, "a line after a whole interval resets the backoff")
      closedCleanly(stream)
      compare(push.attempt, 0, "and its clean close counts as clean")
      tryVerify(function() { return stream.running }, 500,
        "so the settled connection is reconnected at once")
    }
  }
}
