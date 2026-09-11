const assert = require('assert')
const fs = require('fs')
const vm = require('vm')
const source = fs.readFileSync(require('path').join(__dirname,'../ui/account/MailAccount.qml'),'utf8')
function method(name) {
  const start = source.indexOf('  function '+name+'(')
  assert(start>=0,name)
  return source.slice(start,source.indexOf('\n  }',start+1)+4)
}
const calls=[]
const context={accountId:'a@example.org',api:{getMessage(){assert.fail('raw provider resource crossed reader boundary')}},readerRequestPrefix:'fixture',readerRequestSerial:0,remoteImagesAllowed:false,remoteImageData:{},readerSourceKey:'cached-key',renderSerial:0,detailSerial:1,selectedId:'m',hydrateSummary:v=>v,fail:()=>assert.fail('unexpected UI failure'),Qt:{callLater:()=>{}},backend:{call(method,params,callback){calls.push({method,params,callback})}}}
context.root=context
vm.createContext(context)
for(const name of ['readerOptions','preparedRead','renderSource','abortRequest'])vm.runInContext(method(name),context)
let painted=0
const handle=context.preparedRead('m',()=>painted++)
assert.strictEqual(calls[0].method,'reader.open')
assert.strictEqual(calls[0].params.cacheOnly,true)
calls[0].callback({nativeContent:{},nativeSummary:{}},null)
assert.strictEqual(painted,1)
assert.strictEqual(calls[1].method,'reader.open')
assert.strictEqual(calls[1].params.cacheOnly,false)
context.abortRequest(handle)
assert.strictEqual(calls[2].method,'reader.cancel')
assert.strictEqual(calls[2].params.requestId,calls[1].params.requestId)
calls[1].callback({nativeContent:{},nativeSummary:{}},null)
assert.strictEqual(painted,1,'cancelled live read cannot paint')
context.applyRendered=()=>assert.fail('late cached rerender overwrote live source')
context.renderSource('cached-key')
const rerender=calls[3]
assert.strictEqual(rerender.method,'reader.render')
assert.strictEqual(rerender.params.readerKey,'cached-key')
assert.strictEqual(rerender.params.html,undefined)
context.readerSourceKey='live-key'
rerender.callback({nativeRender:{}},null)
assert(!method('preparedRead').includes('message.prepare'))
assert(!method('preparedRead').includes('getMessage'))
console.log('Native reader adapter: cache/live, cancellation, opaque rerender and stale source guards passed')
