import QtQuick 2.15
import QtTest 1.3
import "../.." as Omamail
import "../../account/Unified.js" as Unified
import "transports.js" as Transports

// Reading and changing an Exchange mailbox: what each action sends, what it does
// with a partial failure, how the Flagged count follows, and how a row in a merged
// list finds its own mailbox. A request names the account and what was asked, and
// nothing that could authenticate or redirect it.
Item {
  width: 900
  height: 600

  QtObject {
    id: fakeShell
    function hide(_id) {}
  }

  Omamail.Service {
    id: mailService
    shell: fakeShell
    manifest: ({ id: "omamail", __sourceDir: "/tmp/omamail-test" })
  }

  Omamail.App {
    id: app
    service: mailService
    shell: fakeShell
  }

  // Another mailbox, signed in, for a client to find in place of its own.
  QtObject {
    id: otherMailbox
    property string accountId: "exchange:ada@corp.example.test"
    property bool loggedIn: true
  }

  ExchangeCase {
    id: t
    name: "ExchangeMailbox"
    service: mailService
    app: app
    // The sequence of the last `mail.updated` a test sent; each must be newer.
    property int polls: 1

    function row(id, starred) {
      return { id: id, threadId: "", from: { email: "x@corp.example.test", display: "X" }, subject: id,
        snippet: "", time: "", date: "", unread: true, starred: starred === true, inInbox: true,
        labelIds: starred === true ? ["INBOX", "UNREAD", "STARRED"] : ["INBOX", "UNREAD"] }
    }

    function ready(rows) {
      keyring.entries[accountId] = secret
      var account = seed()
      tryVerify(function() { return account.ready }, 2000)
      account.messages = rows || []
      account.listLoaded = true
      return account
    }

    // The visible numbers drawn on the window's own rail, as the rows they sit on
    // name them.
    function badges() {
      var out = []
      function walk(item) {
        if (item.objectName === "mailbox-entry-badge" && item.visible) out.push(item.parent.label + " " + item.text)
        for (var i = 0; i < (item.children || []).length; i++) walk(item.children[i])
      }
      walk(app)
      return out
    }

    function test_a_request_names_the_account_and_what_was_asked_and_nothing_else() {
      var account = ready()
      account.api.listMessages("role:inbox", 500, "page-2", function() {})
      var list = sent("exchange.list").filter(function(r) { return r.params.pageToken === "page-2" })[0]
      compare(list.params.limit, 100, "a page is at most what the backend takes")
      compare(list.params.query, "role:inbox")
      compare(list.params.accountId, accountId)
      verify(list.params.requestToken !== "", "a long request can be cancelled")

      var ids = []
      for (var i = 0; i < 250; i++) ids.push("id" + i)
      var got = null
      account.api.getMessages(ids, false, function(messages, error) { got = error })
      tryVerify(function() { return got !== null }, 2000)
      var reads = sent("exchange.messages").filter(function(r) { return r.params.ids[0] === "id0" || r.params.ids[0] === "id100" || r.params.ids[0] === "id200" })
      compare(reads.map(function(r) { return r.params.ids.length }), [100, 100, 50], "ids go in batches the backend takes")

      account.api.getAttachment("mid", "aid", function() {})
      account.api.sendMessage({ raw: "cmF3" }, function() {})
      tryVerify(function() { return sent("exchange.send").length === 1 }, 2000)
      compare(sent("exchange.attachment")[0].params, { messageId: "mid", attachmentId: "aid", accountId: accountId })
      compare(sent("exchange.send")[0].params, { raw: "cmF3", accountId: accountId })
      for (var j = 0; j < server.calls.length; j++) {
        var keys = Object.keys(server.calls[j].params)
        for (var k = 0; k < keys.length; k++)
          verify(["settings", "secret", "url", "ewsUrl", "credential", "password", "token"].indexOf(keys[k]) < 0,
            server.calls[j].method + " carried " + keys[k])
      }
      // The identity and the profile are answered without a request.
      var identities = null
      account.api.getSendAs(function(rows) { identities = rows })
      tryVerify(function() { return identities !== null }, 1000)
      compare(identities.map(function(r) { return r.email }), ["jane@corp.example.test"])
    }

    function test_flagging_reading_and_trashing_reach_the_server_with_the_ids_the_list_holds() {
      var account = ready([row("one")])
      verify(account.act("one", "star", false, false))
      tryVerify(function() { return sent("exchange.modify").length === 1 }, 2000)
      compare(sent("exchange.modify")[0].params, { accountId: accountId, ids: ["one"],
        addLabelIds: ["STARRED"], removeLabelIds: [] })
      tryCompare(account, "pendingAction", "")
      // The stand-in's listing is empty, so the list is put back for each.
      account.messages = [row("two")]
      verify(account.act("two", "markRead", false, false))
      tryVerify(function() { return sent("exchange.modify").length === 2 }, 2000)
      compare(sent("exchange.modify")[1].params.removeLabelIds, ["UNREAD"])
      tryCompare(account, "pendingAction", "")
      account.messages = [row("three"), row("four")]
      verify(account.act("three", "trash", false, false))
      tryVerify(function() { return sent("exchange.trash").length === 1 }, 2000)
      compare(sent("exchange.trash")[0].params, { accountId: accountId, ids: ["three"] })
    }

    // A selection is trashed one row at a time by the window; the rows go to the
    // server as one batch, and each row hears whether it was trashed.
    function test_a_selection_is_trashed_in_one_request_and_each_row_hears_its_own_answer() {
      var account = ready([row("one"), row("two"), row("three")])
      server.script["exchange.trash"] = function(request) {
        return { result: { succeededIds: ["one", "three"], failedIds: ["two"], error: "exchange_message_not_found" } }
      }
      verify(account.actMany(["one", "two", "three"], "trash"))
      tryVerify(function() { return sent("exchange.trash").length === 1 }, 2000)
      compare(sent("exchange.trash")[0].params.ids, ["one", "two", "three"])
      tryCompare(account, "pendingAction", "")

      var heard = ({})
      ;["four", "five"].forEach(function(id) {
        account.api.trashMessage(id, function(result, error, ids) { heard[id] = [error, ids] })
      })
      server.script["exchange.trash"] = function(request) {
        return { result: { succeededIds: ["four"], failedIds: ["five"], error: "exchange_message_not_found" } }
      }
      tryVerify(function() { return Object.keys(heard).length === 2 }, 2000)
      compare(sent("exchange.trash").length, 2, "one request for the two rows")
      compare(sent("exchange.trash")[1].params.ids, ["four", "five"])
      compare(heard.four, ["", undefined], "the row the server trashed is done")
      verify(heard.five[0] !== "", "the row it did not trash is told why")
      compare(heard.five[1], ["five"], "and names only itself")
    }

    // A change names every id as done or not: what was not done is put back, and
    // the others are not.
    function test_ids_the_server_did_not_change_are_put_back_and_said() {
      var account = ready([row("one"), row("two")])
      server.script["exchange.modify"] = function(request) {
        return { result: { succeededIds: ["one"], failedIds: ["two"], error: "exchange_stale_item" } }
      }
      var failed = null
      account.api.batchModify(["one", "two"], ["STARRED"], [], function(result, error, ids) { failed = [error, ids] })
      tryVerify(function() { return failed !== null }, 2000)
      compare(failed, ["The message changed on the server while it was being updated. Try again", ["two"]])
      // A batch that ran out of time names what it did apply: only the rest goes back.
      server.script["exchange.modify"] = function(request) {
        return { result: { succeededIds: ["one"], failedIds: ["two"], error: "exchange_timeout" } }
      }
      var late = null
      account.api.batchModify(["one", "two"], [], ["UNREAD"], function(result, error, ids) { late = [error, ids] })
      tryVerify(function() { return late !== null }, 2000)
      compare(late, ["The mail server took too long to answer", ["two"]])
      server.script["exchange.trash"] = function() { return { result: { succeededIds: [], failedIds: [], error: "exchange_folder_unavailable" } } }
      var whole = null
      account.api.trashMessage("one", function(result, error, ids) { whole = [error, ids] })
      tryVerify(function() { return whole !== null }, 2000)
      compare(whole, ["A folder this needs was not found on the server", undefined], "a failure naming no ids is the whole request's")
    }

    // The backend begins a write only in the first seconds of a call, so a large
    // change goes a hundred ids to a request, one after another, and the ids
    // every request did not change are put back together.
    function test_a_large_change_goes_a_hundred_ids_to_a_request_one_after_another() {
      var account = ready()
      var ids = []
      for (var i = 0; i < 250; i++) ids.push("id" + i)
      server.script["exchange.modify"] = function(request) {
        var asked = request.params.ids
        // The second ran out of time after half of its ids.
        if (asked[0] !== "id100") return undefined
        return { result: { succeededIds: asked.slice(0, 50), failedIds: asked.slice(50), error: "exchange_timeout" } }
      }
      var got = null
      account.api.batchModify(ids, ["STARRED"], [], function(result, error, failed) { got = [result, error, failed] })
      compare(sent("exchange.modify").length, 1, "one request at a time")
      tryVerify(function() { return got !== null }, 2000)
      compare(sent("exchange.modify").map(function(r) { return r.params.ids.length }), [100, 100, 50])
      compare(sent("exchange.modify").map(function(r) { return r.params.ids[0] }), ["id0", "id100", "id200"])
      compare(sent("exchange.modify")[2].params.addLabelIds, ["STARRED"])
      compare(got[1], "The mail server took too long to answer")
      compare(got[2], ids.slice(150, 200))
      compare(got[0].succeededIds, ids.slice(0, 150).concat(ids.slice(200)))

      // A request refused as a whole ends the batch: it and every id after it go back.
      server.script["exchange.trash"] = function(request) {
        return request.params.ids[0] === "id100" ? { error: "exchange_timeout" } : undefined
      }
      got = null
      account.api.trashMessage(ids, function(result, error, failed) { got = [result, error, failed] })
      tryVerify(function() { return got !== null }, 2000)
      compare(sent("exchange.trash").map(function(r) { return r.params.ids.length }), [100, 100])
      compare(got[1], "The mail server took too long to answer")
      compare(got[2], ids.slice(100))
      compare(got[0].succeededIds, ids.slice(0, 100))
    }

    // A server that answers every id of a request with one failure (one that
    // hangs answers each "took too long") ends the batch: the next hundred would
    // wait as long for the same. Messages that are gone are no such reason.
    function test_a_request_in_which_every_id_failed_ends_the_batch_unless_they_are_gone() {
      var account = ready()
      var ids = []
      for (var i = 0; i < 1000; i++) ids.push("id" + i)
      server.script["exchange.modify"] = function(request) {
        return { result: { succeededIds: [], failedIds: request.params.ids, error: "exchange_timeout" } }
      }
      var got = null
      account.api.batchModify(ids, ["STARRED"], [], function(result, error, failed) { got = [result, error, failed] })
      tryVerify(function() { return got !== null }, 2000)
      compare(sent("exchange.modify").length, 1, "one request, not ten")
      compare(got[1], "The mail server took too long to answer")
      compare(got[2], ids, "every id goes back")
      compare(got[0].succeededIds, [])

      server.script["exchange.modify"] = function(request) {
        return { result: { succeededIds: [], failedIds: request.params.ids, error: "exchange_message_not_found" } }
      }
      got = null
      account.api.batchModify(ids.slice(0, 250), [], ["UNREAD"], function(result, error, failed) { got = [result, error, failed] })
      tryVerify(function() { return got !== null }, 2000)
      compare(sent("exchange.modify").length, 4, "the rest are still asked about")
      compare(got[2], ids.slice(0, 250))
    }

    // Rows asked in one moment go as one batch. A row let go of before it goes
    // is left out, and none at all sends nothing; an id asked twice is sent once
    // and both askers hear; a caller that throws does not silence the others.
    function test_a_gathered_batch_sends_each_id_once_and_answers_every_caller() {
      var account = ready()
      var heard = []
      var dropped = account.api.trashMessage("one", function() { heard.push("one") })
      account.api.abortRequest(dropped)
      wait(100)
      compare(sent("exchange.trash").length, 0, "nothing is left to send")
      compare(heard, [])

      account.api.abortRequest(account.api.trashMessage("one", function() { heard.push("one") }))
      account.api.trashMessage("two", function() { heard.push("two"); throw new Error("a caller's own fault") })
      account.api.trashMessage("two", function(result, error) { heard.push("two again " + error) })
      account.api.trashMessage(["three", "two"], function(result, error) { heard.push("three " + error) })
      tryVerify(function() { return heard.length === 3 }, 2000)
      compare(sent("exchange.trash").length, 1)
      compare(sent("exchange.trash")[0].params.ids, ["two", "three"])
      compare(heard, ["two", "two again ", "three "])
    }

    // An ask is for the mailbox it was made of. One made before the client let
    // go of what it knew (a sign-out, another server), or before another mailbox
    // took its place, is answered as such and not sent.
    function test_an_ask_gathered_before_the_mailbox_changed_is_not_sent() {
      var account = ready()
      var heard = []
      account.api.trashMessage("one", function(result, error) { heard.push(error) })
      account.api.forget()
      tryVerify(function() { return heard.length === 1 }, 2000)
      compare(heard[0], "Account changed")

      var own = account.api.auth
      account.api.trashMessage("two", function(result, error) { heard.push(error) })
      account.api.auth = otherMailbox
      tryVerify(function() { return heard.length === 2 }, 2000)
      account.api.auth = own
      compare(heard[1], "Account changed")
      wait(50)
      compare(sent("exchange.trash").length, 0, "nothing was sent, to either mailbox")
    }

    function test_a_search_the_backend_cannot_send_is_told_as_an_empty_one() {
      var account = ready()
      server.script["exchange.list"] = function(request) {
        return request.params.query.indexOf("text:") === 0 ? { error: "Invalid params" } : undefined
      }
      var said = []
      account.api.listMessages("text:\"\\", 25, "", function(page, error) { said.push(error) })
      account.api.listMessages("role:inbox", 25, "", function(page, error) { said.push(error) })
      tryVerify(function() { return said.length === 2 }, 2000)
      compare(said[0], "That search has nothing the server can look for")
      compare(said[1], "", "another request is no search")
    }

    // The Flagged count's requests, oldest first.
    function flaggedAsks() {
      return sent("exchange.list").filter(function(r) { return r.params.query === "role:inbox flagged" })
    }

    // Rust polls an Exchange mailbox on its own timer and says so with
    // `mail.updated`, window open or not.
    function native() {
      mailService.backend.protocolInfo = { apiVersion: 8, protocol: 1, version: "0.0.0",
        methods: ["mail.watch", "mail.unwatch", "mail.check"] }
      fixture.answers["mail.watch"] = function(params) {
        return { accountId: params.accountId, sequence: 1, estimate: 0, messages: [], error: "synthetic" }
      }
      fixture.answers["mail.check"] = {}
    }

    function poll() {
      t.polls = t.polls + 1
      mailService.backend.notification("mail.updated", { accountId: accountId, sequence: t.polls, estimate: 0,
        messages: [], error: "", fingerprint: "poll" + t.polls })
    }

    // Flagged count reads wait here, to be answered in whatever order a test says.
    function hold(account) {
      var backend = account.api.backend
      var through = backend.call
      var held = []
      backend.call = function(method, params, callback) {
        if (method !== "exchange.list" || params.query !== "role:inbox flagged") return through(method, params, callback)
        var request = { method: method, params: params, callback: callback, answered: false }
        server.calls.push(request)
        held.push(request)
        return server.calls.length
      }
      return held
    }

    function answer(request, estimate) {
      Transports.reply(request, { page: { ids: [], threadIds: [], nextPageToken: "", estimate: estimate },
        rows: [], warning: null }, "")
    }

    // Only Exchange shows a count, and only beside Flagged; the account asks the
    // server, so the guess is never ahead of what it says.
    function test_the_flagged_row_counts_what_the_server_says_is_flagged() {
      server.flagged = 7
      var account = ready()
      mailService.windowOpen = true
      tryCompare(account, "starredCount", 7, 2000)
      compare(app.starredCount, 7, "the window hands it to the rail")
      tryVerify(function() { return badges().length === 1 }, 1000)
      compare(badges(), ["Flagged 7"], "on the Flagged row and no other")
      compare(flaggedAsks()[0].params.limit, 1, "a page of one row: only its estimate is wanted")

      // An action reads it again once it is done.
      wait(150)
      account.messages = [row("one")]
      server.flagged = 8
      verify(account.act("one", "star", false, false))
      tryCompare(account, "starredCount", 8, 2000)

      // A read that fails leaves the last number.
      server.script["exchange.list"] = function() { return { error: "exchange_network_failed" } }
      server.flagged = 0
      account.refreshCounts()
      wait(100)
      compare(account.starredCount, 8)
      server.script = ({})
      account.refreshCounts()
      tryCompare(account, "starredCount", 0, 2000)
      compare(badges(), [], "an empty list draws nothing")
    }

    // Each mailbox has its own total, and the window's rail draws the one on
    // screen: switching mailboxes switches the number, and a mailbox that is not
    // shown is not asked.
    function test_the_flagged_number_follows_the_mailbox_on_screen() {
      var ada = "exchange:ada@corp.example.test"
      keyring.entries[accountId] = secret
      keyring.entries[ada] = "ada-synthetic-passw0rd"
      server.script["exchange.list"] = function(request) {
        if (request.params.query !== "role:inbox flagged") return null
        return { result: { page: { ids: [], threadIds: [], nextPageToken: "",
          estimate: request.params.accountId === ada ? 2 : 9 }, rows: [], warning: null } }
      }
      var jane = seed(null, [entryFor("ada@corp.example.test")])
      var other = mailService.accountAt(0)
      compare(other.accountId, ada)
      install(other)
      tryVerify(function() { return jane.ready && other.ready }, 2000)
      mailService.windowOpen = true
      tryVerify(function() { return badges().join() === "Flagged 9" }, 2000, "Jane's: " + badges())
      compare(other.starredCount, 0, "Ada's mailbox is not on screen and is not asked")
      compare(flaggedAsks().filter(function(r) { return r.params.accountId === ada }).length, 0)

      verify(mailService.switchTo(ada))
      tryVerify(function() { return badges().join() === "Flagged 2" }, 2000, "Ada's: " + badges())
      compare(app.starredCount, 2)
      verify(mailService.switchTo(accountId))
      tryVerify(function() { return badges().join() === "Flagged 9" }, 2000, "Jane's again: " + badges())
    }

    // Nothing draws the count with the window shut, so a poll asks nothing of it.
    function test_a_poll_with_the_window_closed_asks_for_no_flagged_count() {
      native()
      server.flagged = 3
      var account = ready()
      compare(account.nativePolling, true)
      compare(mailService.windowOpen, false)
      wait(150)
      poll()
      account.refreshCounts()
      wait(150)
      compare(flaggedAsks().length, 0)
      compare(account.starredCount, 0)
    }

    // With the window open on the mailbox a poll reads the total again, so it
    // follows what was flagged elsewhere as the list does.
    function test_a_poll_with_the_window_open_reads_the_flagged_count_again() {
      native()
      server.flagged = 3
      var account = ready()
      mailService.windowOpen = true
      tryCompare(account, "starredCount", 3, 2000)
      server.flagged = 5
      account.starred.readAt = 0
      poll()
      tryCompare(account, "starredCount", 5, 2000)
    }

    // Opening the window on the mailbox asks once, behind the listing it opens with.
    function test_opening_the_window_on_the_mailbox_reads_the_flagged_count_once() {
      native()
      server.flagged = 4
      var account = ready()
      wait(150)
      compare(flaggedAsks().length, 0, "not while the window is shut")
      var before = server.calls.length
      mailService.windowOpen = true
      tryCompare(account, "starredCount", 4, 2000)
      wait(150)
      compare(flaggedAsks().length, 1)
      var lists = server.calls.slice(before).filter(function(r) { return r.method === "exchange.list" })
      verify(lists.length > 1 && lists[0].params.query !== "role:inbox flagged",
        "the mailbox's own listing goes first: " + JSON.stringify(lists.map(function(r) { return r.params.query })))
    }

    // A refresh checks for new mail and reads the count once; the check's answer
    // is a poll like any other and asks nothing more.
    function test_a_refresh_reads_the_flagged_count_once() {
      native()
      fixture.answers["mail.check"] = function() { Qt.callLater(poll); return {} }
      server.flagged = 2
      var account = ready()
      mailService.windowOpen = true
      tryCompare(account, "starredCount", 2, 2000)
      wait(200)
      var asked = flaggedAsks().length
      var updates = t.polls
      account.refreshCounts()
      tryVerify(function() { return t.polls === updates + 1 }, 2000, "the check was answered with a poll")
      wait(200)
      compare(flaggedAsks().length, asked + 1)
    }

    // Without Rust's poll the refresh lists new mail itself, and that goes first.
    function test_the_flagged_count_is_asked_after_the_new_mail_listing() {
      var account = ready()
      mailService.windowOpen = true
      wait(200)
      var before = server.calls.length
      account.refreshCounts()
      wait(200)
      var queries = server.calls.slice(before).filter(function(r) { return r.method === "exchange.list" })
        .map(function(r) { return r.params.query })
      verify(queries.indexOf("role:inbox unseen") >= 0, JSON.stringify(queries))
      verify(queries.indexOf("role:inbox unseen") < queries.indexOf("role:inbox flagged"), JSON.stringify(queries))
    }

    // An answer overtaken by a newer question is dropped.
    function test_a_late_answer_does_not_overwrite_a_newer_flagged_count() {
      var account = ready()
      mailService.windowOpen = true
      wait(200)
      var held = hold(account)
      account.starred.refresh()
      account.starred.refresh()
      compare(held.length, 2)
      answer(held[1], 4)
      compare(account.starredCount, 4)
      answer(held[0], 9)
      compare(account.starredCount, 4, "the older answer came last and changed nothing")
    }

    function test_a_mailbox_signed_out_keeps_no_count() {
      server.flagged = 3
      var account = ready()
      mailService.windowOpen = true
      tryCompare(account, "starredCount", 3, 2000)
      account.signOut()
      compare(account.starredCount, 0)
    }

    // A refused password leaves the mailbox ready but its count unknown, and a
    // read sent before the refusal cannot bring the old number back.
    function test_a_refused_password_clears_the_flagged_count() {
      server.flagged = 3
      var account = ready()
      mailService.windowOpen = true
      tryCompare(account, "starredCount", 3, 2000)
      var held = hold(account)
      account.starred.refresh()
      compare(held.length, 1)
      server.script["exchange.list"] = function() { return { error: "exchange_unauthorized" } }
      account.api.listMessages("role:inbox", 25, "", function() {})
      tryCompare(account, "credentialsRejected", true, 2000)
      compare(account.ready, true)
      compare(account.starredCount, 0)
      answer(held[0], 3)
      compare(account.starredCount, 0)
    }

    function test_a_mailbox_that_stops_being_ready_keeps_no_count() {
      server.flagged = 3
      var account = ready()
      mailService.windowOpen = true
      tryCompare(account, "starredCount", 3, 2000)
      mailService.backend.connected = false
      tryCompare(account, "ready", false, 1000)
      compare(account.starredCount, 0)
      mailService.backend.connected = true
      tryCompare(account, "ready", true, 1000)
      tryCompare(account, "starredCount", 3, 2000, "read again once it is back")
    }

    // A merged list has no one mailbox to ask, so it reads and draws no count; and
    // a row in it is acted on by the mailbox it came from, under that mailbox's own id.
    function test_a_row_in_a_merged_list_goes_to_the_exchange_mailbox_and_the_list_has_no_count() {
      server.flagged = 5
      keyring.entries[accountId] = secret
      mailService.applySettings({ unifiedMailboxes: true })
      mailService.windowOpen = true
      var list = ({ version: 1, activeId: accountId, accounts: [
        { id: accountId, email: "jane@corp.example.test", provider: "exchange", clientId: "", clientSecret: "",
          exchange: { ewsUrl: ewsUrl, username: "", authScheme: "auto" }, label: "", signature: "" },
        { id: "bob@example.net", email: "bob@example.net", provider: "gmail", clientId: "", clientSecret: "",
          label: "", signature: "" }] })
      mailService.accountsLoaded = true
      mailService.accountList = list
      mailService.refreshCurrent()
      tryCompare(mailService, "accountCount", 2)
      var account = mailService.findAccount(accountId)
      tryVerify(function() { return !!account.api }, 2000)
      install(account)
      tryVerify(function() { return account.ready }, 2000)
      // The client has finished talking to the server before the row is acted on.
      tryVerify(function() {
        return server.calls.some(function(request) { return request.answered })
      }, 2000)
      wait(150)
      compare(mailService.unified, true)
      compare(account.windowOpen, true)
      compare(flaggedAsks().length, 0, "nothing asks for a count the merged rail cannot draw")
      account.starred.count = 5
      compare(app.starredCount, 0, "and a number the mailbox holds is not drawn")
      account.messages = [row("abcd2345")]
      account.listLoaded = true
      mailService.bumpListEpoch()
      wait(50)
      var merged = Unified.unifiedId(accountId, "abcd2345")
      compare(mailService.hostForId(merged), account)
      compare(mailService.sourceIdFor(merged), "abcd2345")
      compare(badges(), [], "no count where there is no one mailbox")

      verify(mailService.act(merged, "star", false, false))
      tryVerify(function() { return sent("exchange.modify").length === 1 }, 2000)
      compare(sent("exchange.modify")[0].params.ids, ["abcd2345"], "under the mailbox's own id")

      // Back to one mailbox on screen, and its count is read: once, with no refresh to ask.
      tryCompare(account, "pendingAction", "")
      wait(150)
      server.flagged = 6
      var asked = flaggedAsks().length
      mailService.applySettings({ unifiedMailboxes: false })
      tryCompare(account, "starredCount", 6, 2000)
      compare(app.starredCount, 6)
      wait(150)
      compare(flaggedAsks().length, asked + 1)
    }
  }
}
