import QtQuick 2.15
import QtTest 1.3
import "../.." as Omamail
import "../../account/Accounts.js" as Accounts

// A job belongs to the account that asked. Ada and Bob both hold 42:INBOX;
// with Ada's job running, Bob's row must show no job, glow for nothing, and
// a cancel from Bob's row must reach no runner — however the switch reached
// the service. The runner's processes are the test stubs, which record the
// command they were given and never run it.
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

  TestCase {
    name: "AgentOwnership"
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

    // The runner is the service's child that lists jobs; its processes are
    // its own children that carry a command.
    function runner() {
      var kids = mailService.children
      for (var i = 0; i < kids.length; i++) if (kids[i].jobs !== undefined && kids[i].pluginDir !== undefined) return kids[i]
      return null
    }
    function startedCancels() {
      var out = []
      var kids = runner().children
      for (var i = 0; i < kids.length; i++) {
        var command = kids[i].command
        if (kids[i].running === true && command && command.indexOf("cancel") >= 0) out.push(command)
      }
      return out
    }

    // The stub processes never exit on their own; between tests they are
    // put back so a cancel started by one test is not seen by the next.
    function init() {
      var agent = runner()
      if (!agent) return
      var kids = agent.children
      for (var i = 0; i < kids.length; i++) if (kids[i].running === true) kids[i].running = false
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
      agent.jobs = [
        { id: "synthetic-A-job", messageId: "42:INBOX", accountId: ada, state: "running", created: 5 },
        { id: "synthetic-A-question", messageId: "7:INBOX", accountId: ada, state: "done", question: "File it?", created: 6 }
      ]
      return agent
    }

    function test_public_manifest_resolves_local_helper_directory() {
      var saved = mailService.manifest
      mailService.manifest = {id:"omamail",name:"Omamail"}
      verify(mailService.pluginDir !== "", "Modern shell removes internal source metadata")
      verify(mailService.pluginDir.indexOf("file:") !== 0)
      verify(mailService.pluginDir.indexOf("/omamail") >= 0)
      mailService.manifest = saved
    }

    function test_ai_uses_system_configuration() {
      seed(ada)
      mailService.settings = ({})
      compare(mailService.hasAgent, true)
      verify(mailService.setAgentCommand === undefined)
    }

    function test_draft_request_uses_selected_from_owner() {
      var agent = seed(ada)
      var fields = {from: "bob@example.com", accountId: bob, draftKey: "unique-draft", to: "x@example.com", body: "Draft"}
      verify(mailService.askAgentDraft(fields, "Rewrite"))
      var payload = JSON.parse(agent.startPayload)
      compare(payload.accountId, bob)
      compare(payload.draftKey, "unique-draft")
      compare(payload.draft.from, "bob@example.com")
      verify(payload.command === undefined)
    }

    function test_bobs_row_neither_shows_nor_cancels_adas_job() {
      seed(bob)
      compare(mailService.activeAccountId, bob)
      verify(mailService.agentJobs["42:INBOX"] === undefined, "Bob's 42:INBOX has no job")
      verify(mailService.agentAttentionByMessage["7:INBOX"] !== true, "and nothing of Bob's glows")
      compare(mailService.cancelAgent("42:INBOX"), false, "a cancel from Bob's row finds no job")
      compare(startedCancels().length, 0, "and starts no runner")
      compare(mailService.agentBusy, true, "the pane still counts Ada's running job")
    }

    // The popup opened on Ada's row stays Ada's: after the window moves to
    // Bob, the ask it sends names Ada's account and message, the cancel
    // reaches Ada's job, and Bob's composer is offered none of Ada's
    // draft answers.
    function test_a_popup_opened_on_ada_asks_and_cancels_for_ada() {
      var agent = seed(ada)
      tryCompare(mailService, "hasAgent", true)
      var adas = mailService.accountAt(0)
      adas.messages = [{ id: "42:INBOX", threadId: "", subject: "Invoice", snippet: "", time: "", date: "",
        from: { email: "x@example.com", display: "X" }, unread: false, starred: false, inInbox: true, labelIds: ["INBOX"] }]
      agent.jobs = agent.jobs.concat([{ id: "synthetic-A-draft", kind: "draft", accountId: ada, draftKey: "draft-A", state: "done", created: 7, summary: "Shorter" }])
      compare(mailService.agentJobsForDraft({accountId: ada, draftKey: "draft-A"}).length, 1, "Ada's composer sees her draft answer")
      mailService.accountList = Accounts.setActive(mailService.accountList, bob)
      tryCompare(mailService, "activeAccountId", bob)
      compare(mailService.agentJobsForDraft({accountId: bob, draftKey: "draft-A"}).length, 0, "Bob's composer is offered none of it")
      compare(mailService.cancelAgent("42:INBOX", ada), true, "Ada's job is cancelled from her popup")
      var cancels = startedCancels()
      compare(cancels.length, 1)
      compare(String(cancels[0][cancels[0].length - 1]), "synthetic-A-job")
      compare(mailService.askAgent("42:INBOX", "File it", "imap:gone@example.com"), false, "a removed owner gets nothing")
    }

    function test_adas_row_shows_and_cancels_her_own() {
      seed(ada)
      compare(mailService.agentJobs["42:INBOX"].id, "synthetic-A-job")
      compare(mailService.agentAttentionByMessage["7:INBOX"], true)
      // The switch straight through the service, not the window: the tick
      // of ownership follows `current`, wherever the change came from.
      mailService.accountList = Accounts.setActive(mailService.accountList, bob)
      tryCompare(mailService, "activeAccountId", bob)
      verify(mailService.agentJobs["42:INBOX"] === undefined)
      compare(mailService.cancelAgent("42:INBOX"), false)
      compare(startedCancels().length, 0)
      mailService.accountList = Accounts.setActive(mailService.accountList, ada)
      tryCompare(mailService, "activeAccountId", ada)
      compare(mailService.cancelAgent("42:INBOX"), true, "Ada's own row cancels")
      var cancels = startedCancels()
      compare(cancels.length, 1)
      compare(String(cancels[0][cancels[0].length - 1]), "synthetic-A-job")
    }
  }
}
