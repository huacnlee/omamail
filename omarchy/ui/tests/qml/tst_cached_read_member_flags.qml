import QtQuick
import QtTest
import "../../account" as Account
import "NativeDomainFixture.js" as Native
import "../../../benchmarks/mail/baseline/ui/message/Message.js" as Mail

// A member opened for the second time paints from its cached copy first, and
// that copy is older than everything the account holds about the message.
//
// The copy on disk is written by a live read, as the server answered it. The
// first opening of an unread member is exactly that read, so the file says
// unread — and the quiet mark-read that follows changes the store the rail
// draws from, never the file. Opening the member again hands the reader the
// file before the network answers, and what it says must not overwrite what
// the account already knows: the stop the rail draws for it would go unread
// for one round trip, and the reader would mark it read a second time.
//
// The account is a real `MailAccount` with `reader.open` scripted the way the
// backend answers it — the cached copy at once, the live one when the test
// says so — and `act` recorded rather than sent, with the optimistic view it
// leaves behind applied by hand.
Item {
  id: fixture
  QtObject {
    id: transport
    property var pending: ({})
  }
  QtObject {
    id: backend
    property bool ready: true
    // What the disk holds, by message id.
    property var cached: ({})
    function call(method, params, callback) {
      if (method === "reader.open") {
        function projection(message) { return Native.readerProjection(message, params) }
        if (params.cacheOnly) callback(cached[params.id] ? projection(cached[params.id]) : null, null)
        else transport.pending[params.id] = function(message, error) {
          callback(message ? projection(message) : null, error ? {code: "read_failed"} : null)
        }
      } else if (method === "reader.cancel") {
        callback({cancelled: true}, null)
      } else {
        var result = Native.answer(method, params)
        if (result !== undefined) callback(result, null)
      }
    }
  }
  Component {
    id: clientFactory
    QtObject {
      function abortRequest(handle) { handle.aborted = true }
      function getSummaries(ids, callback) { return {aborted: false} }
    }
  }
  Account.MailAccount {
    id: account
    pluginDir: "/synthetic/plugin"
    providerId: "jmap"
    backend: backend
    clientOverride: clientFactory
    property var readMarks: []
    // The quiet mark-read, as the optimistic view leaves it before the server
    // answers: the member store and the open summary read, and the row whose
    // block holds the message with its block recomputed from the members.
    function act(id, action, quiet) {
      readMarks.push({id: id, action: action, quiet: quiet})
      var members = JSON.parse(JSON.stringify(memberSummaries))
      if (members[id]) members[id] = read(members[id])
      memberSummaries = members
      if (selectedMessage && selectedMessage.id === id) selectedMessage = read(selectedMessage)
      var rows = JSON.parse(JSON.stringify(messages))
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].id === id) rows[i] = read(rows[i])
        var block = rows[i].thread
        if (!block || (block.memberIds || []).indexOf(id) < 0) continue
        // By each member's own labels, as the intent recomputes it: a summary's
        // flag is the conversation's, and the row seeded into the store as its
        // own member carries the block's reading.
        var unread = rows[i].labelIds.indexOf("UNREAD") >= 0
        for (var m = 0; m < block.memberIds.length; m++) {
          var member = members[block.memberIds[m]]
          if (member && (member.labelIds || []).indexOf("UNREAD") >= 0) unread = true
        }
        block.unread = unread
        rows[i].unread = unread
      }
      messages = rows
      return true
    }
    function read(summary) {
      var next = JSON.parse(JSON.stringify(summary))
      next.unread = false
      next.labelIds = (next.labelIds || []).filter(function(label) { return label !== "UNREAD" })
      return next
    }
  }
  // Every moment the reply reads as unread: in the store the rail draws from,
  // and in the stops the account projected from it.
  property var unreadMoments: []
  Connections {
    target: account
    function onMemberSummariesChanged() {
      var member = account.memberSummaries.reply
      if (member && (member.unread === true || (member.labelIds || []).indexOf("UNREAD") >= 0))
        fixture.unreadMoments.push("store")
    }
    function onConversationOrganisationChanged() {
      var stops = account.conversationOrganisation ? account.conversationOrganisation.stops || [] : []
      for (var i = 0; i < stops.length; i++)
        if (stops[i].id === "reply" && stops[i].unread === true) fixture.unreadMoments.push("stop")
    }
  }
  TestCase {
    name: "CachedReadMemberFlags"
    // A member's resource carries no block of its own; a representative's
    // carries the conversation's, as it stood when the resource was read.
    function resource(id, text, unread, replyUnread) {
      var out = {id: id, threadId: "t", labelIds: unread ? ["INBOX", "UNREAD"] : ["INBOX"],
        payload: {mimeType: "text/plain", headers: [
          {name: "Subject", value: "Thread"}, {name: "From", value: "Sender <sender@example.org>"}],
          body: {data: Mail.bytesToBase64(Mail.utf8Bytes(text), true)}}}
      if (replyUnread !== undefined)
        out.thread = {id: "t", memberIds: ["first", "reply"], count: 2, unread: unread || replyUnread}
      return out
    }
    function summary(id, text, unread, replyUnread) {
      return Native.summary(resource(id, text, unread, replyUnread), new Date())
    }
    function init() {
      account.clearSelection()
      account.accountId = "first@example.org"
      account.lastError = ""
      account.readMarks = []
      transport.pending = ({})
      backend.cached = ({})
      fixture.unreadMoments = []
    }
    function test_a_member_opened_again_from_its_cached_copy_stays_read() {
      // The conversation as the list and the rail left it: the first message
      // is the row, read itself, its block saying a reply is not; the reply
      // is a member the rail knows from its summary; the row is open.
      account.messages = [summary("first", "Hello", false, true)]
      account.memberSummaries = {reply: summary("reply", "Reply", true)}
      account.selectedThread = {id: "t", memberIds: ["first", "reply"], count: 2, unread: true}
      account.selectedId = "first"

      // Opening the reply from the rail: nothing on disk, the live copy says
      // unread, and the quiet mark-read leaves the store reading it as read.
      account.select("reply", false)
      transport.pending.reply(resource("reply", "Reply", true), "")
      compare(account.readMarks.length, 1, "opening an unread member marks it read once")
      compare(account.memberSummaries.reply.unread, false)
      compare(account.messages[0].thread.unread, false, "and the row's block is recomputed")
      verify(account.conversationOrganisation.stops.some(function(stop) { return stop.id === "reply" && !stop.unread }),
        "the rail draws the reply as read")
      // The live read is what wrote the file — the copy from before the mark.
      backend.cached.reply = resource("reply", "Reply", true)

      // Away to the first message, which opens from its own copy.
      backend.cached.first = resource("first", "Hello", false, true)
      account.select("first", false)
      compare(account.selectedBody.text, "Hello")

      // Back to the reply. The file paints it before the network answers.
      fixture.unreadMoments = []
      account.select("reply", false)
      compare(account.selectedBody.text, "Reply", "the cached copy painted")
      compare(fixture.unreadMoments, [], "and the reply never read as unread on the way")
      compare(account.memberSummaries.reply.unread, false, "the store still says read")
      compare(account.memberSummaries.reply.labelIds.indexOf("UNREAD"), -1)
      compare(account.selectedMessage.unread, false, "so does the open summary")
      compare(account.readMarks.length, 1, "and nothing was marked read again")

      // The live copy lands read, as the server has it by now.
      transport.pending.reply(resource("reply", "Reply", false), "")
      compare(fixture.unreadMoments, [])
      compare(account.memberSummaries.reply.unread, false)
      compare(account.readMarks.length, 1)
    }
    // A representative's file carries the conversation's block as it stood
    // when the file was written. The row's block has been recomputed since,
    // as members were marked, and it is the row's that says whether the
    // thread still has something unread in it — not a reading from before.
    function test_a_representative_opened_from_its_cached_copy_keeps_the_block_in_hand() {
      account.messages = [summary("first", "Hello", false, false)]
      account.memberSummaries = {reply: summary("reply", "Reply", false)}
      account.selectedThread = {id: "t", memberIds: ["first", "reply"], count: 2, unread: false}
      // The file: from when the reply was still unread.
      backend.cached.first = resource("first", "Hello", false, true)
      account.select("first", false)
      compare(account.selectedBody.text, "Hello")
      compare(account.selectedMessage.unread, false, "the row's block, not the file's, says whether the thread is read")
      compare(account.selectedMessage.thread.unread, false)
      compare(account.readMarks, [], "so nothing is marked read again")
    }
  }
}
