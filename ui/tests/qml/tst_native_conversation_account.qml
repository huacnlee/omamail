import QtQuick
import QtTest
import "../../account" as Account
import "NativeDomainFixture.js" as Native

Item {
  QtObject {
    id: backend
    property bool ready: false
    property var requests: []
    function call(method, params, callback) {
      if (method !== "account.conversation") return
      var copy = JSON.parse(JSON.stringify(params))
      if (params.operation === "project") callback(Native.conversation(copy), null)
      else requests.push({params:copy,callback:callback})
    }
    function complete(index) {
      var request = requests[index]
      request.callback(Native.conversation(request.params), null)
    }
  }
  Account.MailAccount {
    id: account
    pluginDir: "/synthetic/plugin"
    backend: backend
  }
  TestCase {
    name: "NativeConversationAccount"
    function init() {
      backend.ready = false
      account.conversationSerial++
      account.conversationBusy = false
      account.conversationJobs = []
      account.accountId = "first@example.org"
      account.selectedId = "one"
      account.selectedThread = {id:"thread",memberIds:["one","two"],count:2}
      account.memberSummaries = {one:{id:"one",unread:true,labelIds:["INBOX","UNREAD"]}}
      account.conversationOrganisation = {marker:"current"}
      backend.requests = []
      backend.ready = true
    }
    function cleanup() { backend.ready = false }
    function test_delayed_merge_cannot_restore_optimistically_cleared_unread() {
      account.mergeMembers({two:{id:"two",unread:true}})
      compare(backend.requests.length, 1)
      account.memberSummaries = {one:{id:"one",unread:false,labelIds:["INBOX"]}}
      backend.complete(0)
      compare(account.memberSummaries.one.unread, false)
      compare(account.memberSummaries.one.labelIds.length, 1)
      verify(account.memberSummaries.two === undefined)
      compare(account.conversationOrganisation.summaries.one.unread, false)
      verify(account.conversationOrganisation.summaries.two === undefined)
    }
    function test_stale_select_and_seed_rebase_after_snapshot_changes() {
      var completed = 0
      account.queueConversation("select", {id:"one"}, null, function() { completed++ })
      account.memberSummaries = {one:{id:"one",unread:false,labelIds:["INBOX"]}}
      backend.complete(0)
      compare(completed, 0)
      compare(backend.requests.length, 2)
      compare(backend.requests[1].params.summaries.one.unread, false)
      backend.complete(1)
      compare(completed, 1)
      account.queueConversation("seed", null, null, function() { completed++ })
      account.memberSummaries = {one:{id:"one",unread:false,labelIds:["INBOX"],starred:true}}
      backend.complete(2)
      compare(completed, 1)
      compare(backend.requests.length, 4)
      compare(backend.requests[3].params.summaries.one.starred, true)
      backend.complete(3)
      compare(completed, 2)
      compare(account.memberSummaries.one.starred, true)
    }
    function test_old_selection_and_account_responses_cannot_replace_current_thread() {
      var completed = 0
      account.queueConversation("select", {id:"one"}, null, function() { completed++ })
      account.selectedId = "new"
      account.selectedThread = {id:"new-thread",memberIds:["new","other"],count:2}
      backend.complete(0)
      compare(account.selectedThread.id, "new-thread")
      compare(completed, 0)
      account.queueConversation("seed", null, null, function() { completed++ })
      account.accountId = "second@example.org"
      account.memberSummaries = {new:{id:"new",subject:"Second account"}}
      backend.complete(1)
      compare(account.memberSummaries.new.subject, "Second account")
      verify(account.memberSummaries.one === undefined)
      compare(completed, 0)
    }
  }
}
