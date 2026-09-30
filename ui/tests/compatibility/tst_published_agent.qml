import QtQuick
import QtTest
import Quickshell
import "../.." as Omamail
import "../../account/Accounts.js" as Accounts
import "../qml/BackendFixture.js" as BackendFixture

// Run with tests/test_agent_published_qml.py and the actual pinned executable.
// Only mail-context loading and the shell are synthetic; all job RPC reaches
// that executable, which launches the isolated fake Claude supplied by Python.
Item {
  width: 1000; height: 720
  QtObject { id: shellStore; function updateEntryInline(id, entry) {} }
  Omamail.Service { id: service; shell: shellStore; manifest: ({id:"omamail"}) }
  Omamail.App { id: app; service: service }
  TestCase {
    name: "PublishedAgentFlow"
    when: windowShown
    property var fixture
    property var rpcErrors: []
    property var requests: []
    readonly property string owner: "imap:ada@example.test"
    function forward(params, request) {
      requests = requests.concat([request])
      var xhr = new XMLHttpRequest()
      xhr.open("POST", Quickshell.env("OMAMAIL_TEST_AGENT_URL"))
      xhr.onreadystatechange = function() {
        if (xhr.readyState !== XMLHttpRequest.DONE) return
        if (xhr.status !== 200) { rpcErrors = rpcErrors.concat(["HTTP " + xhr.status]); return }
        var reply = JSON.parse(xhr.responseText)
        if (reply.error) rpcErrors = rpcErrors.concat([JSON.stringify(reply.error)])
        BackendFixture.respond(service, request, reply.result, reply.error)
      }
      xhr.send(JSON.stringify(request))
      return undefined
    }
    function initTestCase() {
      verify(Quickshell.env("OMAMAIL_TEST_AGENT_URL") !== "", "Use the published-binary test wrapper")
      fixture = BackendFixture.install(service)
      var answers = {}
      var methods = ["agent.jobStart", "agent.jobsList", "agent.jobShow", "agent.jobsProjection"]
      for (var i = 0; i < methods.length; i++) answers[methods[i]] = forward
      answers["agent.context"] = function(params) {
        return {payload:{accountId:owner,account:"ada@example.test",messageId:"1:INBOX",
          subject:"Thursday",message:"Can we meet Thursday at 10?",prompt:params.prompt}}
      }
      fixture.answers = answers
      BackendFixture.markReady(service, 5)
      var list = Accounts.add(Accounts.emptyList(), {email:"ada@example.test",provider:"imap",
        imap:{imapHost:"imap.example.test",imapPort:993,smtpHost:"smtp.example.test",smtpPort:465,
          username:"ada@example.test",aliases:[],insecure:false},label:"",signature:""})
      service.accountList = Accounts.setActive(list, owner)
      service.accountsLoaded = true
      service.refreshCurrent()
      tryCompare(service, "activeAccountId", owner)
      var account = service.accountAt(0)
      account.auth.toolsChecked = true; account.auth.missingTools = []
      account.auth.passwordChecked = true; account.auth.password = "synthetic-password"
      tryCompare(account, "ready", true)
      account.profile = {email:"ada@example.test"}
      account.messages = [{id:"1:INBOX",subject:"Thursday",from:{email:"bob@example.test"},
        to:[{email:"ada@example.test"}],cc:[],unread:false,labelIds:["INBOX"]}]
      app.opened = true
    }
    function awaitAnswer(panel, previous) {
      tryVerify(function() { return panel.job && panel.job.id !== previous && panel.job.state === "done" }, 15000)
      tryVerify(function() { return panel.output.indexOf("Synthetic Claude reply") >= 0 }, 5000)
      verify(panel.canContinue)
      compare(rpcErrors, [])
      return panel.job.id
    }
    function test_reader_and_composer_keep_claude_with_the_published_pin() {
      tryCompare(service, "agentAvailable", true)
      verify(!service.backendCanChooseAgent)
      verify(!service.backendCanAgentProposals)
      app.cursorId = "1:INBOX"
      verify(app.runShortcut("askAgent", "Alt+G"), "Published-pin user can open AI from the mailbox")
      verify(app.agentPrompt.opened)
      verify(app.agentPrompt.submit("What's the gist?", false))
      var first = awaitAnswer(app.agentPrompt, "")
      verify(app.agentPrompt.submit("Explain a little more", false))
      awaitAnswer(app.agentPrompt, first)
      app.agentPrompt.close()
      app.startCompose("new")
      var to = findChild(app, "compose-to-field")
      to.text = "bob@example.test"
      var editor = findChild(app, "compose-body-editor")
      editor.text = "Thursday works for me."
      verify(app.runShortcut("askAgent", "Alt+G"))
      verify(app.composeAgent.opened)
      verify(app.composeAgent.submit("Make this more casual", false))
      first = awaitAnswer(app.composeAgent, "")
      verify(app.composeAgent.submit("Make it shorter", false))
      awaitAnswer(app.composeAgent, first)
      var replace = findChild(app.composeAgent, "agent-replace")
      verify(replace.visible)
      mouseClick(replace)
      compare(editor.text, "Synthetic Claude reply")
      compare(to.text, "bob@example.test")
      var starts = requests.filter(function(r) { return r.method === "agent.jobStart" })
      compare(starts.length, 4)
      for (var i = 0; i < starts.length; i++) {
        compare(starts[i].params.provider, undefined)
        compare(starts[i].params.model, undefined)
        var payload = starts[i].params.payload
        if (typeof payload === "string") payload = JSON.parse(payload)
        compare(payload.envelope, undefined)
        compare(payload.draftUpdate, undefined)
        compare(payload.mailUpdate, undefined)
      }
      compare(fixture.requests.filter(function(r) {
        return r.method === "agent.providerStatus" || r.method === "outbox.enqueue" || r.method === "message.compose"
      }).length, 0, "No API-6 availability call and no send")
    }
  }
}
