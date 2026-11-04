import QtQuick
import QtTest
import "../../providers" as Providers

// What `MailAccount` asks of a Microsoft 365 mailbox and what comes back: each call
// is one `m365.*` request that names the account and nothing else, the answer is in
// the shape the account reads, and a request is cancelled, dropped or refused as the
// session around it changes. The backend is a recorder answered by hand.
Item {
  id: root
  width: 200
  height: 200

  readonly property string account: "m365:ada@corp.example.test"

  QtObject {
    id: authStub
    property string accountId: root.account
    property bool loggedIn: true
    property bool restoring: false
    property string signInStage: ""
    property var checked: null
    property int signedOutNotes: 0
    signal loggedOut()
    function noteSignedOut() { signedOutNotes++ }
  }

  QtObject {
    id: backendStub
    property bool ready: true
    property int apiVersion: 8
    property var calls: []
    function call(method, params, callback) {
      calls = calls.concat([{ method: method, params: JSON.parse(JSON.stringify(params)), callback: callback, answered: false }])
    }
  }

  Component {
    id: clientFactory
    Providers.M365Client { auth: authStub; backend: backendStub; email: "ada@corp.example.test" }
  }

  TestCase {
    name: "M365Client"
    when: windowShown

    property var client: null
    property var got: null

    function init() {
      backendStub.calls = []
      backendStub.ready = true
      backendStub.apiVersion = 8
      authStub.accountId = root.account
      authStub.loggedIn = true
      authStub.restoring = false
      authStub.signInStage = ""
      authStub.checked = null
      authStub.signedOutNotes = 0
      client = createTemporaryObject(clientFactory, root)
      got = null
    }

    function calls(method) { return backendStub.calls.filter(function(call) { return call.method === method }) }
    function last() { return backendStub.calls[backendStub.calls.length - 1] }

    function answer(call, result, code) {
      verify(!call.answered, "answered twice")
      call.answered = true
      call.callback(result === undefined ? null : result, code === undefined ? null : { code: -32000, message: code })
    }

    function take(result, error, failed) { got = { result: result, error: error, failed: failed } }

    function test_a_listing_asks_for_a_page_and_answers_in_the_shape_the_account_reads() {
      client.listMessages("role:inbox", 25, "next-1", take)
      compare(last().method, "m365.list")
      compare(Object.keys(last().params).sort(), ["accountId", "limit", "pageToken", "query", "requestToken"])
      compare(last().params.accountId, root.account)
      compare(last().params.query, "role:inbox")
      compare(last().params.pageToken, "next-1", "a token goes back as it came")
      answer(last(), { page: { ids: ["a", "b"], nextPageToken: "more", estimate: 40 } })
      compare(got.result, { ids: ["a", "b"], threadIds: [], nextPageToken: "more", estimate: 40 })
      compare(got.error, "")
      compare(client.busy, false)
      for (var limit of [[500, 100], [0, 25], ["x", 25], [3, 3]]) {
        client.listMessages("role:inbox", limit[0], "", take)
        compare(last().params.limit, limit[1], "limit " + limit[0])
      }
    }

    function test_a_listing_with_nothing_usable_is_an_error_and_a_warning_travels_beside_the_rows() {
      client.listMessages("role:inbox", 25, "", take)
      answer(last(), { page: null })
      compare(got.result, null)
      compare(got.error, "Microsoft 365 could not complete this request", "not an empty mailbox")
      client.listMessages("role:inbox", 25, "", take)
      answer(last(), { page: { ids: ["a"], nextPageToken: "", estimate: 1 }, warning: "mail_list_incomplete" })
      compare(got.result.ids, ["a"])
      compare(got.error, "The mailbox search could not be completed")
      client.listMessages("text:\"", 25, "", take)
      answer(last(), null, "invalid_params")
      compare(got.error, "That search has nothing Microsoft 365 can look for")
    }

    function test_rows_are_read_by_id_and_a_partial_answer_is_said_to_be() {
      client.getMessages(["a", "b"], false, take)
      compare(Object.keys(last().params).sort(), ["accountId", "full", "ids", "requestToken"])
      compare(last().params.ids, ["a", "b"])
      compare(last().params.full, false)
      answer(last(), { messages: [{ id: "a" }, { id: "b" }] })
      compare(got.result.length, 2)
      compare(got.error, "")
      client.getMessages(["a"], true, take)
      compare(last().params.full, true)
      answer(last(), { messages: [{ id: "a" }], continuation: "more" })
      compare(got.error, "Some messages could not be loaded")
      var before = backendStub.calls.length
      client.getMessages([], false, take)
      tryCompare(client, "busy", false)
      wait(20)
      compare(backendStub.calls.length, before, "nothing to read, nothing asked")
      compare(got.result, [])
    }

    function test_an_attachment_is_asked_for_by_message_and_part() {
      client.getAttachment("m1", "p1", take)
      compare(last().method, "m365.attachment")
      compare(last().params, { accountId: root.account, messageId: "m1", attachmentId: "p1" })
      answer(last(), { data: "QUJD" })
      compare(got.result, "QUJD")
      client.getAttachment("m1", "p1", take)
      answer(last(), null, "m365_attachment_not_found")
      compare(got.result, "")
      compare(got.error, "That attachment is no longer in the mailbox")
    }

    function test_changes_ask_for_the_labels_the_account_means_and_name_what_failed() {
      client.modifyMessage("one", ["STARRED"], [], take)
      compare(last().method, "m365.modify")
      compare(last().params, { accountId: root.account, ids: ["one"], addLabelIds: ["STARRED"], removeLabelIds: [] })
      answer(last(), { succeededIds: ["one"], failedIds: [], error: null })
      compare(got.error, "")
      client.batchModify(["a", "b"], [], ["INBOX"], take)
      compare(last().params.ids, ["a", "b"])
      compare(last().params.removeLabelIds, ["INBOX"], "archive is taking the Inbox label off")
      answer(last(), { succeededIds: ["a"], failedIds: ["b"], error: "m365_throttled" })
      compare(got.error, "Microsoft asked Omamail to slow down. Try again in a moment")
      compare(got.failed, ["b"], "the list restores exactly the rows that failed")
      client.trashMessage("c", take)
      compare(last().method, "m365.trash")
      compare(last().params, { accountId: root.account, ids: ["c"] })
      answer(last(), { succeededIds: [], failedIds: ["c"], error: null })
      compare(got.error, "Microsoft 365 did not apply this change to every message")
      client.untrashMessage(["c", "d"], take)
      compare(last().method, "m365.untrash")
      compare(last().params, { accountId: root.account, ids: ["c", "d"] })
      answer(last(), { succeededIds: [], failedIds: [], error: "m365_message_not_found" })
      compare(got.failed, undefined, "a failure naming no ids is the whole request's")
      compare(got.error, "That message is no longer in the mailbox")
    }

    function test_a_message_is_sent_as_the_raw_mime_and_nothing_else() {
      client.sendMessage({ raw: "UkFX", to: "x@example.test", extra: 1 }, take)
      compare(last().method, "m365.send")
      compare(last().params, { accountId: root.account, raw: "UkFX" })
    }

    function test_a_draft_is_saved_and_deleted_on_the_mailbox() {
      client.saveDraft({ raw: "UkFX", draftId: "old", to: "x@example.test" }, take)
      compare(last().method, "m365.saveDraft")
      compare(last().params, { accountId: root.account, raw: "UkFX", draftId: "old" })
      answer(last(), { saved: true, warning: "", id: "new" })
      compare(got.result.saved, true)
      compare(got.error, "")
      client.saveDraft({ raw: "UkFX" }, take)
      compare(last().params.draftId, "", "a draft that replaces nothing names none")
      client.deleteDraft("old", take)
      compare(last().method, "m365.deleteDraft")
      compare(last().params, { accountId: root.account, id: "old" })
      answer(last(), null, "m365_not_a_draft")
      compare(got.error, "That message is not a draft, so it was left in place")
    }

    function test_a_request_made_while_the_sign_in_is_checked_waits_for_the_check() {
      authStub.loggedIn = false
      authStub.restoring = true
      client.listMessages("role:inbox", 25, "", take)
      compare(backendStub.calls.length, 0, "nothing is asked of a mailbox being proved")
      compare(got, null, "and nothing answered yet")
      authStub.restoring = false
      authStub.loggedIn = true
      tryVerify(function() { return calls("m365.list").length === 1 }, 1000, "sent once the check passed")
      answer(last(), { page: { ids: ["a"], nextPageToken: "", estimate: 1 } })
      compare(got.result.ids, ["a"])
      // A check that ends without a mailbox answers what waited for it as signed out.
      got = null
      authStub.loggedIn = false
      authStub.signInStage = "checking"
      client.trashMessage("a", take)
      authStub.signInStage = ""
      tryVerify(function() { return got !== null }, 1000)
      compare(got.error, "Sign in to Microsoft 365 again")
      compare(calls("m365.trash").length, 0)
      // One that waited for another mailbox's check is never sent for the next one.
      got = null
      authStub.restoring = true
      client.trashMessage("b", take)
      authStub.accountId = "m365:bob@corp.example.test"
      authStub.restoring = false
      authStub.loggedIn = true
      tryVerify(function() { return got !== null }, 1000)
      compare(got.error, "Sign in to Microsoft 365 again")
      compare(calls("m365.trash").length, 0)
    }

    function test_what_needs_no_request_still_answers() {
      client.getProfile(take)
      tryVerify(function() { return got !== null && got.result.email === "ada@corp.example.test" })
      compare(got.result.messagesTotal, 0)
      client.getSendAs(take)
      tryVerify(function() { return got.result.length === 1 && got.result[0].email === "ada@corp.example.test" })
      client.getLabels(take)
      compare(got.result, [])
      client.getSummaries(["a"], take)
      tryVerify(function() { return got.result.length === 0 && got.error === "" })
      compare(backendStub.calls.length, 0, "none of them is a request")
    }

    // ---------------------------------------------------- cancelling and dropping

    function test_each_request_of_a_search_is_cancelled_by_its_own_token_and_a_finished_one_is_not() {
      var handle = client.listMessages("text:x", 25, "", take)
      answer(last(), { page: { ids: ["a"], nextPageToken: "", estimate: 1 } })
      client.getMessages(["a"], false, take, handle)
      var read = last()
      client.getMessages(["b"], false, take, handle)
      var second = last()
      verify(read.params.requestToken !== second.params.requestToken)
      answer(second, { messages: [] })
      client.abortRequest(handle)
      compare(calls("m365.cancel").length, 1, "the finished requests are not cancelled")
      compare(calls("m365.cancel")[0].params, { accountId: root.account, requestToken: read.params.requestToken })
      var before = got
      answer(read, { messages: [{ id: "a" }] })
      compare(got, before, "the answer of a cancelled request is dropped")
      client.abortRequest(handle)
      compare(calls("m365.cancel").length, 1, "once")
    }

    function test_a_reply_after_the_account_or_the_session_changed_is_dropped() {
      client.listMessages("role:inbox", 25, "", take)
      authStub.accountId = "m365:bob@corp.example.test"
      answer(last(), { page: { ids: ["a"], nextPageToken: "", estimate: 1 } })
      compare(got, null)
      authStub.accountId = root.account
      client.listMessages("role:inbox", 25, "", take)
      var request = last()
      authStub.loggedOut()
      answer(request, { page: { ids: ["a"], nextPageToken: "", estimate: 1 } })
      compare(got, null, "nothing of a signed-out session arrives")
      compare(calls("m365.invalidate")[0].params, { accountId: root.account }, "and the backend forgets the mailbox")
    }

    // ------------------------------------------------------------- the session

    function test_nothing_is_asked_without_a_session_or_of_a_backend_too_old() {
      authStub.loggedIn = false
      client.listMessages("role:inbox", 25, "", take)
      compare(got.error, "Sign in to Microsoft 365 again")
      authStub.loggedIn = true
      backendStub.apiVersion = 7
      client.trashMessage("a", take)
      compare(got.error, "Update the mail backend to use this mailbox")
      backendStub.apiVersion = 8
      backendStub.ready = false
      client.trashMessage("a", take)
      compare(got.error, "Mail backend is unavailable")
      compare(backendStub.calls.length, 0)
    }

    function test_a_request_that_finds_the_sign_in_gone_tells_the_auth_object_and_the_caller() {
      client.listMessages("role:inbox", 25, "", take)
      answer(last(), null, "m365_signed_out")
      compare(authStub.signedOutNotes, 1)
      compare(got.error, "Sign in to Microsoft 365 again")
      client.batchModify(["a"], [], [], take)
      answer(last(), { succeededIds: [], failedIds: ["a"], error: "m365_signed_out" })
      compare(authStub.signedOutNotes, 2, "also when it is a change's own answer")
      client.listMessages("role:inbox", 25, "", take)
      answer(last(), null, "m365_network_failed")
      compare(authStub.signedOutNotes, 2, "a network that is down does not end a session")
    }

    function test_what_the_check_found_draws_the_rail_and_the_buttons() {
      compare(client.refusals, null)
      compare(client.absentMailboxes, null, "every row until a check has answered")
      authStub.checked = { ok: true, roles: { archive: null, junk: { total: 0, unread: 0 }, trash: null }, refusals: { star: "" } }
      compare(client.absentMailboxes, ["archive", "trash"])
      compare(Object.keys(client.refusals), ["star"])
      authStub.checked = null
      compare(client.absentMailboxes, null, "forgotten with the session")
      compare(client.refusals, null)
    }
  }
}
