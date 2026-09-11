import QtQuick
import QtTest
import "../../cache" as Cache

Item {
  QtObject {
    id: backend
    property bool ready: false
    property var reads: []
    property var requests: []
    function call(method, params, done) {
      if (method === "cache.queryRestore") reads = reads.concat([{params:params,done:done}])
      else requests = requests.concat([{method:method,params:params,done:done}])
    }
  }
  Cache.CacheStore { id: cache; backend:backend; accountId:"a@example.org" }
  TestCase {
    name: "CacheStoreBackend"
    when: windowShown
    function snapshot(account, generation) {
      return {generation:generation,store:{version:2,account:account,labels:[],profile:null,session:null}}
    }
    function init() {
      backend.ready = false
      cache.accountId = "a@example.org"
      backend.reads = []
      backend.requests = []
      backend.ready = true
      compare(backend.reads.length,1)
    }
    function test_late_restore_cannot_show_another_account() {
      var old=backend.reads[0].done
      cache.accountId="b@example.org"
      old(snapshot("a@example.org",1),null)
      compare(cache.loaded,false)
      compare(cache.store.account,"")
      backend.reads[1].done(snapshot("b@example.org",2),null)
      compare(cache.loaded,true)
      compare(cache.generation,2)
      compare(cache.store.account,"b@example.org")
      compare(cache.store.queries,undefined)
    }
    function test_backend_refusal_cannot_authorize_a_cache_generation() {
      backend.reads[0].done(null,{message:"backend_unavailable"})
      compare(cache.loaded,false)
      compare(cache.generation,0)
    }
    function test_mutations_send_only_changed_data_and_native_generation() {
      backend.reads[0].done(snapshot("a@example.org",17),null)
      cache.putProfile({email:"a@example.org"})
      cache.putLabels([{id:"INBOX"}])
      compare(backend.requests.length,2)
      compare(backend.requests[0].method,"cache.queryProfile")
      compare(backend.requests[0].params.generation,17)
      compare(backend.requests[0].params.store,undefined)
      compare(backend.requests[1].method,"cache.queryLabels")
      backend.requests[0].done({profile:{email:"a@example.org"},account:"a@example.org"},null)
      compare(cache.store.profile.email,"a@example.org")
    }
    function test_native_preview_result_and_date_boundary() {
      backend.reads[0].done(snapshot("a@example.org",5),null)
      var seen=null
      cache.getPreview("folder:INBOX",25,"needle","imap",1000,function(result,error) {seen=result})
      compare(backend.requests[0].method,"cache.queryGet")
      compare(backend.requests[0].params.query,"folder:INBOX")
      backend.requests[0].done({key:"folder:INBOX|25",summaries:[{id:"one",dateMs:10}]},null)
      compare(seen.summaries[0].id,"one")
      cache.putQuery(seen.key,{summaries:[{id:"one",date:new Date(1000)}],estimate:1,nextPageToken:""})
      compare(backend.requests[1].params.page.summaries[0].dateMs,1000)
      compare(backend.requests[1].params.page.summaries[0].date,undefined)
    }
    function test_evicted_generation_restores_without_replaying_stale_mutation() {
      backend.reads[0].done(snapshot("a@example.org",5),null)
      cache.putLabels([{id:"old"}])
      backend.requests[0].done(null,{message:"cache_stale_generation"})
      compare(cache.loaded,false)
      compare(backend.reads.length,2)
      backend.reads[1].done(snapshot("a@example.org",6),null)
      compare(cache.generation,6)
      compare(backend.requests.length,1)
      compare(cache.store.labels.length,0)
    }
    function test_late_mutation_reply_cannot_replace_new_account_metadata() {
      backend.reads[0].done(snapshot("a@example.org",5),null)
      cache.putLabels([{id:"private"}])
      cache.accountId="b@example.org"
      backend.requests[0].done({labels:[{id:"private"}]},null)
      compare(cache.store.labels.length,0)
    }
  }
}
