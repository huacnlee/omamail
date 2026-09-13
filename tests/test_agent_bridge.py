#!/usr/bin/env python3
"""Synthetic CLI integration tests; no real AI, credentials or mail are used."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/agent-job.py'
SESSION = '11111111-2222-3333-4444-555555555555'
PRELUDE = '''import os,sys,json,time
from pathlib import Path
def emit(value):
    print(json.dumps(value),flush=True)
prompt=sys.stdin.read()
# Record each fake invocation beside its job via the verified wrapper argv.
parent_args=Path('/proc/%d/cmdline'%os.getppid()).read_bytes().decode().split('\\0')
ident=parent_args[-2] if parent_args[-2] != '-c' else ''
if len(ident)!=32:
    ident=next(p.name for p in Path('.').iterdir() if p.is_dir() and json.loads((p/'job.json').read_text()).get('state')=='running')
Path(ident,'cwd.txt').write_text(str(Path.cwd()))
os.chdir(ident)
Path('stdin.txt').write_text(prompt)
Path('argv.json').write_text(json.dumps(Path('/proc/self/cmdline').read_bytes().decode().split('\\0')))
Path('child.pid').write_text(str(os.getpid()))
assert not os.isatty(0) and not os.isatty(1)
emit({'type':'system','subtype':'init','session_id':'11111111-2222-3333-4444-555555555555'})
'''
SUCCESS = "emit({'type':'result','subtype':'success','result':'Hello مرحبا \\\\ \\\"quoted\\\"','session_id':'11111111-2222-3333-4444-555555555555'})"


class Bridge(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.env = dict(os.environ, XDG_STATE_HOME=str(self.root/'state'), PATH=str(self.bin)+':'+os.environ['PATH'])
        self.store = self.root/'state/omamail/assistant'
        self.tool('omarchy-default-agent','print("claude")')
        for name in ('omarchy-launch-tui','omarchy-agent','xdg-terminal-exec'):
            self.tool(name,f"from pathlib import Path\nPath({str(self.root/'TERMINAL')!r}).touch()\nraise SystemExit(9)")
        self.agent(SUCCESS)
        self.ids=[]
        self.addCleanup(self.cleanup)

    def tool(self,name,body):
        path=self.bin/name
        path.write_text('#!/usr/bin/env python3\n'+body+'\n')
        path.chmod(0o700)

    def agent(self,body):
        self.tool('claude',PRELUDE+body)

    def call(self,*args,value=None,ok=True):
        p=subprocess.run(['python3',str(SCRIPT),*args],input=json.dumps(value) if value is not None else None,text=True,capture_output=True,env=self.env,timeout=5)
        if ok: self.assertEqual(p.returncode,0,p.stderr)
        else: self.assertNotEqual(p.returncode,0,p.stdout)
        return json.loads(p.stdout) if p.stdout else p.stderr

    def new(self,**fields):
        value=dict(accountId='imap:ada@example.test',account='ada@example.test',messageId='1:INBOX',subject='Hello',prompt='SECRET-PROMPT rewrite',message='SECRET-MAIL مرحبا\n$(touch forbidden) `echo x` \\ "quotes"')
        value.update(fields)
        ident=self.call('new',value=value)['id'];self.ids.append(ident)
        return ident

    def wait(self,ident,states=('done','failed','cancelled')):
        for _ in range(100):
            shown=self.call('show',ident)
            if shown['job']['state'] in states: return shown
            time.sleep(.04)
        self.fail('Worker did not settle')

    def cleanup(self):
        for ident in self.ids:
            subprocess.run(['python3',str(SCRIPT),'cancel',ident],env=self.env,capture_output=True)
        time.sleep(.3)
        self.assertFalse((self.root/'TERMINAL').exists())

    def test_background_stdin_result_and_resume(self):
        ident=self.new(draft={'body':'Original'},draftKey='ada-draft',draftFingerprint='abc')
        shown=self.wait(ident)
        self.assertEqual(shown['job']['state'],'done')
        self.assertTrue(shown['job']['resultReady'])
        self.assertTrue(shown['job']['canContinue'])
        self.assertIn('مرحبا',shown['output'])
        folder=self.store/ident
        args=(folder/'argv.json').read_text()
        self.assertNotIn('SECRET-',args)
        self.assertNotIn('ada@example',args)
        self.assertIn('SECRET-MAIL',(folder/'stdin.txt').read_text())
        self.assertEqual(folder.stat().st_mode&0o777,0o700)
        self.assertEqual((folder/'context.json').stat().st_mode&0o777,0o600)
        self.assertFalse((folder/'forbidden').exists())
        self.tool('omarchy-default-agent','print("unsupported")')
        child=self.call('new',value={'parent':ident,'prompt':'Shorter'})['id'];self.ids.append(child)
        result=self.wait(child)
        self.assertEqual(result['job']['draftKey'],'ada-draft')
        self.assertEqual(result['job']['accountId'],'imap:ada@example.test')
        self.assertEqual(result['transcript'][:2],shown['transcript'])
        argv=json.loads((self.store/child/'argv.json').read_text())
        self.assertEqual(argv[argv.index('--resume')+1],SESSION)
        self.assertIn('--fork-session',argv)
        self.assertEqual((self.store/child/'stdin.txt').read_text(),'Shorter')
        self.assertEqual((folder/'cwd.txt').read_text(),str(self.store))
        self.assertEqual((self.store/child/'cwd.txt').read_text(),str(self.store))

    def test_conversation_ids_and_request_previews(self):
        first=self.new(prompt='  Explain\r\n this\t mail  '+ '界'*150);initial=self.wait(first)
        self.assertEqual(initial['job']['conversationId'],first)
        preview=initial['job']['requestPreview']
        self.assertEqual(len(preview),120)
        self.assertTrue(preview.startswith('Explain this mail '))
        self.assertEqual(preview,' '.join(preview.split()))
        second=self.new();second_job=self.wait(second)['job']
        self.assertEqual(second_job['conversationId'],second)
        self.assertNotEqual(second_job['conversationId'],initial['job']['conversationId'])
        child=self.call('new',value={'parent':first,'prompt':'  Follow\n up  '})['id'];self.ids.append(child)
        child_job=self.wait(child)['job']
        self.assertEqual(child_job['conversationId'],first)
        self.assertEqual(child_job['requestPreview'],'Follow up')
        listed={job['id']:job for job in self.call('list')}
        self.assertEqual(listed[child]['conversationId'],first)
        # An older successful job without conversation metadata can still
        # start a continuation rooted at its existing job ID.
        file=self.store/second/'job.json';job=json.loads(file.read_text());job.pop('conversationId');job.pop('requestPreview');file.write_text(json.dumps(job))
        legacy_child=self.call('new',value={'parent':second,'prompt':'Continue'})['id'];self.ids.append(legacy_child)
        self.assertEqual(self.wait(legacy_child)['job']['conversationId'],second)

    def test_invalid_conversation_identity_has_no_side_effects(self):
        ident=self.new();self.wait(ident)
        file=self.store/ident/'job.json';original=json.loads(file.read_text())
        before=sorted(os.listdir(self.store))
        marker=self.root/'unexpected-launch'
        self.tool('claude',f"from pathlib import Path\nPath({str(marker)!r}).touch()")
        for invalid in ('../outside','a'*33,'A'*32,'',[],0,None):
            job=dict(original,conversationId=invalid);file.write_text(json.dumps(job))
            self.call('new',value={'parent':ident,'prompt':'Continue'},ok=False)
            self.call('new',value={'messageId':'1','prompt':'New chat'},ok=False)
            for verb in ('show','cancel','forget','run'):
                self.call(verb,ident,ok=False)
            self.assertEqual(sorted(os.listdir(self.store)),before)
            self.assertFalse(marker.exists())
        file.write_text(json.dumps(original))

    def test_same_second_turn_order(self):
        first=self.new();self.wait(first)
        second=self.call('new',value={'parent':first,'prompt':'Follow up'})['id'];self.ids.append(second)
        self.wait(second)
        # Force the same display timestamp; the stored nanosecond order must
        # still select the newer turn irrespective of directory enumeration.
        for ident in (first,second):
            file=self.store/ident/'job.json';job=json.loads(file.read_text());job['created']=100;file.write_text(json.dumps(job))
        listed=self.call('list')
        self.assertEqual([j['id'] for j in listed],[second,first])
        self.assertGreater(listed[0]['createdOrder'],listed[1]['createdOrder'])

    def test_progress_tools_and_private_events(self):
        self.agent("""emit({'type':'stream_event','event':{'type':'content_block_delta','delta':{'type':'thinking_delta','thinking':'HIDDEN-REASONING'}}})
