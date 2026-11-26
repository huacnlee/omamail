#!/usr/bin/env python3
"""Cached-ID→QML display callback: three real Rust bridge arrangements, no network."""
import argparse, hashlib, json, os, platform, shutil, signal, subprocess, tempfile, time, tomllib
from pathlib import Path
from corpus import corpus
from run import html_semantics, difference, digest, stats
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
ENGINES = ['resource_bridge', 'prepared_bridge', 'reader_open']
QML = r'''
import QtQuick
import Quickshell
import "backend" as BackendModule
import "message/Message.js" as Message
Scope {
 id: root
 property var cases: PAYLOAD
 property string engine: ENGINE
 property int sampleCount: SAMPLES
 property int index: 0
 property bool began: false
 property int sample: -6
 property int operation: 0
 property int batch: 1
 property real started: 0
 property real cold: 0
 property var samples: []
 property var output: null
 property var logical: []
 property bool measuringBytes: false
 property string account: "reader-benchmark@example.test"
 property real clock: 1788825600000
 function fail(error) {console.log("READER_ERROR "+JSON.stringify(error));Qt.quit()}
 function call(method, params, done) {
  if(measuringBytes)logical.push({method:method,direction:"request",bytes:Message.utf8Bytes(JSON.stringify(params)).length})
  backend.call(method,params,function(value,error){
   if(error){root.fail({method:method,error:error});return}
   if(root.measuringBytes)root.logical.push({method:method,direction:"response",bytes:Message.utf8Bytes(JSON.stringify(value)).length})
   done(value)
  })
 }
 function nextCase() {
  if(index>=cases.length){backend.shutdown(function(error){if(error)root.fail(error);else{console.log("READER_DONE");Qt.quit()}});return}
  // Seeding is outside every timer. Both engines parse and persist identical bytes.
  var item=cases[index]
  var raw=Message.bytesToLatin1(Message.base64ToBytes(item.raw))
  backend.parseMessage(raw,function(payload,error){
   if(error){root.fail(error);return}
   call("cache.resourcePut",{accountId:account,id:item.name,resource:{id:item.name,threadId:item.name,labelIds:[],internalDate:String(root.clock),payload:payload}},function(){
    root.sample=-6;root.operation=0;root.samples=[];root.logical=[];root.measuringBytes=false
    root.batch=item.bytes<=65536?16:1
    root.next()
   })
  })
 }
 function options(htmlBody) {return {allowRemoteImages:false,remoteImageData:null,withReader:true,withPlainText:htmlBody}}
 function display(prepared, rendered) {
  var body=prepared.body
  if(rendered.plainText)body={text:rendered.plainText.text,source:"html",bodyDirection:rendered.plainText.bodyDirection||""}
  return {summary:prepared.summary,body:body,attachments:prepared.attachments,render:rendered}
 }
 function run(done) {
  var id=cases[index].name
  if(engine==="reader_open"){
   call("reader.open",{accountId:account,id:id,requestId:"bench-"+index+"-"+sample+"-"+operation,cacheOnly:true,now:clock,
    options:{allowRemoteImages:false,remoteImageData:null,withReader:true}},function(value){
     if(!value||!value.nativeContent){root.fail("Cache miss");return}
     var prepared=value.nativeContent
     if(!prepared.summary)prepared.summary=value.nativeSummary
     done(display(prepared,value.nativeRender))
   });return
  }
  function render(prepared) {
   call("message.render",{accountId:account,messageId:id,html:prepared.html,options:options(prepared.body.source==="html")},function(value){done(display(prepared,value))})
  }
  if(engine==="prepared_bridge"){
   call("message.prepareCached",{accountId:account,id:id,now:clock},function(value){if(!value){root.fail("Cache miss");return}render(value.nativeContent)})
  }else{
   call("cache.resourceRead",{accountId:account,id:id},function(resource){if(!resource){root.fail("Cache miss");return}
    call("message.prepare",{message:resource,now:clock},render)
   })
  }
 }
 function next() {
  var count=sample<0||measuringBytes?1:batch
  if(operation===0)started=Date.now()
  run(function(value){
   var ended=Date.now()
   root.output=value
   root.operation++
   if(root.operation<count){root.next();return}
   if(root.measuringBytes){root.report();return}
   var elapsed=(ended-root.started)*1000/count
   if(root.sample===-6)root.cold=elapsed
   if(root.sample>=0)root.samples.push(elapsed)
   root.operation=0;root.sample++
   if(root.sample<sampleCount){root.next();return}
   root.measuringBytes=true;root.next()
  })
 }
 function report() {
  var row={name:cases[index].name,engine:engine,coldUs:cold,samplesUs:samples,batch:batch,result:output,logicalPayloads:logical}
  var text=JSON.stringify(row),total=Math.ceil(text.length/32768)
  for(var i=0;i<total;i++)console.log("READER_PART "+JSON.stringify({index:i,total:total,data:text.slice(i*32768,(i+1)*32768)}))
  console.log("READER_PROGRESS "+engine+"/"+cases[index].name)
  root.measuringBytes=false;root.output=null;root.index++;Qt.callLater(root.nextCase)
 }
 BackendModule.Backend {
  id:backend
  executable:BINARY
  expectedVersion:VERSION
  expectedApiVersion: 1
  onReadyChanged:if(ready&&!root.began){root.began=true;Qt.callLater(root.nextCase)}
  onFailureChanged:if(failure!=="")root.fail(failure)
 }
 Timer{interval:900000;running:true;onTriggered:root.fail("Whole run deadline")}
}
'''

