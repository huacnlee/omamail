import QtQuick
import Quickshell
import Quickshell.Io

import "HeyCli.js" as Cli

// A HEY account's sign-in, which is somebody else's program.
//
// It is the counterpart to `AuthManager` and `ImapAuth`, and deliberately the
// same shape from outside: `MailAccount` asks any of the three whether it is
// `loggedIn` and drives them through identical calls. What differs is that
// there is no credential here at all. `hey` performs the OAuth flow, keeps the
// token in the system keyring, refreshes it when it expires and hands nothing
// back — so this object holds a yes or a no and the path to the program, and
// never anything worth redacting.
//
// That is the whole reason this provider is allowed to exist. Driving
// app.hey.com's private endpoints would mean asking for a HEY password so it
// could be replayed against an interface carrying no compatibility promise;
// asking `hey` means the credential is held by the program 37signals ship for
// exactly this, and a deploy nobody announced is their problem rather than a
// mailbox that stops opening.
Item {
  id: root

  visible: false
  width: 0
  height: 0

  required property string pluginDir

  // Which mailbox this signs in. HEY holds one identity per machine, so this is
  // the address `hey accounts list` reports rather than anything typed.
  property string accountId: ""

  // Where the program is. Resolved once by the probe below and used for every
  // invocation, so a `hey` that arrives on PATH later — or one that was never
  // on it — is a single answer rather than a question per command.
  property string heyPath: ""

  // The one tool, and the only thing that can be missing. `secret-tool` is not
  // among them: this provider writes nothing to the keyring, because `hey`
  // already keeps its own token there.
  readonly property var requiredTools: ["hey"]
  property var missingTools: ["hey"]
  property bool toolsChecked: false
  readonly property bool toolsPresent: toolsChecked && missingTools.length === 0

  // Nothing to configure. Gmail needs an OAuth client and IMAP needs a server
  // and a username; a HEY mailbox needs the program, and then a sign-in.
  readonly property bool credentialsPresent: toolsPresent

  property bool loggedIn: false
  property bool statusChecked: false
  property bool loginBusy: false
  readonly property bool sessionBusy: statusProbe.running
  property string lastError: ""

  signal loginSucceeded()
  signal loggedOut()
  signal sessionUnavailable(string reason)
  signal credentialsSaved()

  function safeError(value) {
    return Cli.redact(String(value || ""))
  }

  // ---------------------------------------------------------------- session

  // Asked once when the account is built, and again after every sign-in. A
  // token that expires while the window is open is `hey`'s to refresh, and a
  // command that fails because it could not is what tells this object to look
  // again — see `reportAuthFailure`.
  function restoreSession() {
    if (!toolsChecked) return
    if (!toolsPresent) {
      statusChecked = true
      return
    }
    if (statusProbe.running) return
    statusProbe.command = [heyPath].concat(Cli.statusCommand())
    statusProbe.running = true
  }

  function handleStatus(text) {
    var answer = Cli.payload(text)
    statusChecked = true
    var wasLoggedIn = loggedIn
    loggedIn = answer.ok && Cli.isAuthenticated(answer.data)
    if (loggedIn) {
      lastError = ""
      if (!wasLoggedIn) loginSucceeded()
      return
    }
    // Only a mailbox that is otherwise ready to go is worth complaining about:
    // an account whose program is not installed yet has no session by design.
    if (toolsPresent && !loginBusy) sessionUnavailable("Sign in to HEY")
  }

  // ---------------------------------------------------------------- signing in

  // `hey auth login` opens the browser itself and waits for the callback, so
  // this is one process and one exit code rather than a redirect this plugin
  // has to catch. Nothing is passed to it: the account it signs in is whichever
  // HEY identity the user picks in that browser.
  function beginLogin() {
    if (!toolsPresent) {
      lastError = "Install the HEY CLI first"
      return
    }
    if (loginBusy) return
    lastError = ""
    loginBusy = true
    loginProcess.command = [heyPath].concat(Cli.loginCommand())
    loginProcess.running = true
  }

  function cancelLogin() {
    if (loginProcess.running) loginProcess.running = false
    loginBusy = false
  }

  // The password providers' entry point. HEY's sign-in is a browser `hey` owns,
  // so there is no secret to take — answering false is what lets one setup page
  // ask without checking which provider it holds first.
  function signIn(secret) {
    return false
  }

  // Signing out is `hey`'s own logout, because the credential is `hey`'s: there
  // is nothing here to forget, and a sign-out that only forgot locally would be
  // undone by the next status read a second later.
  //
  // It therefore signs this machine's HEY client out of everything that uses
  // it, which the setup page says before the button is pressed.
  function logout() {
    loggedIn = false
    statusChecked = true
    cancelLogin()
    if (toolsPresent) {
      logoutProcess.command = [heyPath, "auth", "logout"]
      logoutProcess.running = true
    }
    loggedOut()
  }

  // Kept so `MailAccount` can call the same thing on either provider. There is
  // no token here to invalidate — `hey` refreshes its own — so this asks the
  // program what it thinks rather than throwing anything away.
  function invalidateAccessToken() {
    restoreSession()
  }

  // What the client calls when a command failed for a reason that sounds like
  // the session rather than the request. The status read is the arbiter: a
  // network blip must not sign a working mailbox out.
  function reportAuthFailure() {
    restoreSession()
  }

  onAccountIdChanged: {
    // One HEY login serves whichever account row is on screen, so unlike the
    // other two providers there is nothing keyed by account to drop here.
  }

  // Asked again after the user has installed the program. The setup page has a
  // button for it because the alternative is telling somebody to restart their
  // desktop shell to be noticed.
  function recheck() {
    if (toolProbe.running) return
    probe()
  }

  function probe() {
    // `command -v` first, so a `hey` the user put anywhere on PATH wins. The
    // fallback is the one directory both ways of installing it use — the
    // official installer writes the binary there, and Omarchy's mise wrapper
    // writes a shell script of the same name — because a Quickshell started
    // before that directory joined PATH would otherwise never find it.
    toolProbe.command = ["sh", "-c",
      "command -v hey 2>/dev/null || { [ -x \"$HOME/.local/bin/hey\" ] "
      + "&& printf '%s\\n' \"$HOME/.local/bin/hey\"; }"]
    toolProbe.running = true
  }

  Component.onCompleted: probe()

  Process {
    id: toolProbe
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var found = String(text || "").split("\n")[0].trim()
        root.heyPath = found
        root.missingTools = found === "" ? ["hey"] : []
        root.toolsChecked = true
        root.restoreSession()
      }
    }
    stderr: StdioCollector { waitForEnd: true }
  }

  Process {
    id: statusProbe
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
    onExited: function(exitCode) {
      // `hey auth status` reports "not logged in" in its own envelope and exits
      // non-zero for it, so the body is read either way and the exit code only
      // decides what to say when there is no body at all.
      var text = String(statusProbe.stdout.text || "")
      if (text.trim() === "" && exitCode !== 0) {
        root.statusChecked = true
        root.loggedIn = false
        root.lastError = Cli.commandError(exitCode, "",
          String(statusProbe.stderr.text || ""), "Could not ask the HEY CLI whether it is signed in")
        root.sessionUnavailable(root.lastError)
        return
      }
      root.handleStatus(text)
    }
  }

  Process {
    id: loginProcess
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
    onExited: function(exitCode) {
      root.loginBusy = false
      if (exitCode !== 0) {
        root.lastError = Cli.commandError(exitCode,
          String(loginProcess.stdout.text || ""),
          String(loginProcess.stderr.text || ""),
          "The HEY sign-in did not finish")
        return
      }
      // Believed only once `hey` says so. An exit code says the browser closed,
      // not that a token came back with it.
      root.restoreSession()
    }
  }

  Process {
    id: logoutProcess
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
  }
}
