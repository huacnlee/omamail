const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const {load} = require('./load')

// Run the production bridge functions, with only its process and Qt lifecycle
// replaced. Replies are explicitly delayed to reproduce a busy backend.
function bridge() {
  const sent = [], errors = []
  const source = fs.readFileSync(path.join(__dirname, '../backend/Backend.qml'), 'utf8')
  const functions = source.match(/^  function [\s\S]*?^  }/gm).join('\n')
  const context = {
    Upload: load('backend/Upload.js'), Wire: load('backend/Wire.js'),
    Chunks: load('backend/Chunks.js'), Compatibility: load('backend/Compatibility.js'),
    connected: true, ready: true, stopping: false, pending: {}, sequence: 0,
    queued: [], draining: false, uploadQueue: null,
    unreleasedMethods: [], needsUpdate: false, responseTransfer: null,
    shutdownStarted: false, shutdownFinished: false, quitRequested: false,
    shutdownCallbacks: [], shutdownFailure: null,
    shutdownDeadline: {restart(){}, stop(){}}, stopConfirmationDeadline: {restart(){}, stop(){}},
    child: {running: true, write(line) { sent.push(JSON.parse(line)) }},
    requestFailed(method, error) { errors.push({method, error}) },
    notification() {}, shutdownComplete() {}
  }
  Object.defineProperty(context, 'stopping', {get() { return this.shutdownStarted }})
  Object.defineProperty(context, 'ready', {get() { return this.connected && !this.stopping }})
  context.root = context
  vm.createContext(context)
  vm.runInContext(functions, context)
  if (context.Upload.makeQueue)
    context.uploadQueue = context.Upload.makeQueue(() => context.stopForFailure('Backend upload cleanup failed'))
  function reply(request, result, error) {
    context.receive(JSON.stringify({jsonrpc:'2.0', id:request.id, ...(error ? {error} : {result})}))
  }
  return {backend:context, sent, errors, reply}
}

{
  const {backend, sent, errors, reply} = bridge()
  const results = []
  for (let i=0; i<225; i++) backend.call('gmail.read', {accountId:`account-${i%9}`, id:i},
    (value,error)=>results.push({value,error}))
  assert.strictEqual(errors.length, 0, 'a multi-account refresh must queue rather than report a pending-cap error')
  assert.strictEqual(sent.length, 64, 'keep the physical RPC window bounded')
  for (let i=0; i<225; i++) {
    assert.strictEqual(sent[i].params.id, i, 'queued requests retain FIFO order')
    assert(Object.keys(backend.pending).length<=64)
    reply(sent[i], i)
  }
  assert.strictEqual(results.length, 225)
  assert(results.every(result=>!result.error))
  assert.strictEqual(Object.keys(backend.pending).length,0)
}

{
  const {backend, sent, errors, reply} = bridge()
  let completed=0, reserved=0, peak=0, nextId=0
  const uploads=new Map()
  for(let i=0;i<24;i++) backend.parseMessage('Subject: burst\r\n\r\nbody-'+i, (result,error)=>{
    assert(!error, JSON.stringify(error)); completed++
  })
  assert(sent.length<=8, 'only backend-capacity uploads may start together')
  for(let i=0;i<sent.length;i++) {
    const request=sent[i], p=request.params
    if(request.method==='upload.begin') {
      assert(uploads.size<8, 'no ninth live reservation')
      reserved+=p.size; peak=Math.max(peak,reserved)
      const id='upload-'+(++nextId); uploads.set(id, {size:p.size, data:Buffer.alloc(0)})
      reply(request,{upload:id,chunkSize:65536})
    } else if(request.method==='upload.append') {
      const entry=uploads.get(p.upload)
      assert.strictEqual(p.offset,entry.data.length)
      entry.data=Buffer.concat([entry.data,Buffer.from(p.data,'base64url')])
      reply(request,{offset:entry.data.length})
    } else if(request.method==='message.parseUpload') {
      const entry=uploads.get(p.upload)
      assert.strictEqual(entry.data.length,entry.size)
      reserved-=entry.size;uploads.delete(p.upload);reply(request,{parsed:true})
    } else assert.fail(request.method)
  }
  assert.strictEqual(completed,24)
  assert.strictEqual(reserved,0)
  assert.strictEqual(errors.length,0)
}

