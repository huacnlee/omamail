import QtQuick
import Quickshell.Io
import "../message/Message.js" as Mail
import "../message/Unsubscribe.js" as Unsub

// Unsubscribing from the list the open message came from: a browser page, a
// mail to the list, or a POST through `scripts/unsubscribe.py`, whichever
// the headers offer. Beside the account rather than in it, which is at its
// size ceiling; its state (`unsubscribing`, `unsubscribeDone`) stays on the
// account, where the reader reads it.
QtObject {
  id: unsubscribeAction

  required property var account


  // Three ways off a list, and `Unsubscribe.plan` picks between them so that
  // nothing here branches on a header. In order of how little the user has to
  // do: a POST the sender has promised is enough, a message to the address
  // they nominated, or their page in a browser.
  function run() {
    if (account.unsubscribing || account.unsubscribeDone !== "") return
    var info = account.selectedUnsubscribe
    var how = Unsub.plan(info, account.canSend)
    if (how === "") return
    account.clearNotice()

    if (how === "browser") {
      Qt.openUrlExternally(info.url)
      // What happened is that a page opened. Whether the list acted on it is
      // between the user and that page, and saying "unsubscribed" here would
      // be this panel taking credit for work it cannot see.
      account.unsubscribeDone = "The unsubscribe page is open in your browser"
      return
    }

    if (how === "mail") {
      if (!account.ready) {
        account.fail("Sign in before account.unsubscribing")
        return
      }
      account.unsubscribing = true
      account.api.sendMessage(Mail.buildSendPayload({
        // The address the newsletter was sent to. A list that only ever knew
        // an alias has no reason to act on a request from anywhere else.
        from: account.receivedAsAddress,
        fromName: account.receivedAsName,
        accountAddress: account.ownAddress,
        to: info.mail.to,
        subject: info.mail.subject,
        body: info.mail.body
      }), function(payload, error) {
        account.unsubscribing = false
        if (error) {
          account.fail(error)
          return
        }
        account.unsubscribeDone = "Unsubscribe request sent to " + info.mail.to
      })
      return
    }

    postUnsubscribe(info.postUrl)
  }

  // The RFC 8058 one-click request: a fixed body, to an https address on the
  // public internet that this sender put in a header saying a single POST
  // would do it. `Unsubscribe.isPostableUrl` is where both of those conditions
  // are checked, and it borrows the judgement that decides whether a message
  // may load a picture.
  //
  // Qt's XHR follows redirects without rechecking the destination. The Python
  // worker instead resolves and checks every IP, connects to that exact answer
  // while retaining the original TLS hostname, and never follows a redirect.
  // URL bytes remain data throughout: there is no shell or curl config.
  //
  // The reply is never read beyond its status. It is a document from whoever
  // sent the mail, and the only question being asked of it is whether the
  // address is off the list.
  function postUnsubscribe(url) {
    if (!Unsub.isPostableUrl(url)) {
      account.fail("That unsubscribe address is not one this can post to")
      return
    }
    account.unsubscribing = true
    var request = unsubscribeComponent.createObject(account, {
      command: ["python3", account.pluginDir + "/scripts/unsubscribe.py"],
      requestLine: [Mail.encodeBase64(String(url)),
        Mail.encodeBase64(Unsub.postContentType()),
        Mail.encodeBase64(Unsub.postBody())].join(" ")
    })
    if (!request) {
      account.unsubscribing = false
      account.fail("The unsubscribe request could not be sent")
      return
    }
    request.finished.connect(function(exitCode, status) {
      if (!root) return
      request.destroy()
      account.unsubscribing = false
      account.unsubscribeDone = ""
      if (exitCode !== 0 || status === 0) {
        account.fail("The unsubscribe request could not be sent")
        return
      }
      if (status >= 200 && status < 300) {
        account.unsubscribeDone = "Unsubscribed from this list"
        return
      }
      // A 3xx is a server answering a one-click request with "go and ask over
      // there". It has not done what its own header promised, and the address
      // it points at was never judged — so it is reported as a refusal rather
      // than followed.
      account.fail(status >= 300 && status < 400
        ? "This list answered with a redirect instead of account.unsubscribing (" + status + ")"
        : "This list refused the unsubscribe request (" + status + ")")
    })
    request.running = true
  }

  // One process per request, created and destroyed around it. The same shape
  // the mail transport uses, for the same reason: the URL crosses on stdin
  // base64-encoded, so a header a stranger wrote never reaches the process
  // table and nothing has to be escaped on the way.

  readonly property Component unsubscribeComponent: Component {

    Process {
      id: unsubscribeProcess

      property string requestLine: ""
      signal finished(int exitCode, int status)

      stdinEnabled: true
      stdout: StdioCollector { waitForEnd: true }
      stderr: StdioCollector { waitForEnd: true }

      onStarted: {
        // One line, because Quickshell's Process.write() never closes stdin and
        // the script would wait forever for an EOF that does not come.
        write(requestLine + "\n")
        requestLine = ""
      }

      onExited: function(exitCode) {
        // "<transport error code> <http status>", and nothing else is read.
        var parts = String(unsubscribeProcess.stdout.text || "").trim().split(/\s+/)
        var code = Math.floor(Number(parts[0]))
        var status = Math.floor(Number(parts[1]))
        if (exitCode !== 0 || parts.length < 2 || !isFinite(code) || !isFinite(status)) {
          unsubscribeProcess.finished(exitCode === 0 ? 1 : exitCode, 0)
          return
        }
        unsubscribeProcess.finished(code, status)
      }
    }
  }
}
