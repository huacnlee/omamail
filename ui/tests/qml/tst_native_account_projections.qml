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
  }
}