emit({'type':'stream_event','event':{'type':'content_block_start','content_block':{'type':'tool_use','name':'Bash','input':{'command':'SECRET-ARG'}}}})
emit({'type':'user','message':{'content':[{'type':'tool_result','content':'SECRET-TOOL-OUTPUT'}]}})
emit({'type':'stream_event','event':{'type':'content_block_delta','delta':{'type':'text_delta','text':'First'}}})
time.sleep(.6)
emit({'type':'stream_event','event':{'type':'content_block_delta','delta':{'type':'text_delta','text':' second'}}})
time.sleep(.6)
emit({'type':'result','subtype':'success','result':'First second'})
""")
        ident=self.new()
        partial=None
        for _ in range(50):
            shown=self.call('show',ident)
            if shown['output']=='First': partial=shown;break
            time.sleep(.03)
        self.assertIsNotNone(partial)
        self.assertFalse(partial['job']['resultReady'])
        self.assertIn('Running a command',json.dumps(partial['transcript']))
        result=self.wait(ident)
        self.assertEqual(result['output'],'First second')
        serialized=json.dumps(result)
        for secret in ('HIDDEN-REASONING','SECRET-ARG','SECRET-TOOL-OUTPUT'): self.assertNotIn(secret,serialized)

    def test_claude_snapshot_deduplication(self):
        self.agent("""emit({'type':'stream_event','event':{'type':'message_start'}})
