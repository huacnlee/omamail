#!/usr/bin/env python3
"""Bounded cached-reader concurrency through the real production QML transport."""
import argparse, hashlib, json, math, os, platform, shutil, signal, statistics, subprocess, tempfile, time, tomllib
from pathlib import Path
from corpus import corpus
from reader_pipeline import HERE, ROOT, sha

QML=r'''
import QtQuick
import Quickshell
import "backend" as BackendModule
import "message/Message.js" as Message
Scope {
 id:root
 property var cases: PAYLOAD
 property int rounds: ROUNDS
 property int operations: OPERATIONS
 property var levels:[1,2,4,8]
 property int caseIndex:0
 property int levelIndex:0
 property int round:-1
 property int sequence:0
 property int nextOperation:0
 property int completed:0
 property int inFlight:0
 property int peak:0
 property int seedIndex:0
 property var seedResource:null
 property var reference:[]
 property var replies:[]
 property var latencies:[]
 property var samples:[]
 property real started:0
 property bool began:false
 property string account:"concurrency-benchmark@example.test"
 property real clock:1788825600000
 function fail(error){console.log("CONCURRENCY_ERROR "+JSON.stringify(error));Qt.quit()}
 function id(index){return cases[caseIndex].name+"-"+index}
 function call(method,params,callback){backend.call(method,params,function(value,error){if(error){root.fail({method:method,error:error});return}callback(value)})}
 function open(index,callback){call("reader.open",{accountId:account,id:id(index),requestId:"concurrent-"+(++sequence),cacheOnly:true,now:clock,
   options:{allowRemoteImages:false,remoteImageData:null,withReader:true}},callback)}
 function display(value){return JSON.stringify({id:value.id,threadId:value.threadId,labelIds:value.labelIds,
   hasHtml:value.hasHtml,nativeSummary:value.nativeSummary,nativeContent:value.nativeContent,
   nativeRender:value.nativeRender,payload:value.payload,cachedInvite:value.cachedInvite})}
 function nextCase(){
  if(caseIndex>=cases.length){backend.shutdown(function(error){if(error)root.fail(error);else{console.log("CONCURRENCY_DONE");Qt.quit()}});return}
  var raw=Message.bytesToLatin1(Message.base64ToBytes(cases[caseIndex].raw))
  backend.parseMessage(raw,function(payload,error){
   if(error){root.fail(error);return}
   root.seedResource={id:"",threadId:"",labelIds:[],internalDate:String(root.clock),payload:payload}
   root.seedIndex=0;root.reference=[];root.seed()
  })
 }
 function seed(){
  if(seedIndex===8){root.seedResource=null;root.seedIndex=0;root.warm();return}
  seedResource.id=id(seedIndex);seedResource.threadId=id(seedIndex)
  call("cache.resourcePut",{accountId:account,id:id(seedIndex),resource:seedResource},function(){root.seedIndex++;root.seed()})
 }
 function warm(){
  if(seedIndex===8){root.levelIndex=0;root.round=-1;root.samples=[];Qt.callLater(root.beginRound);return}
  var index=seedIndex
  open(index,function(value){
   if(!value||value.id!==root.id(index)||!value.nativeContent||!value.nativeRender){root.fail("Invalid warm projection");return}
   root.reference[index]=root.display(value);root.seedIndex++;root.warm()
  })
 }
 function beginRound(){
  root.nextOperation=0;root.completed=0;root.inFlight=0;root.peak=0;root.replies=[];root.latencies=[]
  root.started=Date.now();root.pump()
 }
 function pump(){
  // Each eight-ID group completes before its IDs are reused: simultaneous
  // operations refer to distinct messages at every concurrency level.
  var groupEnd=Math.min(operations,(Math.floor(completed/8)+1)*8)
  while(inFlight<levels[levelIndex]&&nextOperation<groupEnd){launch(nextOperation++)}
 }
 function launch(index){
  root.inFlight++;root.peak=Math.max(root.peak,root.inFlight)
  var start=Date.now(), expected=id(index%8)
  open(index%8,function(value){
   var end=Date.now()
   if(!value||value.id!==expected||!value.nativeContent||!value.nativeRender){root.fail("Wrong reader response identity");return}
   root.latencies[index]=(end-start)*1000
   root.replies[index]=value
   root.inFlight--;root.completed++
   if(root.completed===root.operations){root.finishRound(end);return}
   root.pump()
  })
 }
 function finishRound(end){
  var elapsed=(end-started)*1000
  // Full parity is outside the round timer and after all outstanding calls.
  // A bounded batch of response references is retained until validation.
  for(var i=0;i<operations;i++){
   if(display(replies[i])!==reference[i%8]){fail("Display parity failed: "+id(i%8));return}
  }
  if(round>=0)samples.push({elapsedUs:elapsed,latenciesUs:latencies,peakInFlight:peak,parityChecked:operations})
  replies=[];latencies=[];round++
  if(round<rounds){Qt.callLater(root.beginRound);return}
  console.log("CONCURRENCY_ROW "+JSON.stringify({name:cases[caseIndex].name,concurrency:levels[levelIndex],samples:samples}))
  root.levelIndex++;root.round=-1;root.samples=[]
  if(root.levelIndex<levels.length){Qt.callLater(root.beginRound);return}
  var text=JSON.stringify({name:cases[caseIndex].name,reference:reference}),total=Math.ceil(text.length/16384)
  for(var j=0;j<total;j++)console.log("CONCURRENCY_REFERENCE "+JSON.stringify({index:j,total:total,data:text.slice(j*16384,(j+1)*16384)}))
  root.caseIndex++;Qt.callLater(root.nextCase)
 }
 BackendModule.Backend {
  id:backend
  executable:BINARY
  expectedVersion:VERSION
  expectedApiVersion: 1
  onReadyChanged:if(ready&&!root.began){root.began=true;Qt.callLater(root.nextCase)}
  onFailureChanged:if(failure!=="")root.fail(failure)
 }
 Timer{interval:600000;running:true;onTriggered:root.fail("Whole benchmark deadline")}
}
'''

