import QtQuick 2.15
import QtTest 1.3
import qs.Commons
import "../.." as Omamail
import "../../components" as Mail
import "../../account/Accounts.js" as Accounts
import "BackendFixture.js" as BackendFixture
import "NativeIntentFixture.js" as NativeIntentFixture

// A message opened with the setting on and a date in its text is handed to
// the agent once, in the background; what the agent finds is the card, and
// the card hands Add to the calendar's composer. Every gate is asserted:
// the setting, a date, one look per message, the owning account. The read
// goes through the service's own backend (`agent.context`), the start is
// recorded at the runner's RPC boundary, and the projection that says what
// a look is runs in the real native implementation.
Item {
  width: 900
  height: 600

  QtObject {
    id: shellStore
    function updateEntryInline(_id, _entry) {}
    function hide(_id) {}
  }

  Omamail.Service {
    id: mailService
    shell: shellStore
    manifest: ({ id: "omamail", __sourceDir: "/tmp/omamail-test" })
  }

  // The runner's backend: the real projection, a listing the test sets, and
  // every start recorded rather than run.
  QtObject {
    id: bridge
    property bool ready: true
    property var modelBridge: null
    property var starts: []
    property var listed: []
    property var projectionErrors: []
    property bool holdStarts: false
    property var held: []
    property string refuse: ""
    function call(method, params, callback) {
      if (method === "agent.jobsProjection") { modelBridge.call(method, params, function(result, error) { if (error) bridge.projectionErrors = bridge.projectionErrors.concat([error]); callback(result, error) }); return }
      if (method === "agent.jobsList") { callback(listed, ""); return }
      if (method === "agent.jobStart") {
        starts = starts.concat([params.payload])
        if (refuse !== "") { var code = refuse; Qt.callLater(function() { callback(null, { code: -32000, message: code }) }); return }
        if (holdStarts) { held = held.concat([callback]); return }
        Qt.callLater(function() { callback({ id: "started" }, "") })
        return
      }
      callback(null, "unsupported_test_method")
    }
    function release() {
      var calls = held
      held = []
      for (var i = 0; i < calls.length; i++) calls[i]({ id: "started" }, "")
    }
  }

  Mail.EventSuggestionCard {
    id: card
    width: 500
    textColor: Color.foreground
    accentColor: Color.accent
    dimColor: Color.foreground
    dimmerColor: Color.foreground
    panelFontFamily: "monospace"
  }
  SignalSpy { id: added; target: card; signalName: "addRequested" }
  SignalSpy { id: dismissed; target: card; signalName: "dismissRequested" }

  TestCase {
    name: "EventSuggestions"
    when: windowShown

    readonly property string ada: "imap:ada@example.com"
    readonly property string bob: "imap:bob@example.com"
    property var listener: null
    property var contexts: []

    function entry(email) {
      return {
        email: email, provider: "imap", clientId: "", clientSecret: "",
        imap: { imapHost: "imap.example.com", imapPort: 993, smtpHost: "smtp.example.com", smtpPort: 465,
          username: email, aliases: [], insecure: false },
        label: "", signature: ""
      }
    }
    function summary(id, subject, from, labels) {
      return ({ id: id, threadId: "", subject: subject, snippet: "", time: "", date: new Date().toISOString(),
        from: { email: from || "bob@example.com", display: "Bob" }, unread: false, starred: false, inInbox: true,
        labelIds: labels || ["INBOX"] })
    }
    function runner() {
      var kids = mailService.children
      for (var i = 0; i < kids.length; i++) {
        var candidate = kids[i].item || kids[i]
        if (candidate.jobs !== undefined && candidate.pluginDir !== undefined) return candidate
      }
      return null
    }
    function calendarFor(email) {
      return ({ version: 1, sources: [{
        id: "caldav:" + email, kind: "caldav", name: "Home", url: "https://calendar.example/" + email + "/",
        username: email, enabled: true, readOnly: false, colorKey: "accent" }] })
    }
    function settled() { wait(1); tryVerify(function() { return bridge.modelBridge.pending.length === 0 }) }
    function setJobs(jobs) {
      bridge.listed = jobs
      runner().applyListing(jobs)
      settled()
      compare(bridge.projectionErrors.length, 0, "Synthetic looks must satisfy the native projection contract")
    }
    function look(id, account, message, state, events) {
      return { id: id, kind: "events", messageId: message, messageIds: [message], accountId: account, state: state,
        created: 1, createdOrder: Number(id.replace(/\D/g, "")) || 1, events: events || [] }
    }

    function initTestCase() {
      BackendFixture.markReady(mailService)
      listener = BackendFixture.install(mailService)
      // The read: Rust would fetch the message inside its account; here the
      // payload is built from what was asked, and the ask is recorded.
      listener.answers["agent.context"] = function(params) {
        contexts = contexts.concat([params])
        var row = params.summaries[0]
        return { payload: { messageId: params.ids[0], accountId: params.accountId, account: params.accountId.split(":")[1],
          folder: params.folder, subject: row.subject, prompt: params.prompt, message: "Subject: " + row.subject + "\n\n" + String(row.bodyText || "") } }
      }
      bridge.modelBridge = NativeIntentFixture.backend(mailService)
    }

    function seed(activeId) {
      var list = Accounts.emptyList()
      list = Accounts.add(list, entry("ada@example.com"))
      list = Accounts.add(list, entry("bob@example.com"))
      list = Accounts.setActive(list, activeId)
      mailService.activeIndex = -1
      mailService.accountList = list
      mailService.accountsLoaded = true
      wait(0)
      mailService.refreshCurrent()
      tryCompare(mailService, "activeAccountId", activeId)
      var agent = runner()
      verify(agent !== null)
      agent.backend = null
      bridge.starts = []
      bridge.projectionErrors = []
      bridge.holdStarts = false
      bridge.held = []
      bridge.refuse = ""
      contexts = []
      agent.backend = bridge
      setJobs([])
      return agent
    }
    function open(account, id, subject, text, from, labels) {
      account.selectedId = id
      account.selectedMessage = summary(id, subject, from, labels)
      account.selectedBody = ({ text: text, source: "" })
    }
    function lastStart() {
      tryVerify(function() { return bridge.starts.length > 0 }, 1000, "a look was started")
      return bridge.starts[bridge.starts.length - 1]
    }
    function named(item, name, out) {
      if (item.objectName === name) out.push(item)
      var kids = item.children || []
      for (var i = 0; i < kids.length; i++) named(kids[i], name, out)
      return out
    }

    function init() {
      if (Qt.platform.os !== "linux") { skip("The plugin agent backend is Linux-only"); return }
      added.clear(); dismissed.clear(); card.suggestions = []
      mailService.backend.protocolInfo = { apiVersion: 2, protocol: 1, version: "0.0.0" }
      mailService.backendRuntime.latestApiVersion = 2
    }

    function test_a_dated_message_is_looked_at_once_when_asked() {
      var agent = seed(ada)
      var adas = mailService.accountAt(0)
      mailService.settings = ({ suggestEvents: false })
      open(adas, "42:INBOX", "Dinner?", "Dinner on Thursday at 7pm?")
      wait(20)
      compare(bridge.starts.length, 0, "off is off")
      compare(contexts.length, 0, "and nothing is even read")

      // Turning it on looks at the message already open, once.
      mailService.settings = ({ suggestEvents: true })
      var first = lastStart()
      compare(first.messageId, "42:INBOX", "on looks at what is open")
      compare(first.events, true)
      compare(first.accountId, ada)
      compare(first.prompt, "Find the calendar events in this message.")
      compare(contexts[0].ids[0], "42:INBOX")
      compare(contexts[0].accountId, ada)
      verify(first.message.indexOf("Dinner?") >= 0)
      tryCompare(agent, "starting", false)

      bridge.starts = []
      open(adas, "43:INBOX", "Hello", "Just saying hi")
      wait(20)
      compare(bridge.starts.length, 0, "no date, no look")

      open(adas, "44:INBOX", "Dinner?", "Dinner on Thursday at 7pm?")
      compare(lastStart().messageId, "44:INBOX")
      tryCompare(agent, "starting", false)

      // A date in the subject alone is a date.
      bridge.starts = []
      open(adas, "46:INBOX", "Dinner Thursday at 7pm at Luigi's", "see you there")
      compare(lastStart().messageId, "46:INBOX", "the subject counts")
      tryCompare(agent, "starting", false)

      // Mail from a machine, a Gmail category, or a list is not asked
      // about, however many dates it carries: the filter comes before the
      // model, and these cost nothing.
      bridge.starts = []
      open(adas, "47:INBOX", "Run failed: nightly", "Run failed at 14:30 on Sep 12", "notifications@github.com")
      open(adas, "48:INBOX", "Sale ends Sep 30", "Only until Sep 30 at 23:59!", "bob@example.com", ["INBOX", "CATEGORY_PROMOTIONS"])
      adas.selectedUnsubscribe = ({ url: "https://list.example/leave" })
      open(adas, "49:INBOX", "Meetup Thursday at 7pm", "Join us on Thursday at 7pm", "bob@example.com")
      adas.selectedUnsubscribe = null
      wait(20)
      compare(bridge.starts.length, 0, "no look at a notification, a promotion or a list")
      compare(contexts.length, 3, "and none of them was read either")

      // The look is on the list now; opening the message again asks nothing.
      setJobs([look("look-44", ada, "44:INBOX", "running")])
      bridge.starts = []
      open(adas, "44:INBOX", "Dinner?", "Dinner on Thursday at 7pm?")
      wait(20)
      compare(bridge.starts.length, 0, "one look per message")

      // Two looks running is the ceiling.
      setJobs([look("look-1", ada, "1:INBOX", "running"), look("look-2", ada, "2:INBOX", "queued")])
      open(adas, "45:INBOX", "Lunch?", "Lunch tomorrow at noon, 12:30?")
      wait(20)
      compare(bridge.starts.length, 0, "no third look while two run")
      // One finishing frees the slot, and the waiting look starts.
      setJobs([look("look-1", ada, "1:INBOX", "done"), look("look-2", ada, "2:INBOX", "queued")])
      compare(lastStart().messageId, "45:INBOX")
    }

    function test_what_was_found_is_the_open_messages_and_the_accounts() {
      var agent = seed(ada)
      var adas = mailService.accountAt(0)
      mailService.settings = ({ suggestEvents: true })
      var start = new Date(2026, 8, 12, 19, 0).getTime()
      setJobs([
        look("look-44", ada, "44:INBOX", "done",
          [{ title: "Dinner with Bob", startMs: start, endMs: start + 7200000, location: "Luigi's" },
            { title: "Offsite", startMs: start + 86400000, endMs: start + 2 * 86400000, allDay: true }]),
        look("look-99", bob, "44:INBOX", "done", [{ title: "Bob's own", startMs: start, endMs: start + 3600000 }])
      ])
      adas.selectedId = "44:INBOX"
      adas.selectedMessage = summary("44:INBOX", "Dinner?")
      tryVerify(function() { return mailService.eventSuggestions.length === 2 }, 1000)
      compare(mailService.eventSuggestions[0].title, "Dinner with Bob")
      compare(mailService.eventSuggestions[0].key, "look-44:0")
      compare(mailService.agentJobs["44:INBOX"], undefined, "a look draws no glyph")
      compare(mailService.agentAttention, false, "and asks for nobody")

      mailService.dismissSuggestion("look-44:0")
      tryVerify(function() { return mailService.eventSuggestions.length === 1 }, 1000)
      compare(mailService.eventSuggestions[0].title, "Offsite")

      adas.selectedId = "45:INBOX"
      adas.selectedMessage = summary("45:INBOX", "Other")
      tryVerify(function() { return mailService.eventSuggestions.length === 0 }, 1000, "another message, nothing found for it")

      // Bob's look at the same id is Bob's: on his account it shows, and
      // Ada's dismissal does not reach it.
      mailService.switchToIndex(1)
      tryCompare(mailService, "activeAccountId", bob)
      var bobs = mailService.accountAt(1)
      bobs.selectedId = "44:INBOX"
      bobs.selectedMessage = summary("44:INBOX", "Dinner?")
      tryVerify(function() { return mailService.eventSuggestions.length === 1 }, 1000)
      compare(mailService.eventSuggestions[0].title, "Bob's own")
      mailService.switchToIndex(0)
      tryCompare(mailService, "activeAccountId", ada)

      // Add hands the composer the fields; a written event waves the
      // suggestion away, a refused write does not.
      adas.selectedId = "44:INBOX"
      adas.selectedMessage = summary("44:INBOX", "Dinner?")
      tryVerify(function() { return mailService.eventSuggestions.length === 1 }, 1000)
      var handed = null
      var controller = mailService.calendarController
      controller.sourceList = calendarFor("ada@example.com")
      tryVerify(function() { return controller.writableSourceGroups.length > 0 }, 1000)
      controller.composeRequested.connect(function(prefill) { handed = prefill })
      verify(mailService.addSuggestedEvent(mailService.eventSuggestions[0]))
      verify(handed !== null)
      compare(handed.title, "Offsite")
      verify(handed.description.indexOf("All day") >= 0)
      controller.eventCreated(false, "refused")
      compare(mailService.eventSuggestions.length, 1, "a refused write keeps the suggestion")
      controller.eventCreated(true, "")
      tryVerify(function() { return mailService.eventSuggestions.length === 0 }, 1000, "a written event is no longer a suggestion")
    }

    // A look the runner cannot start yet — a start already in flight —
    // waits, and starts when the runner is free; a body that arrives twice
    // asks once.
    function test_a_look_waits_for_the_runner_and_asks_once() {
      var agent = seed(ada)
      var adas = mailService.accountAt(0)
      mailService.settings = ({ suggestEvents: true })
      bridge.holdStarts = true
      open(adas, "50:INBOX", "Lunch?", "Lunch tomorrow at 12:30?")
      compare(lastStart().messageId, "50:INBOX")
      tryCompare(agent, "starting", true)
      open(adas, "51:INBOX", "Coffee?", "Coffee Friday at 9am?")
      wait(20)
      compare(bridge.starts.length, 1, "the runner is busy, so the look waits")
      compare(contexts.length, 1, "and the message is not read for nothing")
      bridge.release()
      tryCompare(agent, "starting", false)
      tryVerify(function() { return bridge.starts.length === 2 }, 1000, "and starts when it is free")
      compare(bridge.starts[1].messageId, "51:INBOX")
      bridge.release()
      tryCompare(agent, "starting", false)
      // The body arrives again before the listing carries the look.
      adas.selectedBody = ({ text: "Coffee Friday at 9am? (live)", source: "" })
      wait(20)
      compare(bridge.starts.length, 2, "asked once")
    }

    // Add is refused, with a word, while the composer holds another event
    // or when there is no calendar to write to; closing the composer
    // without writing forgets the suggestion it was opened on.
    function test_add_respects_the_composer_and_the_calendars() {
      var agent = seed(ada)
      var adas = mailService.accountAt(0)
      mailService.settings = ({ suggestEvents: true })
      var start = new Date(2026, 8, 12, 19, 0).getTime()
      setJobs([look("look-46", ada, "46:INBOX", "done", [{ title: "Dinner", startMs: start, endMs: start + 3600000 }])])
      adas.selectedId = "46:INBOX"
      adas.selectedMessage = summary("46:INBOX", "Dinner?")
      tryVerify(function() { return mailService.eventSuggestions.length === 1 }, 1000)
      var controller = mailService.calendarController
      var handed = []
      controller.composeRequested.connect(function(prefill) { handed.push(prefill) })
      controller.sourceList = ({ version: 1, sources: [] })
      compare(mailService.addSuggestedEvent(mailService.eventSuggestions[0]), false, "no calendar, no composer")
      verify(adas.lastError.indexOf("No calendar") >= 0, adas.lastError)
      compare(handed.length, 0)
      controller.sourceList = calendarFor("ada@example.com")
      tryVerify(function() { return controller.writableSourceGroups.length > 0 }, 1000)
      controller.composerHeld = true
      compare(mailService.addSuggestedEvent(mailService.eventSuggestions[0]), false)
      verify(adas.lastError.indexOf("Finish the event") >= 0, adas.lastError)
      controller.composerHeld = false
      verify(mailService.addSuggestedEvent(mailService.eventSuggestions[0]))
      compare(handed.length, 1)
      compare(handed[0].accountId, ada, "the reading mailbox's calendar")
      controller.composeEnded()
      controller.eventCreated(true, "")
      compare(mailService.eventSuggestions.length, 1, "an event written after the composer closed is not this one")
    }

    // The system AI is Codex, say: Rust refuses the look with a word, the
    // status line stays quiet, and no other message is asked about until
    // the setting is turned off and on again.
    function test_another_default_agent_refuses_once_and_quietly() {
      var agent = seed(ada)
      var adas = mailService.accountAt(0)
      mailService.settings = ({ suggestEvents: true })
      bridge.refuse = "agent_choose_claude"
      var line = adas.lastError
      open(adas, "60:INBOX", "Dinner?", "Dinner on Thursday at 7pm?")
      compare(lastStart().messageId, "60:INBOX")
      tryCompare(agent, "starting", false)
      compare(adas.lastError, line, "a refused look puts nothing on the status line")
      open(adas, "61:INBOX", "Lunch?", "Lunch tomorrow at 12:30?")
      wait(20)
      compare(bridge.starts.length, 1, "and nothing more is asked this session")
      compare(contexts.length, 1, "nor read")
      mailService.settings = ({ suggestEvents: false })
      bridge.refuse = ""
      mailService.settings = ({ suggestEvents: true })
      tryVerify(function() { return bridge.starts.length === 2 }, 1000, "off and on asks again")
      compare(bridge.starts[1].messageId, "61:INBOX")
    }

    // API 2 is a fixed feature requirement. Moving the release labels or
    // adding API 3 does not change what an API 2 backend can do.
    function test_event_suggestions_require_api_two_across_releases() {
      var agent = seed(ada)
      var adas = mailService.accountAt(0)
      mailService.backend.protocolInfo = { apiVersion: 1, protocol: 1, version: "0.0.0" }
      mailService.backendRuntime.latestApiVersion = 2
      mailService.settings = ({ suggestEvents: true })
      open(adas, "70:INBOX", "Dinner?", "Dinner on Thursday at 7pm?")
      wait(20)
      compare(bridge.starts.length, 0, "API 1 cannot run event suggestions")
      compare(contexts.length, 0, "no mail is read for an unsupported feature")
      mailService.backendRuntime.latestApiVersion = 1
      wait(20)
      compare(bridge.starts.length, 0, "changing release labels cannot make API 1 support the feature")
      mailService.backend.protocolInfo = { apiVersion: 2, protocol: 1, version: "0.0.0" }
      compare(lastStart().messageId, "70:INBOX", "API 2 makes the pending feature available")
      mailService.backendRuntime.latestApiVersion = 3
      open(adas, "71:INBOX", "Dinner again?", "Dinner on Friday at 7pm?")
      tryVerify(function() { return bridge.starts.length === 2 }, 1000)
      compare(lastStart().messageId, "71:INBOX", "an unrelated API 3 does not disable API 2 features")
    }

    function test_the_card_draws_text_and_asks_the_reader() {
      var start = new Date(2026, 8, 12, 19, 0).getTime()
      card.suggestions = [
        { key: "j:0", jobId: "j", index: 0, title: "<b>Dinner</b> <img src=\"http://127.0.0.1:1/x\">",
          startMs: start, endMs: start + 3600000, location: "Luigi's", notes: "Bring <i>wine</i>" },
        { key: "j:1", jobId: "j", index: 1, title: "Offsite", startMs: start, endMs: start + 86400000, allDay: true, location: "", notes: "" }
      ]
      tryCompare(card, "visible", true)
      // Folded until asked: the heading says how many, the rows wait.
      compare(named(card, "suggestionHeading", [])[0].text, "The agent found 2 events in this message")
      compare(named(card, "suggestionTitle", []).length, 0, "a guess is a line above the message, not a panel over it")
      compare(card.expanded, false)
      var foldedHeight = card.height
      mouseClick(named(card, "suggestionHeader", [])[0])
      tryCompare(card, "expanded", true)
      tryVerify(function() { return card.height > foldedHeight }, 1000, "and opens on a click")
      var titles = named(card, "suggestionTitle", [])
      compare(titles.length, 2)
      compare(titles[0].text, "<b>Dinner</b> <img src=\"http://127.0.0.1:1/x\">")
      compare(titles[0].textFormat, Text.PlainText, "the agent's words are text, never HTML")
      compare(named(card, "suggestionNotes", [])[0].textFormat, Text.PlainText)
      compare(named(card, "suggestionLocation", [])[0].textFormat, Text.PlainText)
      compare(named(card, "suggestionWhen", [])[1].text.indexOf("(all day)") > 0, true)
      var adds = named(card, "suggestionAdd", [])
      var dismisses = named(card, "suggestionDismiss", [])
      compare(adds.length, 2)
      mouseClick(adds[1])
      compare(added.count, 1)
      compare(added.signalArguments[0][0].title, "Offsite")
      mouseClick(dismisses[0])
      compare(dismissed.count, 1)
      compare(dismissed.signalArguments[0][0], "j:0")
      // Another look's findings fold again; the same look's do not.
      card.suggestions = [{ key: "j:1", jobId: "j", index: 1, title: "Offsite", startMs: start, endMs: start + 3600000, location: "", notes: "" }]
      compare(card.expanded, true, "one dismissed is still the same look")
      card.suggestions = [{ key: "k:0", jobId: "k", index: 0, title: "Other", startMs: start, endMs: start + 3600000, location: "", notes: "" }]
      compare(card.expanded, false, "a new look starts folded")
      card.suggestions = []
      tryCompare(card, "visible", false)
    }
  }
}
