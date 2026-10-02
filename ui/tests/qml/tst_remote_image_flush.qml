import QtQuick
import QtTest
import "../../account" as Account
import "NativeDomainFixture.js" as Native
import "../../../benchmarks/mail/baseline/ui/message/Message.js" as Mail

// With "Always show images" on, the reader fetches a message's approved images one at a
// time and paints the message again as they arrive. This asserts the fault a newsletter
// with two dozen pictures shows in the shell: one full `reader.render` per fetched image,
// each carrying every image fetched so far, all handled on the GUI thread.
Item {
  QtObject {
    id: transport
    property var pending: ({})
  }
  QtObject {
    id: backend
    property bool ready: true
    property var message: null
    property var requests: []
    property var imageWaiters: []
    function preparedResource(resource, params) {
      return Native.readerProjection(resource, params || {accountId:account.accountId})
    }
    function call(method, params, callback) {
      requests.push({method:method,params:JSON.parse(JSON.stringify(params))})
      if (method === "reader.open") {
        if (params.cacheOnly) {
          callback(null, null)
        } else {
          transport.pending[params.id] = function(resource, error) {
            callback(resource ? preparedResource(resource, params) : null, error ? {code:"read_failed"} : null)
          }
        }
      } else if (method === "reader.render") {
        callback({nativeRender:Native.readerProjection(message, {accountId:account.accountId, options:params.options}).nativeRender}, null)
      } else if (method === "public.image") {
        // Held until the test lets the picture arrive: a real fetch takes a network round trip.
        imageWaiters.push({url:params.url, callback:callback})
      } else if (method === "reader.cancel") {
        callback({cancelled:true}, null)
      } else {
        var result = Native.answer(method, params)
        if (result !== undefined) callback(result, null)
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
      function getSummaries(ids, callback) {return {aborted:false}}
    }
  }
  Account.MailAccount {
    id: account
    pluginDir:"/synthetic/plugin"
    backend:backend
    clientOverride:clientFactory
    function act(id, action, quiet) { if (selectedMessage) selectedMessage.unread=false; return true }
  }
  TestCase {
    name:"RemoteImageFlush"
    property int pictures: 24
    property string png: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLa0AAAAASUVORK5CYII="

    function newsletter() {
      var markup = "<p>A newsletter with a picture in every row</p>"
      for (var i = 0; i < pictures; i++) markup += "<p><img src='https://example.org/picture-" + i + "'></p>"
      return {id:"one", labelIds:[], payload:{mimeType:"text/html", headers:[
        {name:"Subject",value:"Newsletter"},{name:"From",value:"Sender <sender@example.org>"}],
        body:{data:Mail.bytesToBase64(Mail.utf8Bytes(markup),true)}}}
    }
    function renders() {
      return backend.requests.filter(function(call) { return call.method === "reader.render" })
    }
    function init() {
      account.clearSelection()
      account.accountId="first@example.org"
      account.lastError=""
      account.alwaysShowImages=true
      account.remoteImageData=({})
      account.remoteImageAttempted=({})
      account.imageFetchQueue=[]
      account.remoteImagesLoading=false
      transport.pending=({})
      backend.message=null
      backend.requests=[]
      backend.imageWaiters=[]
    }
    function test_a_newsletter_full_of_pictures_is_not_rendered_once_per_picture() {
      backend.message = newsletter()
      account.select("one", false)
      transport.pending.one(backend.message, "")
      tryVerify(function() { return backend.imageWaiters.length > 0 }, 2000, "the reader starts fetching the approved pictures")
      var before = renders().length

      // The pictures arrive one at a time, each slower than the 100 ms paint timer, the way
      // they do from a real sender.
      for (var i = 0; i < pictures; i++) {
        tryVerify(function() { return backend.imageWaiters.length > 0 }, 2000, "picture " + i + " is requested")
        backend.imageWaiters.shift().callback({data:png}, null)
        wait(150)
      }
      tryVerify(function() { return !account.remoteImagesLoading }, 2000, "the last picture arrived")
      compare(Object.keys(account.remoteImageData).length, pictures, "every picture is in remoteImageData")

      // Each render sends the backend every picture fetched so far and parses the document that
      // carries them all back on the GUI thread, so n pictures cost n renders of growing size.
      var painted = renders().length - before
      verify(painted <= pictures / 4,
        "reader.render ran " + painted + " times for " + pictures + " pictures; a fetch queue should cost a handful of renders, not one per picture")
    }
  }
}
