import QtQuick
import QtTest
import "../../account" as Account

Item {
  QtObject {
    id: backend
    property bool ready: false
    property var requests: []
    function call(method, params, callback) {
      if (method === "message.summaries") requests.push({method:method,params:params,callback:callback})
    }
    function complete(index) {
      var summaries = []
      var resources = requests[index].params.messages
      for (var i = 0; i < resources.length; i++) summaries.push({id:resources[i].id,date:"2026-09-12T00:00:00Z",subject:"Native summary"})
      requests[index].callback({summaries:summaries},null)
    }
  }
  Component {
    id: clientFactory
    QtObject {
      function getMessages(ids, full, done, parent, progress) {
        if (typeof progress === "function") progress([{id:"one"}])
        done([{id:"one"},{id:"two"}], "")
        return {aborted:false}
      }
      function abortRequest(handle) { handle.aborted = true }
    }
  }
  Account.MailAccount {
    id: account
    pluginDir: "/synthetic/plugin"
    backend: backend
    clientOverride: clientFactory
  }
  TestCase {
    name: "NativeMessagePipeline"
    function init() {
      account.accountId = "first@example.org"
      backend.requests = []
    }
    function test_final_metadata_waits_for_native_progress_preparation() {
      var delivered = []
      account.summarizedRead(["one","two"],false,function(resources,error) {
        compare(error, "")
        compare(resources[1].nativeSummary.subject,"Native summary")
        verify(resources[1].nativeSummary.date instanceof Date)
        delivered.push("final")
      },null,function(resources) {
        compare(resources[0].nativeSummary.subject,"Native summary")
        delivered.push("progress")
      })
      compare(backend.requests.length,1)
      compare(delivered.length,0)
      backend.complete(0)
      compare(delivered.join(","),"progress")
      compare(backend.requests.length,2)
      backend.complete(1)
      compare(delivered.join(","),"progress,final")
    }
    function test_aborted_read_discards_native_work_already_in_flight() {
      var called=false
      var handle=account.summarizedRead(["one"],false,function() { called=true })
      account.abortRequest(handle)
      backend.complete(0)
      verify(!called)
    }
    function test_account_switch_discards_native_work_already_in_flight() {
      var called=false
      account.summarizedRead(["one"],false,function() { called=true })
      account.accountId="second@example.org"
      backend.complete(0)
      verify(!called)
    }
  }
}