// A FIFO entry cancelled before dispatch must not execute a domain operation.
{
  const {backend,sent,reply}=bridge()
  let callbacks=0
  const handle=backend.call('cache.resourcePut',{text:'x'.repeat(210000)},()=>callbacks++)
  reply(sent[0],{upload:'cancel-commit',chunkSize:65536})
  for(let i=1;i<=3;i++) reply(sent[i],{offset:i*65536})
  const lastAppend=sent[4]
  assert.strictEqual(lastAppend.method,'upload.append')
  for(let i=0;i<80;i++) backend.call('gmail.read',{id:i},()=>{})
  reply(lastAppend,{offset:210011})
  assert(!sent.some(r=>r.method==='request.upload'))
  handle.cancel()
  for(let i=5;i<sent.length;i++) {
    const request=sent[i]
    assert.notStrictEqual(request.method,'request.upload','cancel must withdraw an unsent uploaded domain operation')
    reply(request,request.method==='upload.discard'?{discarded:true}:{ok:true})
  }
  assert.strictEqual(callbacks,0)
  assert(sent.some(r=>r.method==='upload.discard'))
}

// Cancelling an ordinary queued call removes only that entry. An in-flight
// cancellation must still hold its physical slot until its response arrives.
{
  const {backend,sent,reply}=bridge()
  let cancelledCallbacks=0
  const active=backend.call('gmail.read',{id:'active'},()=>cancelledCallbacks++)
  for(let i=1;i<64;i++) backend.call('gmail.read',{id:i},()=>{})
  const queued=backend.call('gmail.read',{id:'cancelled'},()=>cancelledCallbacks++)
  backend.call('gmail.read',{id:'next'},()=>{})
  active.cancel();queued.cancel()
  assert.strictEqual(sent.length,64)
  assert.strictEqual(Object.keys(backend.pending).length,64)
  reply(sent[0],{})
  assert.strictEqual(sent[64].params.id,'next')
  assert.strictEqual(cancelledCallbacks,0)
}
{
  const {backend,sent,reply}=bridge()
  backend.call('gmail.read',{id:0},()=>backend.call('gmail.read',{id:'reentrant'},()=>{}))
  for(let i=1;i<80;i++) backend.call('gmail.read',{id:i},()=>{})
  reply(sent[0],{})
  for(let i=1;i<80;i++) {assert.strictEqual(sent[i].params.id,i);reply(sent[i],{})}
  assert.strictEqual(sent[80].params.id,'reentrant')
}
// Reset removes both queues and makes replies from the old process harmless.
{
  const {backend,sent,reply}=bridge()
  let callbacks=0
  const done=(_value,error)=>{assert(error);callbacks++}
  for(let i=0;i<80;i++) backend.call('gmail.read',{id:i},done)
  for(let i=0;i<12;i++) backend.parseMessage('x',done)
  backend.failPending('Backend stopped')
  assert.strictEqual(callbacks,92)
  assert.strictEqual(backend.queued.length,0)
  assert.strictEqual(backend.uploadQueue.active.length+backend.uploadQueue.waiting.length,0)
  const prior=sent.slice(); backend.connected=true
  backend.call('gmail.read',{id:'new'},()=>{})
  for(const request of prior) reply(request,{upload:'stale',chunkSize:65536})
  assert.strictEqual(callbacks,92)
  assert.strictEqual(sent.length,prior.length+1)
}
// Bytes are reserved for the full declared length, and FIFO prevents a large
// transfer from starving behind a stream of smaller ones.
{
  const upload=load('backend/Upload.js'), queue=upload.makeQueue()
  const started=[]
  function task(id,size) {return {size,start(){started.push(id)},fail(){}}}
  const first=task('first',64*1024*1024),second=task('second',64*1024*1024)
  queue.add(first);queue.add(second)
  queue.add(task('large',64*1024*1024));queue.add(task('small',1))
  assert.deepStrictEqual(started,['first','second'])
  queue.remove(first)
  assert.deepStrictEqual(started,['first','second','large'])
  queue.remove(second)
  assert.deepStrictEqual(started,['first','second','large','small'])
}
// Cleanup is part of the reservation lifetime, including under RPC saturation.
for(const reason of ['cancel','append failure']) {
  const {backend,sent,reply}=bridge()
  let callbacks=0
  const handles=[]
  for(let i=0;i<9;i++) handles.push(backend.parseMessage('x',(value,error)=>{callbacks++}))
  assert.strictEqual(sent.length,8)
  const begin=sent[0]
  reply(begin,{upload:'release-me',chunkSize:65536})
  const append=sent[8]
  for(let i=0;i<70;i++) backend.call('gmail.read',{id:i},()=>{})
  if(reason==='cancel') handles[0].cancel()
  reply(append,null,{code:-1,message:'refused'})
  assert.strictEqual(backend.uploadQueue.active.length,8)
  assert.strictEqual(callbacks,0)
  // Drain ordinary reads until the queued discard is actually sent.
  for(let cursor=9;!sent.some(r=>r.method==='upload.discard');cursor++) reply(sent[cursor],{})
  const discard=sent.find(r=>r.method==='upload.discard')
  assert.strictEqual(sent.filter(r=>r.method==='upload.begin').length,8)
  reply(discard,{discarded:true})
  // Its newly admitted begin may itself still be waiting for an RPC slot.
  assert.strictEqual(backend.uploadQueue.waiting.length,0)
  assert.strictEqual(callbacks,reason==='cancel'?0:1)
}
{
  const {backend,sent,reply}=bridge()
  let callbacks=0
  const handles=[]
  for(let i=0;i<10;i++) handles.push(backend.parseMessage('x',()=>callbacks++))
  handles[8].cancel()
  assert.strictEqual(backend.uploadQueue.waiting.length,1)
  handles[0].cancel()
  reply(sent[0],{upload:'cancel-begin',chunkSize:65536})
  assert.strictEqual(sent[8].method,'upload.discard')
  reply(sent[8],{discarded:true})
  assert.strictEqual(sent[9].method,'upload.begin')
  assert.strictEqual(callbacks,0)
}
{
  const {backend,sent,reply}=bridge()
  let callbacks=0
  for(let i=0;i<10;i++) backend.parseMessage('x',()=>callbacks++)
  reply(sent[0],{upload:'cleanup-failed',chunkSize:65536})
  reply(sent[8],null,{code:-1,message:'append refused'})
  reply(sent[9],null,{code:-1,message:'discard refused'})
  assert.strictEqual(backend.connected,false)
  assert.strictEqual(backend.child.running,false)
  assert.strictEqual(callbacks,10)
  assert.strictEqual(sent.filter(r=>r.method==='upload.begin').length,8)
}
{
  const {backend,sent,reply}=bridge()
  let callbacks=0
  for(let i=0;i<10;i++) backend.parseMessage('x',()=>callbacks++)
  backend.shutdown(()=>{})
  assert.strictEqual(callbacks,10)
  for(let i=0;i<8;i++) reply(sent[i],{upload:'late-'+i,chunkSize:65536})
  assert.strictEqual(sent.length,9)
  assert.strictEqual(sent[8].method,'system.quit')
}
// Queueing preserves the old snapshot-at-call behavior for mutable models.
{
  const {backend,sent,reply}=bridge()
  for(let i=0;i<64;i++) backend.call('providers.list',{},()=>{})
  const params={accountId:'one@example.org',message:{subject:'original'}}
  backend.call('cache.resourcePut',params,()=>{})
  params.accountId='two@example.org';params.message.subject='changed'
  reply(sent[0],{})
  assert.deepStrictEqual(sent[64].params,{accountId:'one@example.org',message:{subject:'original'}})
}
// Failure fanout is still complete if a receiver has been destroyed or throws.
for(const shutdown of [false,true]) {
  const {backend,sent,reply}=bridge()
  let completed=0, armed=false
  backend.shutdownDeadline.restart=()=>{armed=true}
  for(let i=0;i<10;i++) backend.parseMessage('x',()=>{
    completed++; if(i===8) throw new Error('destroyed receiver')
  })
  assert.doesNotThrow(()=>shutdown?backend.shutdown(()=>{}):backend.stopForFailure('disconnected'))
  assert.strictEqual(completed,10)
  if(shutdown) {
    assert(armed)
    for(let i=0;i<8;i++) reply(sent[i],{upload:'late-'+i,chunkSize:65536})
    assert.strictEqual(sent[8].method,'system.quit')
  } else assert.strictEqual(backend.child.running,false)
}
{
  const {backend}=bridge()
  let completed=0
  for(let i=0;i<80;i++) backend.call('gmail.read',{id:i},()=>{
    completed++; if(i===0 || i===64) throw new Error('destroyed receiver')
  })
  assert.doesNotThrow(()=>backend.stopForFailure('disconnected'))
  assert.strictEqual(completed,80)
  assert.strictEqual(backend.child.running,false)
}
console.log('backend request and upload back-pressure lifecycle tests passed')
module.exports = {bridge}

