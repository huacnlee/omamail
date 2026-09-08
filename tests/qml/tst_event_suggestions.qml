import QtQuick 2.15
import QtTest 1.3
import qs.Commons
import "../.." as Omamail
import "../../components" as Mail
import "../../account/Accounts.js" as Accounts

// A message opened with the setting on and a date in its text is handed to
// the agent once, in the background; what the agent finds is the card, and
// the card hands Add to the calendar's composer. Every gate is asserted:
// the setting, a date, one look per message, the owning account.
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

    function entry(email) {
      return {
        email: email, provider: "imap", clientId: "", clientSecret: "",
        imap: { imapHost: "imap.example.com", imapPort: 993, smtpHost: "smtp.example.com", smtpPort: 465,
          username: email, aliases: [], insecure: false },
        label: "", signature: ""
      }
    }
    function summary(id, subject) {
      return ({ id: id, threadId: "", subject: subject, snippet: "", time: "", date: new Date().toISOString(),
        from: { email: "bob@example.com", display: "Bob" }, unread: false, starred: false, inInbox: true, labelIds: ["INBOX"] })
    }
    function runner() {
      var kids = mailService.children
      for (var i = 0; i < kids.length; i++) if (kids[i].jobs !== undefined && kids[i].pluginDir !== undefined) return kids[i]
      return null
    }
    function calendarFor(email) {
      return ({ version: 1, sources: [{
        id: "caldav:" + email, kind: "caldav", name: "Home", url: "https://calendar.example/" + email + "/",
        username: email, enabled: true, readOnly: false, colorKey: "accent" }] })
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
      agent.jobs = []
      agent.startPayload = ""
      var kids = agent.children
      for (var i = 0; i < kids.length; i++) if (kids[i].running === true) kids[i].running = false
      return agent
    }
    function open(account, id, subject, text) {
      account.selectedId = id
      account.selectedMessage = summary(id, subject)
      account.selectedBody = ({ text: text, source: "" })
    }
    function named(item, name, out) {
      if (item.objectName === name) out.push(item)
      var kids = item.children || []
      for (var i = 0; i < kids.length; i++) named(kids[i], name, out)
      return out
    }

    function init() { added.clear(); dismissed.clear(); card.suggestions = [] }

    function test_a_dated_message_is_looked_at_once_when_asked() {
      var agent = seed(ada)
      var adas = mailService.accountAt(0)
      mailService.settings = ({ agentCommand: "true", suggestEvents: false })
      open(adas, "42:INBOX", "Dinner?", "Dinner on Thursday at 7pm?")
      compare(agent.startPayload, "", "off is off")

      // Turning it on looks at the message already open, once.
      mailService.settings = ({ agentCommand: "true", suggestEvents: true })
      compare(JSON.parse(agent.startPayload).messageId, "42:INBOX", "on looks at what is open")
      agent.startPayload = ""
      var kids0 = agent.children
      for (var k = 0; k < kids0.length; k++) if (kids0[k].running === true) kids0[k].running = false
      open(adas, "43:INBOX", "Hello", "Just saying hi")
      compare(agent.startPayload, "", "no date, no look")

      open(adas, "44:INBOX", "Dinner?", "Dinner on Thursday at 7pm?")
      var line = JSON.parse(agent.startPayload)
      compare(line.events, true)
      compare(line.command, "true", "a command of the owner's own runs as it is")
      compare(line.messageId, "44:INBOX")
      compare(line.accountId, ada)
      verify(line.message.indexOf("Thursday at 7pm") >= 0)

      // The look is on the list now; opening the message again asks nothing.
      agent.jobs = [{ id: "look-44", kind: "events", messageId: "44:INBOX", accountId: ada, state: "running", created: 1 }]
      agent.startPayload = ""
      var kids = agent.children
      for (var i = 0; i < kids.length; i++) if (kids[i].running === true) kids[i].running = false
      open(adas, "44:INBOX", "Dinner?", "Dinner on Thursday at 7pm?")
      compare(agent.startPayload, "", "one look per message")

      // Two looks running is the ceiling.
      agent.jobs = [{ id: "l1", kind: "events", messageId: "1:INBOX", accountId: ada, state: "running", created: 1 },
        { id: "l2", kind: "events", messageId: "2:INBOX", accountId: ada, state: "queued", created: 2 }]
      open(adas, "45:INBOX", "Lunch?", "Lunch tomorrow at noon, 12:30?")
      compare(agent.startPayload, "", "no third look while two run")
    }

    // A preset's command runs a look at its cheapest model; a look command
    // of the owner's own runs instead.
    function test_a_look_runs_at_the_cheapest_model() {
      var agent = seed(ada)
      var adas = mailService.accountAt(0)
      mailService.settings = ({ agentCommand: "claude -p --allowedTools \"Bash(himalaya:*)\"", suggestEvents: true })
      open(adas, "47:INBOX", "Coffee?", "Coffee Friday at 9am?")
      verify(JSON.parse(agent.startPayload).command.indexOf("--model claude-haiku-4-5-20251001") > 0, agent.startPayload)
      agent.startPayload = ""
      var kids = agent.children
      for (var i = 0; i < kids.length; i++) if (kids[i].running === true) kids[i].running = false
      mailService.settings = ({ agentCommand: "claude -p --allowedTools \"Bash(himalaya:*)\"", suggestEvents: true, lookCommand: "my-look" })
      open(adas, "48:INBOX", "Coffee?", "Coffee Saturday at 9am?")
      compare(JSON.parse(agent.startPayload).command, "my-look")
    }

    function test_what_was_found_is_the_open_messages_and_the_accounts() {
      var agent = seed(ada)
      var adas = mailService.accountAt(0)
      mailService.settings = ({ agentCommand: "true", suggestEvents: true })
      var start = new Date(2026, 8, 12, 19, 0).getTime()
      agent.jobs = [
        { id: "look-44", kind: "events", messageId: "44:INBOX", accountId: ada, state: "done", created: 3,
          events: [{ title: "Dinner with Bob", startMs: start, endMs: start + 7200000, location: "Luigi's" },
            { title: "Offsite", startMs: start + 86400000, endMs: start + 2 * 86400000, allDay: true }] },
        { id: "look-bob", kind: "events", messageId: "44:INBOX", accountId: bob, state: "done", created: 9,
          events: [{ title: "Bob's own", startMs: start, endMs: start + 3600000 }] }
      ]
      adas.selectedId = "44:INBOX"
      adas.selectedMessage = summary("44:INBOX", "Dinner?")
      tryVerify(function() { return mailService.eventSuggestions.length === 2 }, 1000)
      compare(mailService.eventSuggestions[0].title, "Dinner with Bob")
      compare(mailService.eventSuggestions[0].key, "look-44:0")
      compare(mailService.agentJobs["44:INBOX"], undefined, "a look draws no glyph")

      mailService.dismissSuggestion("look-44:0")
      tryVerify(function() { return mailService.eventSuggestions.length === 1 }, 1000)
      compare(mailService.eventSuggestions[0].title, "Offsite")

      adas.selectedId = "45:INBOX"
      adas.selectedMessage = summary("45:INBOX", "Other")
      tryVerify(function() { return mailService.eventSuggestions.length === 0 }, 1000, "another message, nothing found for it")

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
      mailService.settings = ({ agentCommand: "true", suggestEvents: true })
      var starter = null
      var kids = agent.children
      for (var i = 0; i < kids.length; i++) if (kids[i].stdinEnabled === true) starter = kids[i]
      verify(starter !== null)
      starter.running = true
      tryCompare(mailService, "agentStarting", true)
      open(adas, "50:INBOX", "Lunch?", "Lunch tomorrow at 12:30?")
      compare(agent.startPayload, "", "the runner is busy, so the look waits")
      starter.running = false
      tryVerify(function() { return agent.startPayload !== "" }, 1000, "and starts when it is free")
      compare(JSON.parse(agent.startPayload).messageId, "50:INBOX")
      // The body arrives again before the listing carries the look.
      starter.running = false
      agent.startPayload = ""
      adas.selectedBody = ({ text: "Lunch tomorrow at 12:30? (live)", source: "" })
      compare(agent.startPayload, "", "asked once")
    }

    // Add is refused, with a word, while the composer holds another event
    // or when there is no calendar to write to; closing the composer
    // without writing forgets the suggestion it was opened on.
    function test_add_respects_the_composer_and_the_calendars() {
      var agent = seed(ada)
      var adas = mailService.accountAt(0)
      mailService.settings = ({ agentCommand: "true", suggestEvents: true })
      var start = new Date(2026, 8, 12, 19, 0).getTime()
      agent.jobs = [{ id: "look-46", kind: "events", messageId: "46:INBOX", accountId: ada, state: "done", created: 3,
        events: [{ title: "Dinner", startMs: start, endMs: start + 3600000 }] }]
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

    function test_the_card_draws_text_and_asks_the_reader() {
      var start = new Date(2026, 8, 12, 19, 0).getTime()
      card.suggestions = [
        { key: "j:0", jobId: "j", index: 0, title: "<b>Dinner</b> <img src=\"http://127.0.0.1:1/x\">",
          startMs: start, endMs: start + 3600000, location: "Luigi's", notes: "Bring <i>wine</i>" },
        { key: "j:1", jobId: "j", index: 1, title: "Offsite", startMs: start, endMs: start + 86400000, allDay: true, location: "", notes: "" }
      ]
      tryCompare(card, "visible", true)
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
      card.suggestions = []
      tryCompare(card, "visible", false)
    }
  }
}
