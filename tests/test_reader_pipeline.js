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

// Remote image loading must paint one completed batch, without refetching a
// source when the cached resource is replaced by its live native projection.
const images=[]
const paints=[]
const later=[]
const imageContext={remoteImagesAllowed:true,remoteImagesLoading:false,readerSourceKey:'cache',
  selectedRemoteImageSources:['https://example.org/one','https://example.org/two'],
  remoteImageData:{},remoteImageAttempted:{},imageFetchQueue:[],imageFetchSerial:0,imageBatchDirty:false,
  imagePaintTimer:{running:false,start(){this.running=true},stop(){this.running=false}},
  Html:require('../ui/tests/load').load('message/Html.js'),Qt:{callLater:fn=>later.push(fn)},
  backend:{ready:true,call(method,params,callback){images.push({method,params,callback})}},
  renderSource:key=>paints.push(key)}
imageContext.root=imageContext
vm.createContext(imageContext)
for(const name of ['prepareRemoteImages','fetchNextImage','flushRemoteImages'])vm.runInContext(method(name),imageContext)
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLa0AAAAASUVORK5CYII='
imageContext.prepareRemoteImages()
images[0].callback({data:png},null)
assert.strictEqual(paints.length,0,'first image must not rebuild whole document before batch ends')
imageContext.readerSourceKey='live'
images[1].callback({data:png},null)
assert.deepStrictEqual(paints,['live'])
imageContext.prepareRemoteImages()
assert.strictEqual(images.length,2,'approved sources must not be fetched twice')
imageContext.selectedRemoteImageSources.push('https://example.org/bad')
imageContext.prepareRemoteImages()
images[2].callback({data:'data:image/svg+xml;base64,PHN2Zz4='},null)
assert.strictEqual(imageContext.remoteImageData['https://example.org/bad'],undefined)
imageContext.prepareRemoteImages()
assert.strictEqual(images.length,3,'refused sources must not create an automatic retry loop')
assert.strictEqual(paints.length,1)
console.log('Remote images: one batch paint, cached/live continuity, no duplicate fetch or unsafe image passed')
