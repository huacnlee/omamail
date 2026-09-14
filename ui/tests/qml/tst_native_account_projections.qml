import QtQuick 2.15
import QtTest 1.3
import "../.." as Omamail
import "BackendFixture.js" as BackendFixture

Item {
  Omamail.Service {
    id: service
    manifest: ({ id: "omamail", __sourceDir: "" })
  }
  TestCase {
    name: "NativeAccountProjections"
    property var fixture
    function initTestCase() {
      BackendFixture.markReady(service)
      fixture = BackendFixture.install(service)
    }
    function pending(method) {
      return fixture.requests.filter(function(request) { return request.method === method })
    }
    function init() {
      fixture.answers = ({ "account.identities": undefined, "account.conversation": undefined })
      wait(1)
      fixture.requests = []
    }
    function test_sender_change_clears_choices_and_rejects_old_reply() {
      service.sendIdentities = [{ accountId: "old", email: "old@example.org" }]
      service.scheduleSenderIdentities()
      compare(service.sendIdentities.length, 0)
      tryVerify(function() { return pending("account.identities").length === 1 })
      var old = pending("account.identities")[0]
      service.scheduleSenderIdentities()
      tryVerify(function() { return pending("account.identities").length === 2 })
      var current = pending("account.identities")[1]
      BackendFixture.respond(service, current, { identities: [{ accountId: "new", email: "new@example.org" }] })
      tryCompare(service, "sendIdentities", [{ accountId: "new", email: "new@example.org" }])
      BackendFixture.respond(service, old, { identities: [{ accountId: "old", email: "old@example.org" }] })
      wait(1)
      compare(service.sendIdentities[0].accountId, "new")
    }
    function test_sender_failure_keeps_from_choices_empty() {
      service.scheduleSenderIdentities()
      tryVerify(function() { return pending("account.identities").length === 1 })
      BackendFixture.respond(service, pending("account.identities")[0], null, { code: -1, message: "unavailable" })
      wait(1)
      compare(service.sendIdentities.length, 0)
    }
    function test_conversation_change_clears_navigation_and_rejects_old_reply() {
      service.conversationProjection = { showsRail: true, stops: [{id:"old"}], navigation: { old: {next:"other"} } }
      // Nothing has been projected yet, so what is in hand is not this
      // source's and goes.
      service.projectedThread = "never"
      service.scheduleConversationProjection()
      compare(service.conversationProjection.showsRail, false)
      compare(Object.keys(service.conversationProjection.navigation).length, 0)
      tryVerify(function() { return pending("account.conversation").length === 1 })
      var old = pending("account.conversation")[0]
      service.scheduleConversationProjection()
      tryVerify(function() { return pending("account.conversation").length === 2 })
      var fresh = { showsRail: true, stops: [{id:"new"}], navigation: {new:{previous:"",next:"",neighbor:""}}, memberIds:["new"], caption:"" }
      BackendFixture.respond(service, pending("account.conversation")[1], fresh)
      tryCompare(service, "conversationProjection", fresh)
      BackendFixture.respond(service, old, {showsRail:true,stops:[{id:"old"}],navigation:{old:{next:"other"}}})
      wait(1)
      compare(service.conversationProjection.stops[0].id, "new")
    }
    // The rail stays up while the same thread is projected again: a member
    // merge, a mark-read or a list refresh asks for a fresh projection, and
    // the one in hand is drawn until it lands. Only its navigation goes.
    function test_same_thread_keeps_the_rail_while_a_projection_is_in_flight() {
      service.projectedThread = "never"
      service.scheduleConversationProjection()
      tryVerify(function() { return pending("account.conversation").length === 1 })
      var landed = { showsRail: true, stops: [{id:"a"},{id:"b"}], caption: "2 messages",
        navigation: { a: {previous:"",next:"b",neighbor:"b"} }, memberIds: ["a","b"] }
      BackendFixture.respond(service, pending("account.conversation")[0], landed)
      tryCompare(service, "conversationProjection", landed)
      service.scheduleConversationProjection()
      compare(service.conversationProjection.showsRail, true, "the rail is still drawn")
      compare(service.conversationProjection.stops.length, 2, "with the stops it had")
      compare(service.conversationProjection.caption, "2 messages")
      compare(Object.keys(service.conversationProjection.navigation).length, 0,
        "but a stale next or previous cannot be followed")
      tryVerify(function() { return pending("account.conversation").length === 2 })
      BackendFixture.respond(service, pending("account.conversation")[1], landed)
      tryCompare(service, "conversationProjection", landed)
    }
    // A source that reads the same as the last one asked for — a new object
    // with nothing different in it, which is what every unified snapshot and
    // composed thread produces — asks for nothing.
    function test_an_unchanged_source_does_not_ask_again() {
      service.projectedThread = "never"
      service.scheduleConversationProjection()
      tryVerify(function() { return pending("account.conversation").length === 1 })
      service.conversationSourceChanged()
      service.conversationSourceChanged()
      wait(1)
      compare(pending("account.conversation").length, 1)
      service.projectedSource = ""
      service.conversationSourceChanged()
      tryVerify(function() { return pending("account.conversation").length === 2 })
    }
  }
}
