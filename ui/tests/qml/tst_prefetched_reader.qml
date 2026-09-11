import QtQuick
import QtTest
import "../../account" as Account
import "NativeDomainFixture.js" as Native
import "../../../benchmarks/mail/baseline/ui/message/Message.js" as Mail

Item {
  QtObject {
    id: transport
    property var pending: ({})
    property int reads: 0
  }
  QtObject {
    id: backend
    property bool ready: false
    property var cached: null
    property bool holdCache: false
    property var cacheRequests: []
    property var requests: []
    property var cancellations: []
    function preparedResource(message, params) {
      return Native.readerProjection(message, params || {accountId:account.accountId})
    }
    function call(method, params, callback) {
      requests.push({method:method,params:JSON.parse(JSON.stringify(params))})
      if (method === "reader.open") {
        if (params.cacheOnly) {
          if (holdCache) cacheRequests.push({params:params,callback:callback})
          else callback(cached ? preparedResource(cached, params) : null, null)
        } else {
          transport.reads++
          transport.pending[params.id]=function(message,error) {
            callback(message ? preparedResource(message,params) : null,error ? {code:"read_failed"} : null)
          }
        }
      } else if (method === "reader.cancel") {
        cancellations.push(params)
        callback({cancelled:true},null)
      } else {
        var result=Native.answer(method,params)
        if (result !== undefined) callback(result,null)
      }
    }
  }
  Component {
    id: clientFactory
    QtObject {
      function getMessage(id, full, done) {
        throw new Error("The reader must not fetch raw resources through the QML provider")
      }
      function abortRequest(handle) {handle.aborted=true}
      function getSummaries(ids,callback) {return {aborted:false}}
    }
  }
  Account.MailAccount {
    id: account
    pluginDir:"/synthetic/plugin"
    backend:backend
    clientOverride:clientFactory
    property var readMarks: []
    function act(id, action, quiet) { readMarks.push({id:id,action:action,quiet:quiet}); if(selectedMessage) selectedMessage.unread=false; return true }
  }
  TestCase {
    name:"PrefetchedReader"
    function resource(id,text,unread) {
      return {id:id,labelIds:unread ? ["UNREAD"] : [],payload:{mimeType:"text/plain",headers:[
        {name:"Subject",value:"Native summary"},{name:"From",value:"Sender <sender@example.org>"}],
        body:{data:Mail.bytesToBase64(Mail.utf8Bytes(text),true)}}}
    }
    function init() {
      account.clearSelection()
      account.accountId="first@example.org"
      account.lastError=""
      transport.pending=({})
      transport.reads=0
      backend.cached=null
      backend.holdCache=false
      backend.cacheRequests=[]
      backend.requests=[]
      backend.cancellations=[]
      account.alwaysShowImages=false
      account.readMarks=[]
    }
    function test_prefetched_body_paints_while_live_network_remains_pending() {
      backend.cached=resource("one","Already downloaded")
      account.select("one",true)
      compare(transport.reads,1,"network revalidation may run in the background")
      compare(account.selectedBody.text,"Already downloaded")
      compare(account.detailLoading,false)
      compare(account.detailPainted,true)
      compare(account.detailLive,false)
      compare(account.selectionIsPreview,true)
    }
    function test_live_revalidation_replaces_prefetched_body_without_raw_resource_rpc() {
      backend.cached=resource("one","Cached")
      account.select("one",true)
      transport.pending.one(resource("one","Current"),"")
      compare(account.selectedBody.text,"Current")
      compare(account.detailLoading,false)
      compare(account.detailLive,true)
      var opens=backend.requests.filter(function(call) {return call.method === "reader.open"})
      compare(opens.length,2)
      compare(opens[0].params.cacheOnly,true)
      compare(opens[1].params.cacheOnly,false)
      compare(opens[0].params.requestId,opens[1].params.requestId)
      compare(backend.requests.filter(function(call) {return call.method === "cache.resourcePut" || call.method === "message.prepare"}).length,0)
    }
    function test_cache_to_live_keeps_completed_images_and_inflight_queue() {
      var message = resource("one", "<p>Same mail</p><img src='https://example.org/picture'>")
      message.payload.mimeType = "text/html"
      backend.cached = message
      account.select("one", true)
      account.remoteImagesAllowed = true
      var png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLa0AAAAASUVORK5CYII="
      account.remoteImageData = ({"https://example.org/picture": png})
      account.remoteImageAttempted = ({"https://example.org/picture": true})
      account.remoteImagesLoading = true
      account.imageFetchQueue = ["https://example.org/pending"]
      var serial = account.imageFetchSerial
      var painted = {type: "root", children: [{type: "text", text: "approved image is visible"}]}
      account.selectedDocument = painted
      transport.pending.one(message, "")
      compare(account.detailLive, true)
      compare(account.selectedDocument, painted)
      compare(account.remoteImageData["https://example.org/picture"], png)
      compare(account.imageFetchSerial, serial)
      compare(account.remoteImagesLoading, true)
      compare(account.imageFetchQueue.length, 1)
      var renders = backend.requests.filter(function(call) { return call.method === "reader.render" })
      compare(renders.length, 1)
      compare(renders[0].params.options.remoteImageData["https://example.org/picture"], png)
    }

    function test_background_failure_keeps_a_cached_body_without_skeleton() {
      backend.cached=resource("one","Cached")
      account.select("one",true)
      transport.pending.one(null,"Server unavailable")
      compare(account.selectedBody.text,"Cached")
      compare(account.detailLoading,false)
      compare(account.lastError,"")
    }
    function test_cache_miss_reports_live_failure() {
      account.select("one",true)
      compare(account.detailLoading,true)
      transport.pending.one(null,"Server unavailable")
      compare(account.detailLoading,false)
      compare(account.lastError,"Could not open that message")
    }
    function test_cached_read_then_stale_live_flags_does_not_repeat_mark_or_restore_unread() {
      backend.cached=resource("one","Cached",true)
      account.select("one",false)
      compare(account.readMarks.length,1)
      transport.pending.one(resource("one","Current",true),"")
      compare(account.readMarks.length,1)
      compare(account.selectedMessage.unread,false)
      compare(account.selectedBody.text,"Current")
    }
    function test_failed_mark_read_is_not_forced_back_over_native_rollback() {
      backend.cached=resource("one","Cached",true)
      account.select("one",false)
      compare(account.readMarks.length,1)
      account.selectedMessage.unread=true
      transport.pending.one(resource("one","Current",true),"")
      compare(account.readMarks.length,1)
      compare(account.selectedMessage.unread,true)
    }
    function test_prefetched_markup_waits_for_native_projection_without_raw_fallback() {
      backend.cached=resource("one","Cached")
      backend.holdCache=true
      account.select("one",true)
      compare(account.detailPainted,false)
      compare(account.selectedHasHtml,false)
      compare(backend.cacheRequests.length,1)
      backend.cacheRequests[0].callback(null,{code:"render_failed"})
      compare(account.detailPainted,false)
      compare(account.selectedHasHtml,false)
      compare(transport.reads,1,"failed cache projection still permits a fresh native read")
      transport.pending.one(null,"Render failed")
      compare(account.detailLoading,false)
      compare(account.selectedHasHtml,false)
      verify(account.lastError!=="")
    }
    function test_image_policy_is_passed_to_both_native_reads() {
      account.alwaysShowImages=true
      account.select("one",true)
      var opens=backend.requests.filter(function(call) {return call.method === "reader.open"})
      compare(opens.length,2)
      compare(opens[0].params.options.allowRemoteImages,false,"prefetch/preview never loads sender images")
      compare(opens[1].params.options.allowRemoteImages,false)
      account.select("two",false)
      opens=backend.requests.filter(function(call) {return call.method === "reader.open"})
      compare(opens[2].params.options.allowRemoteImages,true)
      compare(opens[3].params.options.allowRemoteImages,true)
      compare(backend.cancellations.length,1)
      compare(backend.cancellations[0].requestId,opens[0].params.requestId)
    }
    function test_stale_cache_reply_cannot_cross_selection_or_account() {
      backend.holdCache=true
      account.select("one",true)
      account.select("two",true)
      backend.cacheRequests[0].callback(backend.preparedResource(resource("one","Old selection")),null)
      compare(account.selectedBody.text,"")
      compare(transport.reads,0)
      account.accountId="second@example.org"
      backend.cacheRequests[1].callback(backend.preparedResource(resource("two","Old account")),null)
      compare(account.selectedBody.text,"")
      compare(transport.reads,0)
    }
  }
}
