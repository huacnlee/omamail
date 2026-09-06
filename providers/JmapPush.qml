import QtQuick
import Quickshell.Io

import "JmapProtocol.js" as Jmap

// One JMAP event stream, held open for one account.
//
// `JmapClient` builds exactly one of these and re-emits what it reports. The
// client keeps its fifteen methods; everything a long-lived connection costs —
// the process, the line parser, the watchdog, the backoff and the clock-jump
// detector that catches a resume from suspend — is here, because none of it is
// a request and none of it belongs in a file about requests.
//
// ## What it is for
//
// The poll is a floor, not a ceiling. It answers "is there new mail" every two
// minutes for every account, window or not, and that is what the bar badge and
// the notification are built on. The stream makes the same answer arrive in
// about a second, and adds nothing else: a `StateChange` becomes a plan, the
// plan becomes the account's own `loadLabels()` and `refresh()`, and every path
// after that is the poll's.
//
// ## The three things that stop it being a busy loop
//
//   1. *The echo.* The server tells every connection about this panel's own
//      write, about a second after the action's callback has already
//      revalidated. `Jmap.refreshPlan` drops an event naming only states the
//      client was handed by the replies it made — so a read, a star or an
//      archive costs one round trip rather than two.
//   2. *The backoff.* A failure doubles from a second to a five-minute cap and
//      resets on the first line of a working connection. A server that is down
//      is asked once every five minutes, not once a second for the rest of the
//      afternoon.
//   3. *The 401.* A revoked app password is not a connection problem and
//      retrying it is how an app password gets locked. The flag goes up, the
//      setup card draws, and nothing here reconnects until a sign-in clears it.
Item {
  id: root

  visible: false
  width: 0
  height: 0

  // The `JmapClient` this stream belongs to. Read for its transport path, its
  // session, its account id and the states it has already been told — and
  // never written: what the stream learns goes back up as a signal.
  required property var client

  // The plan a `StateChange` amounted to for this account: `{ mail, mailboxes }`.
  // Emitted only for an event that is about this account and names at least one
  // state the client does not already hold.
  signal remoteChanged(var plan)

  // A 401 on the stream, which is a revoked credential rather than a bad
  // minute. The client raises its flag; that turns `wanted` false and this
  // stops until a successful sign-in clears it.
  signal secretRejected()

  // The stream should be up: a mailbox with a secret in memory whose credential
  // has not been refused. Deliberately not gated on the window — the badge and
  // the notification for a mailbox nobody is looking at are the whole reason
  // the poll exists, and the stream is the poll arriving sooner.
  readonly property bool wanted: !!client && !!client.auth && client.auth.loggedIn
    && !client.credentialsRejected

  // Where it connects, which is the session's own `eventSourceUrl` template and
  // nowhere else — the same rule the API URL and the download template follow,
  // because it is a URL this account's password is sent to. Empty until the
  // session has been read, and empty forever on a server that publishes none.
  readonly property string template: client && client.session
    ? Jmap.eventSourceTemplate(client.session) : ""

  // ---------------------------------------------------------- the state

  // An exit this object asked for and does not reconnect from: the account is
  // going away, the credential was refused, the user signed out.
  property bool stopping: false
  // An exit this object asked for and *does* reconnect from, carrying the code
  // the reconnect table should read instead of curl's — the watchdog and the
  // resume detector both stop a connection that is already dead, and curl's own
  // "terminated" tells the table nothing about which of them did it.
  property var forcedExit: null
  // Whether anything at all has arrived on this connection. Reset at connect,
  // because before the first line a fresh connection and a hung one look alike.
  property bool heard: false
  // How many failures have been backed off from since the last line arrived.
  property int attempt: 0
  // The status from the `http <code>` trailer the `stream` verb prints once
  // curl has finished, which is what splits a `--fail` exit 22 into a rejected
  // credential and a server having a bad minute.
  property int lastStatus: 0
  // The interval the server settled on. Requested at the RFC's floor and then
  // believed: a server may clamp it up, and the watchdog has to follow or it
  // would cut a connection that is behaving exactly as the server said it
  // would. Kept across reconnects, because the first ping of the next
  // connection arrives after the watchdog would otherwise have fired.
  property int pingSeconds: Jmap.EVENT_PING_SECONDS
  property var eventState: Jmap.emptyEventState()
  property string requestLine: ""
  // A session read is in flight, or the credential is being looked up. Either
  // way a second `begin()` would start a second stream.
  property bool opening: false
  // Wall-clock time at the last tick of the resume detector.
  property double lastTickMs: 0
  // The template the running connection was opened against. A mailbox pointed
  // at another server is another mailbox: the session goes, the template goes
  // with it, and a stream still attached to the old address has to go too.
  property string connectedTemplate: ""
  // When the running connection was opened, on the wall clock. `Jmap.
  // connectionSettled` reads it against `wallClockMs()`.
  property double connectedAtMs: 0
  // The wall clock, unless a test has pinned it: a ping interval is thirty
  // seconds, and a test that moves time is one that need not wait it out.
  property double pinnedClockMs: 0
  function wallClockMs() { return pinnedClockMs > 0 ? pinnedClockMs : Date.now() }

  // A connection that has lasted a whole ping interval. Only such a
  // connection resets the backoff and only its clean close reconnects at
  // once: one that a server closed after its first line, however clean the
  // close, is a failure the table has to count.
  function settled() {
    return Jmap.connectionSettled(connectedAtMs, wallClockMs(), pingSeconds)
  }

  // ---------------------------------------------------------- lifecycle

  onWantedChanged: wanted ? begin() : stop()
  onTemplateChanged: {
    if (stream.running && template !== connectedTemplate) forceReconnect(0)
    else if (wanted && template !== "") begin()
  }
  Component.onCompleted: if (wanted) begin()
  // The destructor SIGKILLs, which runs no trap in the transport script and so
  // leaves curl behind. Asking for the stop first is what lets the script take
  // its curl down with it.
  Component.onDestruction: stop()

  function begin() {
    if (!wanted || stream.running || opening) return
    retry.stop()
    if (template === "") {
      // No session yet. Reading one is the client's job and it caches the
      // answer, so this costs a round trip once per restart rather than one per
      // reconnect — and `template` changing is what brings us back here.
      opening = true
      client.ensureSession(function(error) {
        if (!root) return
        root.opening = false
        if (String(error || "") !== "" && root.wanted) root.backOff()
      })
      return
    }
    connect()
  }

  function connect() {
    var url = Jmap.eventSourceUrl(template, Jmap.EVENT_TYPES, Jmap.EVENT_PING_SECONDS)
    if (url === "") return
    opening = true
    client.auth.withCredentials(function(credential, error) {
      if (!root) return
      root.opening = false
      if (!root.wanted || stream.running) return
      if (String(error || "") !== "" || !credential) {
        root.backOff()
        return
      }
      root.eventState = Jmap.emptyEventState()
      root.lastStatus = 0
      root.heard = false
      root.stopping = false
      root.forcedExit = null
      // The credential crosses base64 on one line of stdin, and the script
      // builds the header: there is no place here, either, where an
      // `Authorization` value is assembled.
      root.connectedTemplate = root.template
      root.requestLine = "stream " + [root.client.field(url),
        root.client.field(credential.scheme), root.client.field(credential.username),
        root.client.field(credential.secret)].join(" ")
      stream.command = [String(root.client.transport)]
      stream.running = true
    })
  }

  function stop() {
    retry.stop()
    watchdog.stop()
    if (!stream.running) return
    stopping = true
    stream.running = false
  }

  // Stop a connection this object has decided is dead, and reconnect from it as
  // if curl had exited that way. `code` is what the reconnect table reads.
  function forceReconnect(code) {
    if (!stream.running) return
    forcedExit = code
    stream.running = false
  }

  function backOff() {
    var plan = Jmap.reconnectDelay(Jmap.EXIT_STREAM_SILENT, 0, attempt)
    attempt = plan.attempt
    schedule(plan.delay)
  }

  function schedule(delay) {
    // Zero is a legal `Timer` interval and fires on the next turn of the event
    // loop, which is what "reconnect at once" means here — but it still goes
    // through the loop rather than recursing out of the exit handler.
    retry.interval = Math.max(0, Math.floor(Number(delay)) || 0)
    retry.restart()
  }

  // ------------------------------------------------------------ the lines

  // One whole event, as `SplitParser` hands it over: the field lines with the
  // blank line that ended them already taken off. It is fed back through the
  // line grammar rather than read as a block, because a block is not what the
  // wire format is — it is a stream of lines, and `Jmap.parseEventLine` is
  // written and tested against that.
  //
  // Liveness is decided here rather than per line, and it asks whether the
  // *server* said anything: curl's `http <code>` trailer arrives on the same
  // stdout, and reading that as a sign of life resets the backoff on every
  // failed connection — which is a reconnect once a second for as long as the
  // server is down, measured before this was written.
  function readBlock(block) {
    var text = String(block === undefined || block === null ? "" : block)
    var lines = text.split("\n")
    var spoke = false
    for (var i = 0; i < lines.length; i++)
      if (readLine(lines[i])) spoke = true
    // The terminator `SplitParser` consumed. Without it nothing would ever end
    // an event, because the blank line is the only thing that does.
    readLine("")
    if (!spoke) return
    heard = true
    watchdog.restart()
    if (settled()) attempt = 0
  }

  // True when this line is the server talking, which is everything but curl's
  // own trailer and the blank lines around an event.
  function readLine(line) {
    var text = String(line === undefined || line === null ? "" : line)
    // The trailer, printed by `--write-out` after the transfer has ended. It
    // arrives on the same stdout as the events, and it is not one.
    var status = Jmap.streamTrailerStatus(text)
    if (status >= 0) {
      // Zero is a real trailer — curl's `000`, no HTTP response at all — and
      // the commonest one on a connection that failed. Only -1 means this line
      // was not the trailer.
      lastStatus = status
      return false
    }

    var next = Jmap.parseEventLine(eventState, text)
    eventState = next
    if (next.kind === "ping" && next.interval > 0) pingSeconds = next.interval
    if (next.kind === "state" && next.changed) {
      var plan = Jmap.refreshPlan(next.changed, client.accountId, client.knownStates)
      if (plan) root.remoteChanged(plan)
    }
    return text.replace(/\r+$/, "") !== ""
  }

  function finish(code) {
    var forced = forcedExit
    // Heard *and* kept: a server that spoke once and closed in the same
    // second has not shown the connection was ever any good.
    var spoke = heard && settled()
    forcedExit = null
    watchdog.stop()
    heard = false
    requestLine = ""
    if (stopping) {
      stopping = false
      return
    }
    // A stop this object forced carries its own code; anything else is curl's,
    // read against whether the server ever spoke on that connection.
    var exitCode = forced === null || forced === undefined
      ? Jmap.streamExit(code, spoke) : forced
    var plan = Jmap.reconnectDelay(exitCode, lastStatus, attempt)
    if (plan.rejected) {
      root.secretRejected()
      return
    }
    if (plan.stop) return
    attempt = plan.attempt
    schedule(plan.delay)
  }

  Process {
    id: stream

    running: false
    stdinEnabled: true
    // The stream's own body shape, and the third one this client reads: not the
    // four-line base64 reply the request verbs answer with, and not the
    // untouched base64 blob a download stays as. It is read while it is open,
    // so there is nothing to wait for the end of and nothing to decode.
    //
    // The transport normalizes CR, LF and CRLF and bounds each complete
    // event before it reaches this process. SplitParser itself has no size
    // limit, so checking only in readBlock would be too late.
    stdout: SplitParser {
      splitMarker: "\n\n"
      onRead: function(block) { root.readBlock(block) }
    }
    stderr: StdioCollector { waitForEnd: true }

    onStarted: {
      // One line, because `Process.write()` never closes stdin and the script
      // would wait forever for an EOF that does not come.
      write(root.requestLine + "\n")
      root.requestLine = ""
      root.connectedAtMs = root.wallClockMs()
      watchdog.restart()
      // The server replays nothing between connections — Stalwart sends no
      // event ids at all — so everything that changed while this was down is
      // invisible until something asks. One refresh per connect is what asks.
      root.remoteChanged({ mail: true, mailboxes: true })
    }

    onExited: function(exitCode) { root.finish(exitCode) }
  }

  Timer {
    id: retry
    repeat: false
    onTriggered: root.begin()
  }

  // Twice the interval the server named. A connection that has said nothing for
  // two pings is not slow, it is gone: the ping exists precisely so that
  // silence means something.
  Timer {
    id: watchdog
    interval: Math.max(2, root.pingSeconds * 2) * 1000
    repeat: false
    onTriggered: root.forceReconnect(Jmap.EXIT_STREAM_SILENT)
  }

  // The resume detector. Qt's timers run on the monotonic clock, which stops
  // while the machine is suspended, so the watchdog above has no idea that four
  // hours went by — it will happily wait out the rest of its sixty seconds on a
  // connection the server closed before lunch. The wall clock does know.
  Timer {
    id: clock
    interval: 30000
    repeat: true
    running: root.wanted
    onRunningChanged: root.lastTickMs = Date.now()
    onTriggered: {
      var now = Date.now()
      var last = root.lastTickMs
      root.lastTickMs = now
      if (last <= 0 || !Jmap.clockJumped(last, now, interval)) return
      // Reconnect at once rather than backing off: the machine has just woken
      // and the user is looking at the panel. If the network is not up yet the
      // failed connect backs off on its own.
      root.forceReconnect(0)
    }
  }
}
