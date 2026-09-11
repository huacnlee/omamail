import QtQuick
import QtTest
import "../../cache" as Cache

Item {
  QtObject {
    id: backend
    property bool ready: true
    property var calls: []
    property var putDone: null
    property var readDone: null
    function call(method, params, done) {
      calls = calls.concat([{method:method,params:params}])
      if (method === "cache.bodyRead") readDone = done
      else done(null, null)
    }
    function putBodyCache(account, id, body, done) {
      calls = calls.concat([{method:"put",params:{accountId:account,id:id,body:body}}])
      putDone = done
    }
  }
  Cache.BodyCache { id: cache; pluginDir:"/synthetic/plugin"; accountId:"a@example.org"; backend:backend }
  TestCase {
    name:"BodyCacheBackend"
    when:windowShown
    function init() {
      backend.calls=[]
      backend.putDone=null
      backend.readDone=null
      cache.accountId="a@example.org"
    }
    function test_clear_waits_for_inflight_upload() {
      cache.put("one", {text:"body"})
      compare(backend.calls.length,1)
      cache.put("two", {text:"obsolete queued body"})
      cache.clear()
      compare(backend.calls.length,1)
      backend.putDone({stored:true},null)
      compare(backend.calls.length,2)
      compare(backend.calls[1].method,"cache.bodyClear")
      compare(backend.calls[1].params.accountId,"a@example.org")
      compare(cache.writeQueue.length,0)
      compare(cache.nativeWriteBusy,false)
    }
    function test_account_switch_refuses_old_read_result() {
      var answer="pending"
      cache.read("one",function(value) {answer=value})
      compare(backend.calls[0].method,"cache.bodyRead")
      cache.accountId="b@example.org"
      backend.readDone({text:"other account body"},null)
      compare(answer,null)
    }
    function test_cache_errors_are_misses_without_a_script_fallback() {
      var answer="pending"
      cache.read("one",function(value) {answer=value})
      backend.readDone(null,{message:"cache_unavailable"})
      compare(answer,null)
      compare(cache.writeQueue.length,0)
      for (var i=0;i<cache.children.length;i++) {
        var child=cache.children[i]
        if (child.running !== undefined) compare(child.running,false)
      }
    }
  }
}