emit({'type':'stream_event','event':{'type':'content_block_delta','delta':{'type':'text_delta','text':'Checking.'}}})
emit({'type':'stream_event','event':{'type':'content_block_start','content_block':{'type':'tool_use','name':'Read','input':{'file_path':'SECRET'}}}})
emit({'type':'assistant','message':{'content':[{'type':'text','text':'Checking.'},{'type':'tool_use','name':'Read','input':{'file_path':'SECRET'}}]}})
emit({'type':'user','message':{'content':[{'type':'tool_result','content':'SECRET-RESULT'}]}})
emit({'type':'stream_event','event':{'type':'message_start'}})
emit({'type':'stream_event','event':{'type':'content_block_delta','delta':{'type':'text_delta','text':'Final answer'}}})
emit({'type':'assistant','message':{'content':[{'type':'text','text':'Final answer'}]}})
emit({'type':'result','subtype':'success','result':'Final answer'})
""")
        shown=self.wait(self.new())
        self.assertEqual(shown['output'],'Final answer')
        self.assertEqual(shown['transcript'],[{'role':'user','text':'SECRET-PROMPT rewrite'},{'role':'assistant','text':'Checking.'},{'role':'status','text':'Reading a file'},{'role':'status','text':'Tool finished'},{'role':'assistant','text':'Final answer'}])

    def test_continuation_ownership_active_and_invalid_inputs(self):
        ident=self.new();self.wait(ident)
        before=sorted(os.listdir(self.store))
        for extra in ({'accountId':'bob'},{'draftKey':'bob'},{'message':'replacement'},{'draft':{'body':'replacement'}}):
            self.call('new',value=dict(parent=ident,prompt='p',**extra),ok=False)
            self.assertEqual(sorted(os.listdir(self.store)),before)
        self.agent('time.sleep(30)')
        active=self.new();self.wait(active,('running',))
        self.call('new',value={'parent':active,'prompt':'p'},ok=False)
        for value in ({'command':'touch x','prompt':'p','messageId':'1'},{'prompt':'p\x00','messageId':'1'},{'prompt':'x'*1048576,'messageId':'1'},{'messages':[{'messageId':str(i),'message':'m'} for i in range(21)],'prompt':'p'}):
            self.call('new',value=value,ok=False)
        for ident in ('../outside','x','a'*33): self.call('show',ident,ok=False)

    def test_unsupported_and_missing_provider(self):
        for selected in ('','codex','other'):
            self.tool('omarchy-default-agent',f'print({selected!r})')
            error=self.call('new',value={'messageId':'1','prompt':'p'},ok=False)
            self.assertIn('Claude',error)
        self.assertFalse(list(self.store.glob('*/job.json')))

    def test_stream_failure_boundaries(self):
        for body in ("print('{',flush=True)","sys.stdout.buffer.write(b'\\xff\\n')", "print('x'*524289,flush=True)", "emit({'type':'result','subtype':'success','result':'x'*65537})", "emit({'type':'result','subtype':'success','result':'bad\\x00'})", "emit({'type':'result','subtype':'error','is_error':True,'result':'SECRET-ERROR'})", "print('SECRET-STDERR',file=sys.stderr);raise SystemExit(3)", "sys.stderr.write('x'*(9*1024*1024))", "emit({'type':'system','session_id':'--bad'})", "pass"):
            self.agent(body)
            ident=self.new();shown=self.wait(ident)
            self.assertEqual(shown['job']['state'],'failed',body)
            self.assertFalse(shown['job']['resultReady'])
            self.assertFalse(shown['job']['canContinue'])
            self.assertNotIn('SECRET-',shown['job'].get('error',''))

    def test_cancel_and_active_limit(self):
        self.agent('time.sleep(30)')
        ident=self.new();self.wait(ident,('running',))
        for _ in range(3):self.new()
        self.call('new',value={'messageId':'1','prompt':'p'},ok=False)
        self.call('forget',ident,ok=False)
        for _ in range(20):
            if (self.store/ident/'child.pid').exists():break
            time.sleep(.05)
        pid=int((self.store/ident/'child.pid').read_text())
        self.call('cancel',ident)
        self.assertEqual(self.wait(ident)['job']['state'],'cancelled')
        self.assertFalse(Path('/proc/%d'%pid).exists())

    def test_deadline_and_stale_worker(self):
        ident=self.new();self.wait(ident)
        file=self.store/ident/'job.json'
        job=json.loads(file.read_text());job.update(state='queued',created=int(time.time()),resultReady=False)
        file.write_text(json.dumps(job))
        self.agent('time.sleep(30)')
        code="import importlib.util; s=importlib.util.spec_from_file_location('bridge',%r); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.RUN_TIMEOUT=.2; import sys; sys.argv=['python3','run',%r]; m.main()" % (str(SCRIPT),ident)
        subprocess.run(['python3','-c',code],env=self.env,check=True,timeout=5)
        shown=self.call('show',ident)
        self.assertEqual(shown['job']['state'],'failed')
        self.assertIn('one-hour',shown['job']['error'])
        job.update(state='queued',created=0);file.write_text(json.dumps(job))
        self.assertEqual(self.call('show',ident)['job']['state'],'failed')
        job.update(state='running',pid=os.getpid());file.write_text(json.dumps(job))
        self.call('cancel',ident)
        self.assertEqual(self.call('show',ident)['job']['state'],'failed')

    def test_saved_session_identity_and_history_limit(self):
        ident=self.new();self.wait(ident)
        file=self.store/ident/'job.json';original=json.loads(file.read_text())
        before=sorted(os.listdir(self.store))
        for field in ('sessionId','resume'):
            for invalid in ('--settings=/tmp/forbidden','../elsewhere',[],0,None):
                value=dict(original);value[field]=invalid;file.write_text(json.dumps(value))
                self.call('new',value={'parent':ident,'prompt':'p'},ok=False)
                self.assertEqual(sorted(os.listdir(self.store)),before)
        file.write_text(json.dumps(original))
        self.call('new',value={'messageId':'1','prompt':'x'*(256*1024)},ok=False)
        self.assertEqual(sorted(os.listdir(self.store)),before)

    def test_private_file_boundaries(self):
        ident=self.new();self.wait(ident)
        file=self.store/ident/'display.json'
        target=self.root/'private';target.write_bytes(file.read_bytes());target.chmod(0o600)
        for kind in ('symlink','hardlink','fifo','mode'):
            file.unlink(missing_ok=True)
            if kind=='symlink':file.symlink_to(target)
            elif kind=='hardlink':os.link(target,file)
            elif kind=='fifo':os.mkfifo(file,0o600)
            else:file.write_bytes(target.read_bytes());file.chmod(0o644)
            self.call('show',ident,ok=False)
            self.assertTrue(target.exists())

    def test_retention_metadata_identity(self):
        ident=self.new();self.wait(ident)
        template=json.loads((self.store/ident/'job.json').read_text())
        outside=self.root/'outside';outside.mkdir();marker=outside/'keep';marker.touch()
        for number in range(31):
            folder=self.store/('%032x'%number);folder.mkdir(mode=0o700)
            job=dict(template,id=folder.name,created=number,createdOrder=number)
            file=folder/'job.json';file.write_text(json.dumps(job));file.chmod(0o600)
        forged=self.store/('0'*32)/'job.json'
        value=json.loads(forged.read_text());value['id']=str(outside);forged.write_text(json.dumps(value))
        before=sorted(os.listdir(self.store))
        self.call('new',value={'messageId':'1','prompt':'p'},ok=False)
        self.assertEqual(sorted(os.listdir(self.store)),before)
        self.assertTrue(marker.exists())
        for verb in ('show','cancel','forget','run'):self.call(verb,'0'*32,ok=False)
        value['id']='0'*32;forged.write_text(json.dumps(value))
        added=self.new();self.wait(added)
        self.assertEqual(len(self.call('list')),32)
        self.assertFalse(forged.exists())
        self.assertTrue(marker.exists())


if __name__=='__main__':unittest.main()