def percentile95(values):
    return sorted(values)[math.ceil(len(values)*.95)-1]

def render(report):
    lines=['# Cached reader concurrency: completed QML callbacks', '',
        f"Measured {report['date']}: {report['rounds']} timed rounds × {report['operationsPerRound']} operations, after one untimed warmup round per level.", '',
        '| Case | In flight | Operations/s | Throughput / serial | Callback median / p95 ms | Full display checks |',
        '|---|---:|---:|---:|---:|---:|']
    for row in report['results']:
        lines.append(f"| {row['name']} | {row['concurrency']} | {row['operationsPerSecond']:.1f} | {row['throughputRatio']:.2f}× | {row['medianLatencyUs']/1000:.3f} / {row['p95LatencyUs']/1000:.3f} | {row['parityChecked']} |")
    if report.get('transportComparison'):
        lines += ['', 'Before/after QML transport change, same frozen Rust executable and full display reference hashes:', '',
            '| Case | In flight | Before ops/s | After ops/s | Throughput ratio | Before / after p95 ms |', '|---|---:|---:|---:|---:|---:|']
        for row in report['transportComparison']:
            lines.append(f"| {row['name']} | {row['concurrency']} | {row['beforeOperationsPerSecond']:.1f} | {row['afterOperationsPerSecond']:.1f} | {row['ratio']:.2f}× | {row['beforeP95Us']/1000:.3f} / {row['afterP95Us']/1000:.3f} |")
    lines += ['', 'All measurements use `reader.open(cacheOnly=true)` through unchanged production Backend.qml/Upload.js/Chunks.js/Wire.js and one frozen release backend. Eight distinct message IDs per case are parsed, written to the isolated resource cache, then opened once before measurement to warm the renderer and establish full display references. Each operation still follows the real native cached-reader path. This measures cached resources and a warm renderer; it does not measure cold rendering, live mail networking, image fetching, follow-on model.apply, QML layout, or painting.', '',
        'Every level completes the same ID sequence and number of operations. IDs are used in groups of eight, with a group finishing before reuse, so simultaneously outstanding calls address different messages. The concurrency limit changes; input size, account, fixed clock, image policy and binary do not. Levels run in fixed 1/2/4/8 order on a shared desktop. Throughput is total operations divided by total round time; ratios use the same case at concurrency 1. Per-callback latency starts immediately before reader.open and ends at its completed QML callback, including queueing, disk/cache work, native preparation, serialization and transport/QML decoding. p95 is across individual callbacks, not batch-average latencies.', '',
        'Every timed reply is checked for the requested ID immediately, then its complete display projection is compared with its per-ID reference after all calls in the round finish. Only opaque readerKey is excluded; summary, body, attachments, rendered documents, render policy/revision and calendar payload are compared exactly. No result is sampled or skipped. Untimed parity checks hold at most one bounded round of reply references, which can influence allocation/GC; that retention is identical at each concurrency level. Reference JSON strings remain in memory. Resource seeding, reference construction and parity serialization are excluded from the timers.', '',
        'Date.now has 1 ms resolution, limiting sub-millisecond comparisons; a reported 0 ms means below that resolution, not zero latency. The small number of rounds characterizes this run, not a confidence interval or a guarantee under another workload. Throughput flattening and increased callback latency can expose a shared processing/serialization bottleneck; these numbers alone do not identify a particular mutex or prove mail-network concurrency.', '',
        f"CPU: {report['cpu']}; load before/after: {report['loadBefore']} / {report['loadAfter']}. Versions: {report['versions']}.", '',
        'The executable and QML modules are copied and hashed before running. Source hashes describe the checkout snapshot, not attestation that an externally supplied binary was built from it. Raw round durations, every callback latency, peak concurrency and parity counts are in the adjacent JSON.', '',
        'Reproduce: `python3 benchmarks/mail/reader_concurrency.py --binary target/release/omamail`. Smoke: add `--rounds 3 --cases small_plain newsletter_html --output /tmp/reader-concurrency-smoke.json`.']
    return '\n'.join(lines)+'\n'

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--binary',type=Path,required=True,help='An already built release binary; this harness never compiles')
    parser.add_argument('--rounds',type=int,default=7)
    parser.add_argument('--operations',type=int,default=16,choices=[8,16,32])
    parser.add_argument('--cases',nargs='+',choices=[c['name'] for c in corpus()])
    parser.add_argument('--output',type=Path,default=HERE/'reader-concurrency-results.json')
    parser.add_argument('--ui-root',type=Path,default=ROOT/'ui',help='Frozen directory containing backend and message modules')
    parser.add_argument('--before',type=Path,help='Prior transport report; require same executable, inputs and exact output hashes')
    args=parser.parse_args()
    if not 3<=args.rounds<=31:parser.error('rounds must be3..31')
    cases=[c for c in corpus() if not args.cases or c['name'] in args.cases]
    env={k:v for k,v in os.environ.items() if not k.startswith(('QML','QS_'))}
    env.pop('WAYLAND_DISPLAY',None)
    env.update(QT_QPA_PLATFORM='offscreen',QT_QUICK_BACKEND='software',QT_QPA_PLATFORMTHEME='')
    versions={'qt':subprocess.check_output(['/usr/lib/qt6/bin/qml','--version'],env=env,text=True,stderr=subprocess.DEVNULL).strip(),
        'quickshell':subprocess.check_output([shutil.which('qs'),'--version'],env=env,text=True,stderr=subprocess.DEVNULL).strip()}
    version=tomllib.loads((ROOT/'Cargo.toml').read_text())['package']['version']
    hashes={str(f.relative_to(ROOT)):sha(f) for f in sorted((ROOT/'src').rglob('*')) if f.is_file()}
    harness={f.name:sha(f) for f in [Path(__file__),HERE/'reader_pipeline.py',HERE/'corpus.py']}
    with tempfile.TemporaryDirectory(prefix='omamail-reader-concurrency-') as folder:
        temp=Path(folder);binary=temp/'omamail';shutil.copy2(args.binary,binary);binary_hash=sha(binary)
        for module in ['backend','message']:
            shutil.copytree(args.ui_root/module,temp/module)
            for f in (temp/module).rglob('*'):
                if f.is_file():hashes[str(Path('ui')/f.relative_to(temp))]=sha(f)
        for key in ['HOME','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_RUNTIME_DIR']:
            path=temp/key.lower();path.mkdir(mode=0o700);env[key]=str(path)
        config=Path(env['XDG_CONFIG_HOME'])/'omamail';config.mkdir(mode=0o700)
        registry=config/'accounts.json';registry.write_text(json.dumps({'version':1,'accounts':[{'provider':'gmail','email':'concurrency-benchmark@example.test'}],'activeId':'concurrency-benchmark@example.test'}));registry.chmod(0o600)
        qml=QML.replace('PAYLOAD',json.dumps(cases)).replace('ROUNDS',str(args.rounds)).replace('OPERATIONS',str(args.operations)).replace('BINARY',json.dumps(str(binary))).replace('VERSION',json.dumps(version))
        (temp/'shell.qml').write_text(qml)
        start=time.perf_counter();load=os.getloadavg()
        child=subprocess.Popen([shutil.which('qs'),'--no-color','--path',str(temp/'shell.qml')],env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,start_new_session=True)
        try:output,_=child.communicate(timeout=620)
        except subprocess.TimeoutExpired:
            try:os.killpg(child.pid,signal.SIGKILL)
            except ProcessLookupError:pass
            child.communicate();raise
        if child.returncode or 'CONCURRENCY_ERROR' in output or 'CONCURRENCY_DONE' not in output:raise RuntimeError(output[-6000:])
        rows=[json.loads(line.split('CONCURRENCY_ROW ',1)[1]) for line in output.splitlines() if 'CONCURRENCY_ROW ' in line]
        if [(r['name'],r['concurrency']) for r in rows]!=[(c['name'],level) for c in cases for level in [1,2,4,8]]:raise RuntimeError('Missing benchmark rows')
        references={};parts=[];total=None
        for line in output.splitlines():
            if 'CONCURRENCY_REFERENCE ' not in line:continue
            part=json.loads(line.split('CONCURRENCY_REFERENCE ',1)[1])
            if not parts:total=part['total']
            if part['index']!=len(parts) or part['total']!=total:raise RuntimeError('Broken reference transfer')
            parts.append(part['data'])
            if len(parts)==total:
                text=''.join(parts).encode('utf-16','surrogatepass').decode('utf-16')
                value=json.loads(text);parts=[];total=None
                if len(value['reference'])!=8:raise RuntimeError('Missing reference IDs')
                references[value['name']]=[hashlib.sha256(v.encode('utf-8')).hexdigest() for v in value['reference']]
        if parts or set(references)!={c['name'] for c in cases}:raise RuntimeError('Missing display references')
        for row in rows:
            samples=row['samples']
            if len(samples)!=args.rounds:raise RuntimeError('Missing rounds')
            for sample in samples:
                if len(sample['latenciesUs'])!=args.operations or sample['parityChecked']!=args.operations or sample['peakInFlight']!=row['concurrency']:raise RuntimeError('Incomplete round validation')
            durations=[s['elapsedUs'] for s in samples];latencies=[value for s in samples for value in s['latenciesUs']]
            row.update(operationsPerSecond=len(latencies)*1_000_000/sum(durations),medianLatencyUs=statistics.median(latencies),p95LatencyUs=percentile95(latencies),parityChecked=len(latencies))
            serial=next(r for r in rows if r['name']==row['name'] and r['concurrency']==1)
            row['throughputRatio']=row['operationsPerSecond']/serial['operationsPerSecond']
        report={'date':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'rounds':args.rounds,'operationsPerRound':args.operations,'resourceIdsPerCase':8,'clock':1788825600000,'imagePolicy':{'allowRemoteImages':False,'remoteImageData':None,'withReader':True},'cacheMode':'warm resource and renderer cache','referenceSha256':references,'binarySha256':binary_hash,'harnessSha256':harness,'sourceSha256':hashes,'versions':versions,'cpu':next(l.split(':',1)[1].strip() for l in Path('/proc/cpuinfo').read_text().splitlines() if l.startswith('model name')),'platform':platform.platform(),'loadBefore':load,'loadAfter':os.getloadavg(),'wallSeconds':time.perf_counter()-start,'corpus':[{k:v for k,v in c.items() if k not in ['raw','html']} for c in cases],'results':rows}
    if args.before:
        before=json.loads(args.before.read_text())
        for key in ['rounds','operationsPerRound','resourceIdsPerCase','clock','imagePolicy','cacheMode','binarySha256','harnessSha256','versions','cpu','corpus','referenceSha256']:
            if before.get(key)!=report[key]:raise RuntimeError('Before/after benchmark mismatch: '+key)
        old={(r['name'],r['concurrency']):r for r in before['results']}
        report['transportComparison']=[]
        for row in rows:
            previous=old[(row['name'],row['concurrency'])]
            report['transportComparison'].append({'name':row['name'],'concurrency':row['concurrency'],
                'beforeOperationsPerSecond':previous['operationsPerSecond'],'afterOperationsPerSecond':row['operationsPerSecond'],
                'ratio':row['operationsPerSecond']/previous['operationsPerSecond'],
                'beforeP95Us':previous['p95LatencyUs'],'afterP95Us':row['p95LatencyUs']})
        report['beforeReportSha256']=sha(args.before)
        report['changedTransportFiles']={key:{'before':value,'after':hashes.get(key)} for key,value in before['sourceSha256'].items()
            if key.startswith('ui/') and hashes.get(key)!=value}
    args.output.write_text(json.dumps(report,indent=2)+'\n');args.output.with_suffix('.md').write_text(render(report));print(render(report))
if __name__=='__main__':main()
