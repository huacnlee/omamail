#!/usr/bin/env python3
"""Measure synthetic mail CPU work in frozen JS and native Rust; no network."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import statistics
import subprocess
import tempfile
import time
from corpus import corpus
from qml_runner import source as qml_source
from report import render

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]


def run_process(command, payload, directory, name):
    result_file=directory/(name+'.out')
    memory_file=directory/(name+'.rss')
    start=time.perf_counter()
    with result_file.open('wb') as out:
        completed=subprocess.run(['python3',str(HERE/'measure_process.py'),str(memory_file),*command],
            input=json.dumps(payload).encode(),stdout=out,stderr=subprocess.PIPE,check=False,env=dict(os.environ,QT_QPA_PLATFORM='offscreen',QT_QUICK_BACKEND='software',QT_FORCE_STDERR_LOGGING='1',QT_QPA_PLATFORMTHEME='',GSETTINGS_BACKEND='memory'))
    if completed.returncode:
        raise RuntimeError(f'{name} failed: '+completed.stderr.decode(errors='replace')[-2500:])
    text=result_file.read_text()
    if name=='qml':
        text=next(line.split('OMAMAIL_BENCH_RESULT ',1)[1] for line in completed.stderr.decode().splitlines() if 'OMAMAIL_BENCH_RESULT ' in line)
    return json.loads(text),dict(processWallSeconds=time.perf_counter()-start,
        peakRssKiB=json.loads(memory_file.read_text())['peakRssKiB'])


def digest(value):
    return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()


def mime_semantics(value):
    # Compare wire headers, MIME structure, names and exact decoded bytes. The
    # attachmentId is a backend locator, not parsed mail content.
    import base64
    body=value.get('body',{})
    data=body.get('data','')
    decoded=base64.urlsafe_b64decode(data+'='*((-len(data))%4))
    return dict(mimeType=value.get('mimeType',''),filename=value.get('filename',''),
        headers=[dict(name=h['name'].lower(),value=h['value']) for h in value.get('headers',[])],
        bodyBytes=len(decoded),bodySha256=hashlib.sha256(decoded).hexdigest(),
        parts=[mime_semantics(p) for p in value.get('parts',[])])


def html_semantics(value):
    # Tree caches and absent default fields are implementation details; preserve
    # every renderable node, attribute, text byte, child order and result field.
    def node(n):
        kind=n['type']
        if kind=='text':return dict(type=kind,text=n.get('text',''))
        children=[node(c) for c in n.get('children',[])]
        if kind=='root':return dict(type=kind,children=children)
        return dict(type=kind,name=n['name'],attrs=n.get('attrs',[]),
                    selfClosing=n.get('selfClosing',False),children=children)
    result=dict(value)
    result['document']=node(value['document'])
    if value.get('reader'):
        result['reader']=dict(value['reader'])
        result['reader']['document']=node(value['reader']['document'])
    return result


def difference(a,b,path='$'):
    if type(a)!=type(b):return path+': differing types'
    if isinstance(a,dict):
        if a.keys()!=b.keys():return path+': differing keys'
        for key in a:
            if a[key]!=b[key]:return difference(a[key],b[key],path+'.'+key)
    elif isinstance(a,list):
        if len(a)!=len(b):return path+': differing lengths'
        for i,(x,y) in enumerate(zip(a,b)):
            if x!=y:return difference(x,y,path+f'[{i}]')
    elif a!=b:return path+': differing values'
    return ''


def stats(row):
    values=sorted(row['samplesUs'])
    return dict(coldUs=row['coldUs'],medianUs=statistics.median(values),
        p95Us=values[min(len(values)-1,math.ceil(len(values)*.95)-1)],samplesUs=row['samplesUs'])


def main():
    command_started=time.perf_counter()
    parser=argparse.ArgumentParser()
    parser.add_argument('--samples',type=int,default=31)
    parser.add_argument('--batch',type=int,default=3)
    parser.add_argument('--phases',nargs='+',choices=['mime','html','readprep'],default=['mime','html','readprep'])
    parser.add_argument('--attachment-mib',type=int,choices=[2,10],default=2,help='Synthetic attachment size; does not change application limits')
    parser.add_argument('--cases',nargs='+',choices=['small_plain','newsletter_html','nested_mime','large_attachment','unicode'])
    parser.add_argument('--qml',action='store_true',help='Include production Qt QML JavaScript engine')
    parser.add_argument('--conditions',default='Shared desktop machine; no exclusive CPU affinity or machine isolation.')
    parser.add_argument('--output',type=Path,default=HERE/'results.json')
    args=parser.parse_args()
    if not 3<=args.samples<=1000 or not 1<=args.batch<=1000:parser.error('samples 3..1000, batch 1..1000')
    manifest=json.loads((HERE/"baseline/manifest.json").read_text())
    for relative, expected in manifest["sha256"].items():
        if hashlib.sha256((HERE/"baseline/ui"/relative).read_bytes()).hexdigest()!=expected:
            raise SystemExit("Frozen baseline hash mismatch: "+relative)
    load_before=os.getloadavg()
    cases=corpus(args.attachment_mib)
    if args.cases:cases=[case for case in cases if case['name'] in args.cases]
    payload=dict(cases=cases,samples=args.samples,batch=args.batch,phases=args.phases,htmlOptions={})
    build_started=time.perf_counter()
    subprocess.run(['cargo','build','--locked','--release','--example','mail_bench','--target-dir',str(ROOT/'target')],cwd=ROOT,check=True)
    build_seconds=time.perf_counter()-build_started
    with tempfile.TemporaryDirectory(prefix='omamail-mail-bench-') as directory:
        directory=Path(directory)
        js,js_process=run_process(['node',str(HERE/'node.cjs')],payload,directory,'node')
        native,native_process=run_process([str(ROOT/'target/release/examples/mail_bench')],payload,directory,'rust')
        qml=None
        qml_process=None
        if args.qml:
            qml_file=directory/'benchmark.qml'
            qml_file.write_text(qml_source(payload,HERE/'baseline/ui'))
            qml,qml_process=run_process(['/usr/lib/qt6/bin/qml',str(qml_file)],{},directory,'qml')
        expected=len(payload['cases'])*len(payload['phases'])
        for measured in [js,native]+([qml] if qml else []):
            if len(measured['cases'])!=expected:raise RuntimeError('Missing benchmark operations')
        results=[]
        for index,(old,new) in enumerate(zip(js['cases'],native['cases'],strict=True)):
            assert(old['name'],old['phase'])==(new['name'],new['phase'])
            canonical=mime_semantics if old['phase']=='mime' else html_semantics
            a,b=canonical(old['result']),canonical(new['result'])
            results.append(dict(name=old['name'],phase=old['phase'],semanticMatch=a==b,
                semanticDifference=difference(a,b),jsDigest=digest(a),rustDigest=digest(b),
                node=stats(old),rust=stats(new),speedup=statistics.median(old['samplesUs'])/statistics.median(new['samplesUs'])))
            if qml:
                actual=qml['cases'][index]
                assert(actual['name'],actual['phase'])==(old['name'],old['phase'])
                results[-1]['qml']=stats(actual)
                results[-1]['qml']['batch']=actual['batch']
                results[-1]['qmlSemanticMatch']=canonical(actual['result'])==a
                results[-1]['qmlSpeedup']=statistics.median(actual['samplesUs'])/statistics.median(new['samplesUs'])
    cpu=next((line.split(':',1)[1].strip() for line in Path('/proc/cpuinfo').read_text().splitlines() if line.startswith('model name')),'unknown')
    report=dict(date=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),machine=dict(cpu=cpu,platform=platform.platform(),logicalCpus=os.cpu_count(),loadAverageBefore=load_before,loadAverageAfter=os.getloadavg()),
        versions=dict(qml=subprocess.check_output(['/usr/lib/qt6/bin/qml','--version'],text=True,env=dict(os.environ,QT_QPA_PLATFORMTHEME='',GSETTINGS_BACKEND='memory'),stderr=subprocess.DEVNULL).strip() if args.qml else None,node=js['engine'],rust=subprocess.check_output(['rustc','--version'],text=True).strip()),
        conditions=args.conditions,commandWallSeconds=time.perf_counter()-command_started,buildWallSeconds=build_seconds,
        baseline=manifest,nativeBinarySha256=hashlib.sha256((ROOT/"target/release/examples/mail_bench").read_bytes()).hexdigest(),
        nativeSourceSha256={str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((ROOT/"src/message").rglob("*.rs"))},
        samples=args.samples,batch=args.batch,warmupOperations=5,attachmentMiB=args.attachment_mib,
        corpus=[{k:v for k,v in c.items() if k not in ('raw','html')} for c in payload['cases']],
        nodeProcess=js_process,rustProcess=native_process,qmlProcess=qml_process,results=results)
    args.output.write_text(json.dumps(report,indent=2)+'\n')
    args.output.with_suffix('.md').write_text(render(report))
    for row in results:print(f"{row['name']:18s} {row['phase']:6s} Node {row['node']['medianUs']:10.2f} us Rust {row['rust']['medianUs']:10.2f} us {row['speedup']:7.2f}x parity={row['semanticMatch']} {row['semanticDifference']}")
    print('Report:',args.output)
    if any(not row['semanticMatch'] or row.get('qmlSemanticMatch',True) is False for row in results):raise SystemExit('Semantic differences: timings are not equivalent-work speedup evidence')

if __name__=='__main__':main()
