#!/usr/bin/env python3
"""Synthetic response benchmark using the current Rust writer and real QML bridge."""
import hashlib,json,os,platform,shutil,signal,statistics,subprocess,tempfile,time,tomllib
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
HERE=Path(__file__).resolve().parent

def stats(values):
    s=sorted(values)
    return {'medianMs':statistics.median(s),'p95Ms':s[min(len(s)-1, int(len(s)*.95))],'samplesMs':values}

def main():
    protocol=(ROOT/'src/backend/protocol.rs').read_text()
    writer=protocol[protocol.index('fn reply('):protocol.index('#[cfg(test)]')]
    constants=protocol[protocol.index('pub const MAX_FRAME'):protocol.index('const MAX_IN_FLIGHT')]
    version=tomllib.loads((ROOT/'Cargo.toml').read_text())['package']['version']
    root_lock=tomllib.loads((ROOT/'Cargo.lock').read_text())
    serde_version=next(p['version'] for p in root_lock['package'] if p['name']=='serde_json')
    def command_version(args):
        return subprocess.check_output(args,text=True,stderr=subprocess.STDOUT).strip()
    versions={'rustc':command_version(['rustc','--version']),
              'cargo':command_version(['cargo','--version']),
              'quickshell':command_version([shutil.which('qs'),'--version']),
              'qtCore':command_version(['pkg-config','--modversion','Qt6Core']),
              'serdeJson':serde_version}
    cpu=next((line.split(':',1)[1].strip() for line in Path('/proc/cpuinfo').read_text().splitlines() if line.startswith('model name')),platform.processor())
    with tempfile.TemporaryDirectory(prefix='omamail-ipc-bench-') as temp:
        temp=Path(temp)
        (temp/'src').mkdir()
        (temp/'Cargo.toml').write_text('[package]\nname="omamail-ipc-bench"\nversion="0.0.0"\nedition="2024"\n[dependencies]\nserde_json="=' + serde_version + '"\n')
        main_rs=r'''
use std::io::{self,BufRead,Write};
use serde_json::{Value,json};
use std::time::{SystemTime,UNIX_EPOCH};
mod rpc { pub fn error(id:serde_json::Value,code:i64,message:&str)->serde_json::Value {serde_json::json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})} }
mod wire {
use super::*;
use std::sync::atomic::{AtomicU64,Ordering};
CONSTANTS
WRITER
pub fn send(out:&mut impl Write,v:Value){reply(out,v).unwrap()}
}
fn main(){
 let mut out=io::stdout().lock();
 // Allocate fixtures before the handshake, outside the measurements.
 let sizes=[1024usize,32768,262144,1048576,10485760];
 let fixtures:Vec<String>=sizes.iter().map(|s|"x".repeat(*s)).collect();
 for line in io::stdin().lock().lines(){
  let request:Value=serde_json::from_str(&line.unwrap()).unwrap();
  let method=request["method"].as_str().unwrap();
  let result=match method{
   "system.info"=>json!({"name":"omamail","protocol":1,"apiVersion":1,"version":"VERSION","methods":["bench.response"]}),
   "system.quit"=>json!({"quitReady":true}),
   "bench.response"=>{
     let index=request["params"]["index"].as_u64().unwrap() as usize;
     let started=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs_f64()*1000.0;
     json!({"startedMs":started,"data":fixtures[index].clone()})
   },
   _=>panic!("unexpected method")
  };
  wire::send(&mut out,json!({"jsonrpc":"2.0","id":request["id"],"result":result}));
  if method=="system.quit"{break}
 }
}
'''.replace('CONSTANTS',constants).replace('WRITER',writer).replace('VERSION',version)
        (temp/'src/main.rs').write_text(main_rs)
        shutil.copyfile(ROOT/'Cargo.lock',temp/'Cargo.lock')
        subprocess.run(['cargo','build','--offline','--release','--manifest-path',str(temp/'Cargo.toml'),'--target-dir',str(ROOT/'target/ipc-bench')],check=True)
        binary=ROOT/'target/ipc-bench/release/omamail-ipc-bench'
        shutil.copytree(ROOT/'ui/backend',temp/'backend')
        shutil.copytree(ROOT/'ui/message',temp/'message')
        qml=r'''
import QtQuick
import Quickshell
import "backend" as BackendModule
Scope {
 id: root
 property bool began: false
 property var sizes: [1024,32768,262144,1048576,10485760]
 property var expected: sizes.map(function(size) { return "x".repeat(size) })
 property int sizeIndex: 0
 property int sample: -5
 property int operation: 0
 property int batch: 1
 property real batchStart: 0
 property real responseSum: 0
 property var rtts: []
 property var responses: []
 property var rows: []
 function fail(message) { console.log("IPC_BENCH_ERROR "+message); Qt.quit() }
 function next() {
  if(sizeIndex>=sizes.length){
   console.log("IPC_BENCH_RESULT "+JSON.stringify(rows))
   backend.shutdown(function(error){if(error)root.fail(error.message);else Qt.quit()})
   return
  }
  batch=sizes[sizeIndex]<=32768?50:1
  if(operation===0){batchStart=Date.now();responseSum=0}
  backend.call("bench.response",{index:sizeIndex},function(result,error){
   var end=Date.now()
   if(error || !result || result.data.length!==root.sizes[root.sizeIndex]
      || result.data!==root.expected[root.sizeIndex]){
    root.fail("Response validation failed"); return
   }
   // Same-host wall clocks, sub-ms values remain limited by QML Date.now.
   var response=end-result.startedMs
   if(response < -1 || result.startedMs<root.batchStart-1){root.fail("Clock mismatch");return}
   root.responseSum+=Math.max(0,response)
   root.operation++
   if(root.operation<root.batch){root.next();return}
   if(root.sample>=0){root.rtts.push((end-root.batchStart)/root.batch);root.responses.push(root.responseSum/root.batch)}
   root.operation=0;root.sample++
   if(root.sample===31){
    root.rows.push({bytes:root.sizes[root.sizeIndex],batch:root.batch,rtt:root.rtts,response:root.responses})
    root.sizeIndex++;root.sample=-5;root.rtts=[];root.responses=[]
   }
   Qt.callLater(root.next)
  })
 }
 BackendModule.Backend {
  id: backend
  executable: BINARY
  expectedVersion: VERSION
  expectedApiVersion: 1
  onReadyChanged: if(ready&&!root.began){root.began=true;root.next()}
  onFailureChanged: if(failure!=="")root.fail(failure)
 }
 Timer { interval:240000;running:true;onTriggered:root.fail("Timeout") }
}
'''.replace('BINARY',json.dumps(str(binary))).replace('VERSION',json.dumps(version))
        (temp/'shell.qml').write_text(qml)
        env={k:v for k,v in os.environ.items() if not k.startswith(('QML','QS_'))}
        env.pop('WAYLAND_DISPLAY',None)
        for key in ['HOME','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_RUNTIME_DIR']:
            path=temp/key.lower();path.mkdir(mode=0o700);env[key]=str(path)
        env.update(QT_QPA_PLATFORM='offscreen',QT_QUICK_BACKEND='software',QT_QPA_PLATFORMTHEME='')
        load_before=os.getloadavg()
        process=subprocess.Popen([shutil.which('qs'),'--no-color','--path',str(temp/'shell.qml')],env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,start_new_session=True)
        try: output,_=process.communicate(timeout=250)
        finally:
            if process.poll() is None:os.killpg(process.pid,signal.SIGKILL);process.wait()
        if process.returncode != 0 or 'IPC_BENCH_ERROR' in output:raise RuntimeError(output[-5000:])
        line=next((line.split('IPC_BENCH_RESULT ',1)[1] for line in output.splitlines() if 'IPC_BENCH_RESULT ' in line),None)
        if line is None:raise RuntimeError(output[-5000:])
        rows=json.loads(line)
        report={'date':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'platform':platform.platform(),'samples':31,'warmups':5,'versions':versions,'cpu':cpu,'serdePinnedVersion':serde_version,'rootLockSha256':hashlib.sha256((ROOT/'Cargo.lock').read_bytes()).hexdigest(),'fixtureLockSha256':hashlib.sha256((temp/'Cargo.lock').read_bytes()).hexdigest(),'binarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'loadBefore':load_before,'loadAfter':os.getloadavg(),'writerSha256':hashlib.sha256((constants+writer).encode()).hexdigest(),'qmlSha256':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((ROOT/'ui/backend').iterdir()) if p.is_file()},'results':[{'bytes':r['bytes'],'batch':r['batch'],'roundTrip':stats(r['rtt']),'responsePath':stats(r['response'])} for r in rows]}
        (HERE/'results.json').write_text(json.dumps(report,indent=2)+'\n')
        lines=['# Rust → QML response benchmark','',f"Measured {report['date']}; 31 warm samples per size, five warmups.",'','| ASCII payload | Request round trip median / p95 (ms) | Response path median / p95 (ms) |','|---|---:|---:|']
        for r in report['results']:
            a,b=r['roundTrip'],r['responsePath']
            response=f"{b['medianMs']:.2f} / {b['p95Ms']:.2f}" if r['bytes']>=262144 else 'below timer resolution; use round trip'
            lines.append(f"| {r['bytes']} bytes | {a['medianMs']:.2f} / {a['p95Ms']:.2f} | {response} |")
        lines+=['','Uses the current production Rust JSON writer/chunker extracted at build time, unchanged production Backend.qml and real Quickshell pipes. The synthetic Rust fixture replaces mail/network/storage work; the application and its limits are unchanged. Payload allocation occurs before handshake, but the response path includes cloning the fixture into a response, Rust JSON serialization, pipe writes, QML chunk reassembly, JSON decoding, and callback dispatch. Expected payloads are allocated once in QML and every returned byte is compared after taking the callback timestamp. No UI drawing is measured. Request round trip additionally includes the small outgoing request and fixture dispatch; small batched averages also include validation between operations.','', 'Response-path timing uses same-host SystemTime and QML Date.now, with 1 ms Qt clock resolution; sub-ms one-way results are approximate and clamped at zero. Small payloads use 50 sequential operations per batch for more stable round-trip averages. Payloads are flat ASCII strings, not object-heavy message lists or Unicode-rich documents. Shared desktop scheduling can affect the measurements.','', 'Reproduce: `python3 benchmarks/ipc/run.py`. Raw samples, CPU/runtime versions, lockfile and binary hashes are in results.json. serde_json is pinned to the project lockfile version, with the project lockfile copied before the offline fixture build.']
        (HERE/'results.md').write_text('\n'.join(lines)+'\n')
        print('\n'.join(lines))
if __name__=='__main__':main()