// Windows storage uses OS known folders, not HOME/XDG overrides. Refuse the
// optional subprocess fixture before it can create storage or start a backend.
if(!process.argv[2]) {
  const probe = require('child_process').spawnSync(process.execPath, ['-e', `
    Object.defineProperty(process, 'platform', {value:'win32'})
    require('fs').mkdtempSync = () => {throw new Error('unisolated storage')}
    require('child_process').spawn = () => {throw new Error('unisolated process')}
    process.argv[2] = 'synthetic-backend'
    try { require(${JSON.stringify(__filename)}) }
    catch(error) {
      if(error.message.startsWith('Native queue fixture requires Unix storage isolation')) process.exit(0)
      console.error(error); process.exit(1)
    }
    process.exit(1)
  `], {encoding:'utf8',timeout:10000})
  assert.strictEqual(probe.status,0,probe.stderr)
}

// The same production bridge can be driven through real Rust stdin/stdout.
// Explicit binary argument keeps the portable JS suite independent of a build.
if(process.argv[2]) {
  assert.notStrictEqual(process.platform,'win32','Native queue fixture requires Unix storage isolation')
  const {spawn}=require('child_process'), os=require('os')
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'omamail-queue-process-'))
  const env={...process.env,HOME:home,XDG_CONFIG_HOME:path.join(home,'config'),
    XDG_DATA_HOME:path.join(home,'data'),XDG_STATE_HOME:path.join(home,'state'),
    XDG_CACHE_HOME:path.join(home,'cache'),XDG_RUNTIME_DIR:home,TMPDIR:home}
  const run=bridge(), backend=run.backend
  const child=spawn(path.resolve(process.argv[2]),['serve'],{env,stdio:['pipe','pipe','pipe']})
  const write=backend.child.write
  backend.child.write=line=>{write(line);child.stdin.write(line)}
  let buffered='', stderr=''
  child.stdout.setEncoding('utf8')
  child.stdin.on('error',error=>{if(!child.killed) {console.error(error);process.exitCode=1}})
  child.stdout.on('data',data=>{
    buffered+=data.toString('utf8')
    let end
    while((end=buffered.indexOf('\n'))>=0) {
      const line=buffered.slice(0,end); buffered=buffered.slice(end+1)
      backend.receive(line)
    }
  })
  child.stderr.on('data',data=>stderr+=data.toString())
  const deadline=setTimeout(()=>{child.kill();console.error('Native queue test timed out');process.exitCode=1},30000)
  child.on('exit',code=>{
    clearTimeout(deadline)
    fs.rmSync(home,{recursive:true,force:true})
    if(code!==0) {console.error('Native backend failed',code,stderr);process.exitCode=1}
  })
  function call(method,params) {
    return new Promise((resolve,reject)=>backend.call(method,params,(result,error)=>error?reject(error):resolve(result)))
  }
  async function testNative() {
    const info=await call('system.info',{})
    assert.strictEqual(info.name,'omamail')
    const work=[]
    for(let i=0;i<225;i++) work.push(call('providers.list',{}))
    const text='body \u00ff\r\n'.repeat(30000)
    for(let i=0;i<24;i++) {
      if(i%3===0) work.push(new Promise((resolve,reject)=>backend.parseMessage('Subject: Test\r\n\r\n'+text,(result,error)=>{
        if(error) return reject(error)
        try {assert.strictEqual(result.body.size,text.length);resolve()} catch(error) {reject(error)}
      })))
      else if(i%3===1) work.push(new Promise((resolve,reject)=>backend.putBodyCache('test@example.org','body-'+i,{text},
        (result,error)=>error?reject(error):resolve(result))).then(()=>call('cache.bodyRead',{accountId:'test@example.org',id:'body-'+i}))
        .then(body=>assert.strictEqual(body.text,text)))
      else work.push(call('cache.resourcePut',{accountId:'test@example.org',id:'resource-'+i,resource:{id:'resource-'+i,
        payload:{mimeType:'text/plain',headers:[],body:{data:Buffer.from(text).toString('base64url')}}}}))
    }
    await Promise.all(work)
    assert.strictEqual(run.errors.length,0)
    assert.strictEqual(backend.uploadQueue.bytes,0)
    assert.strictEqual(backend.uploadQueue.active.length+backend.uploadQueue.waiting.length,0)
    assert.strictEqual(Object.keys(backend.pending).length+backend.queued.length,0)
    await call('system.quit',{})
    child.stdin.end()
    console.log('real Rust transport: 225 RPCs plus 24 mixed large uploads passed')
  }
  testNative().catch(error=>{console.error(error);process.exitCode=1;backend.failPending('test failed');child.kill()})
}