def canonical(value):
    result = dict(value)
    rendered = html_semantics(value['render'])
    # The serialized HTML is a duplicate of the validated document tree. New
    # projections may omit it; compare every document node/attribute instead.
    rendered.pop('html', None)
    rendered.pop('revision', None)
    if rendered.get('reader'):rendered['reader'].pop('html', None)
    result['render'] = rendered
    return result

def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()

def render(report):
    lines=['# Cached reader ID → completed QML display callback', '',
        f"Measured {report['date']}; {report['samples']} samples after five warmups. Milliseconds per operation.", '',
        '| Case | Full-resource bridge median / p95 | Prepared-cache bridge median / p95 | Native reader median / p95 | Prepared / native | Equal display |',
        '|---|---:|---:|---:|---:|---|']
    for row in report['results']:
        cells=[f"{row[e]['medianUs']/1000:.3f} / {row[e]['p95Us']/1000:.3f}" for e in ENGINES]
        lines.append('| '+row['name']+' | '+' | '.join(cells)+f" | {row['preparedSpeedup']:.2f}× | {'yes' if row['semanticMatch'] else 'NO'} |")
    if report.get('nativeComparison'):
        lines += ['', 'Native reader before/after this optimization, with equivalent display output:', '',
            '| Case | Before median / p95 ms | After median / p95 ms | Before / after |', '|---|---:|---:|---:|']
        for row in report['nativeComparison']:
            lines.append(f"| {row['name']} | {row['before']['medianUs']/1000:.3f} / {row['before']['p95Us']/1000:.3f} | {row['after']['medianUs']/1000:.3f} / {row['after']['p95Us']/1000:.3f} | {row['speedup']:.2f}× |")
    lines += ['', 'First call per case (empty in-process render cache; filesystem cache warmed by seeding):', '',
        '| Case | Full-resource bridge ms | Prepared-cache bridge ms | Native reader ms |', '|---|---:|---:|---:|']
    for row in report['results']:
        lines.append('| '+row['name']+' | '+' | '.join(f"{row[e]['coldUs']/1000:.3f}" for e in ENGINES)+' |')
    lines += ['', 'Logical JSON payload totals per operation, request + response, measured separately from timing:', '',
        '| Case | Full-resource bridge bytes | Prepared-cache bridge bytes | Native reader bytes |', '|---|---:|---:|---:|']
    for row in report['results']:
        lines.append('| '+row['name']+' | '+' | '.join(str(sum(p['bytes'] for p in row[e]['logicalPayloads'])) for e in ENGINES)+' |')
    lines += ['', 'These are three arrangements of the **same Rust release executable** and production QML transport. Full-resource bridge: `cache.resourceRead → message.prepare → message.render`. Prepared-cache bridge (the previous optimized cache path): `message.prepareCached → message.render`. Native reader: `reader.open(cacheOnly=true)`. This is not a comparison against the original JavaScript application, a network benchmark, or UI painting latency.', '',
        'All paths start with the same synthetic account ID and message ID, read the same persisted resource, and end when equivalent prepared display data reaches the completed QML callback. Timers include disk reads, JSON serialization, UTF-8/base64 uploads where needed, RPC dispatch, preparation/rendering, response chunking/reassembly and callback dispatch. Resource parsing/seeding, process startup, follow-on model.apply calls, QML layout/painting, remote-image fetching, output comparison and diagnostic byte counting are outside timing. This is callback completion, not click-to-photon latency. There are no real accounts, network reads, remote-image loads or AI requests.', '',
        'Each engine starts in a fresh process, so its first call for each case has an empty in-process render cache. Resource seeding warms the OS filesystem cache: **coldUs is not cold-device I/O**. Five further calls warm the engine; the table measures repeated reads with a warm render cache and unchanged image policy. Render-cache bypass/forced-cold timings and image-policy-changing rerenders are not measured. Small cases use batches of 16 sequential operations with the same batch size for all engines; large cases use one. Date.now has 1 ms resolution; p95 is across per-batch averages, not individual-call tail latency. Engines run sequentially on a shared desktop; order, scheduling and GC can influence results.', '',
        'Display parity compares summary, decoded body/direction, attachment descriptors and the complete normalized rendered document/reader tree and policy fields. Opaque reader keys, render revision identity metadata and duplicated serialized HTML are excluded; HTML tree nodes, attributes and text are compared. Logical JSON payload byte counts come from one extra untimed operation and exclude JSON-RPC envelopes, base64 expansion, chunk framing and protocol overhead; they are not physical pipe-byte measurements.', '',
        f"Build provenance: {report.get('buildNote', 'See binary hash and build mode in JSON')}. CPU: {report['cpu']}. Load before/after: {report['loadBefore']} / {report['loadAfter']}. Versions: {report['versions']}.", '',
        'The executable and QML modules are copied before the run and hashed; later builds cannot replace the executable being measured. With --binary, source hashes describe the checkout snapshot rather than proving that the supplied executable was built from it. Raw samples, cold calls, logical payload counts, corpus hashes, source hashes and parity digests are in the adjacent JSON file.', '',
        'Reproduce: `python3 benchmarks/mail/reader_pipeline.py`. Use `--samples 3 --output /tmp/reader-smoke.json` for a smoke test.']
    return '\n'.join(lines)+'\n'

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--samples',type=int,default=31)
    p.add_argument('--cases',nargs='+',choices=[c['name'] for c in corpus()])
    p.add_argument('--output',type=Path,default=HERE/'reader-pipeline-results.json')
    p.add_argument('--binary',type=Path,help='Use an already built release executable; skip cargo build')
    p.add_argument('--build-note',default='Built from current checkout' ,help='Describe provenance of a supplied frozen executable')
    p.add_argument('--before',type=Path,help='Compare native results to this prior report; require exact display parity')
    args=p.parse_args()
    if args.binary and args.build_note == 'Built from current checkout':args.build_note='Supplied executable; checkout hashes are not binary source provenance'
    if not 3<=args.samples<=1000:p.error('samples must be 3..1000')
    cases=[c for c in corpus() if not args.cases or c['name'] in args.cases]
    if args.binary is None:subprocess.run(['cargo','build','--locked','--release','--bin','omamail'],cwd=ROOT,check=True)
    binary=(args.binary or ROOT/'target/release/omamail').resolve()
    version=tomllib.loads((ROOT/'Cargo.toml').read_text())['package']['version']
    env={k:v for k,v in os.environ.items() if not k.startswith(('QML','QS_'))}
    env.pop('WAYLAND_DISPLAY',None)
    env.update(QT_QPA_PLATFORM='offscreen',QT_QUICK_BACKEND='software',QT_QPA_PLATFORMTHEME='')
    versions={'rust':subprocess.check_output(['rustc','--version'],text=True).strip(),
        'qt':subprocess.check_output(['/usr/lib/qt6/bin/qml','--version'],env=env,text=True,stderr=subprocess.DEVNULL).strip(),
        'quickshell':subprocess.check_output([shutil.which('qs'),'--version'],env=env,text=True,stderr=subprocess.DEVNULL).strip()}
    hashes={str(f.relative_to(ROOT)):sha(f) for base in ['src','ui/backend','ui/message'] for f in sorted((ROOT/base).rglob('*')) if f.is_file()}
    harness_hashes={f.name:sha(f) for f in [Path(__file__),HERE/'corpus.py',HERE/'run.py']}
    start=time.perf_counter();load=os.getloadavg();rows=[]
    with tempfile.TemporaryDirectory(prefix='omamail-reader-bench-') as folder:
        temp=Path(folder)
        frozen=temp/'omamail';shutil.copy2(binary,frozen);binary_hash=sha(frozen)
        for module in ['backend','message']:
            shutil.copytree(ROOT/'ui'/module,temp/module)
            for f in (temp/module).rglob('*'):
                if f.is_file():hashes[str(Path('ui')/f.relative_to(temp))]=sha(f)
        for key in ['HOME','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_RUNTIME_DIR']:
            directory=temp/key.lower();directory.mkdir(mode=0o700);env[key]=str(directory)
        config=Path(env['XDG_CONFIG_HOME'])/'omamail';config.mkdir(mode=0o700)
        registry=config/'accounts.json';registry.write_text(json.dumps({'version':1,'accounts':[{'provider':'gmail','email':'reader-benchmark@example.test'}],'activeId':'reader-benchmark@example.test'}));registry.chmod(0o600)
        for engine in ENGINES:
            text=QML.replace('PAYLOAD',json.dumps(cases)).replace('SAMPLES',str(args.samples)).replace('ENGINE',json.dumps(engine)).replace('BINARY',json.dumps(str(frozen))).replace('VERSION',json.dumps(version))
            (temp/'shell.qml').write_text(text)
            child=subprocess.Popen([shutil.which('qs'),'--no-color','--path',str(temp/'shell.qml')],env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,start_new_session=True)
            try:output,_=child.communicate(timeout=920)
            except subprocess.TimeoutExpired:
                # communicate() has not reaped the timed-out leader: its group
                # identity is still reserved. Never signal a successfully reaped PID.
                try:os.killpg(child.pid,signal.SIGKILL)
                except ProcessLookupError:pass
                child.communicate()
                raise
            if child.returncode or 'READER_ERROR' in output or 'READER_DONE' not in output:raise RuntimeError(output[-6000:])
            parts=[];total=None;found=[]
            for line in output.splitlines():
                if 'READER_PART ' not in line:continue
                part=json.loads(line.split('READER_PART ',1)[1])
                if not parts:total=part['total']
                if part['index']!=len(parts) or part['total']!=total:raise RuntimeError('Broken benchmark transfer')
                parts.append(part['data'])
                if len(parts)==total:found.append(json.loads(''.join(parts)));parts=[];total=None
            if parts or [(r['engine'],r['name']) for r in found]!=[(engine,c['name']) for c in cases]:raise RuntimeError('Missing benchmark rows')
            rows.extend(found)
            print(engine+' finished',flush=True)
    results=[]
    for case in cases:
        group={r['engine']:r for r in rows if r['name']==case['name']}
        outputs={e:canonical(group[e]['result']) for e in ENGINES}
        entry={'name':case['name'],'semanticMatch':all(outputs[e]==outputs[ENGINES[0]] for e in ENGINES),
            'differences':{e:difference(outputs[ENGINES[0]],outputs[e]) for e in ENGINES},'digests':{e:digest(outputs[e]) for e in ENGINES}}
        for e in ENGINES:
            if len(group[e]['samplesUs'])!=args.samples:raise RuntimeError('Missing samples')
            entry[e]={**stats(group[e]),'batch':group[e]['batch'],'logicalPayloads':group[e]['logicalPayloads']}
        entry['preparedSpeedup']=entry['prepared_bridge']['medianUs']/entry['reader_open']['medianUs']
        results.append(entry)
    report={'date':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'samples':args.samples,'cpu':next(l.split(':',1)[1].strip() for l in Path('/proc/cpuinfo').read_text().splitlines() if l.startswith('model name')),'platform':platform.platform(),'versions':versions,'loadBefore':load,'loadAfter':os.getloadavg(),'wallSeconds':time.perf_counter()-start,'binarySha256':binary_hash,'buildMode':'prebuilt' if args.binary else 'cargo-release','sourceSha256':hashes,'harnessSha256':harness_hashes,'corpus':[{k:v for k,v in c.items() if k not in ['raw','html']} for c in cases],'results':results}
    report['buildNote']=args.build_note
    report['clock']=1788825600000
    report['imagePolicy']={'allowRemoteImages':False,'remoteImageData':None,'withReader':True}
    report['cacheMode']='warm in-process render cache; OS cache warmed by seeding'
    if args.before:
        before=json.loads(args.before.read_text())
        if before['corpus']!=report['corpus'] or before['samples']!=report['samples']:
            raise RuntimeError('Before/after corpus or sample counts differ')
        for field in ['versions','cpu','clock','imagePolicy','cacheMode','harnessSha256']:
            if before.get(field)!=report[field]:raise RuntimeError('Before/after measurement contract differs: '+field)
        old_ui={k:v for k,v in before['sourceSha256'].items() if k.startswith('ui/')}
        new_ui={k:v for k,v in report['sourceSha256'].items() if k.startswith('ui/')}
        if old_ui!=new_ui:raise RuntimeError('Before/after QML transport differs')
        old={row['name']:row for row in before['results']}
        comparison=[]
        for row in results:
            previous=old[row['name']]
            if not previous['semanticMatch'] or previous['digests']['reader_open']!=row['digests']['reader_open']:
                raise RuntimeError('Before/after display output differs: '+row['name'])
            comparison.append({'name':row['name'],'before':previous['reader_open'],'after':row['reader_open'],
                'speedup':previous['reader_open']['medianUs']/row['reader_open']['medianUs']})
        report['nativeComparison']=comparison
        report['beforeBinarySha256']=before['binarySha256']
        report['beforeReportSha256']=sha(args.before)
        report['beforeBuildNote']=before.get('buildNote','Not recorded')
    args.output.write_text(json.dumps(report,indent=2)+'\n');args.output.with_suffix('.md').write_text(render(report));print(render(report))
    if not all(r['semanticMatch'] for r in results):raise SystemExit('Display mismatch: timings are not equivalent-work evidence')
if __name__=='__main__':main()
