#!/usr/bin/env python3
"""Run the existing synthetic bridge contract against the real Rust executable.

Only the backend changes. The fake Claude streams and policy/ownership assertions
are shared with test_agent_bridge.py. Fake CLI observations are outside the private
job directory, whose production allowlist permits only its three JSON records.
"""
import json
import os
from pathlib import Path
import subprocess
import time
import unittest

import test_agent_bridge as legacy

BINARY = Path(os.environ.get('OMAMAIL_TEST_BIN') or Path(__file__).resolve().parents[1] / 'target/debug/omamail').resolve()


class NativeBridge(legacy.Bridge):
    def setUp(self):
        self.assertTrue(BINARY.is_file(), 'Build the native omamail binary before running bridge tests')
        super().setUp()
        self.artifacts = self.root / 'observations'
        self.artifacts.mkdir()
        self.env['OMAMAIL_TEST_ARTIFACTS'] = str(self.artifacts)

    def agent(self, body):
        prelude = legacy.PRELUDE.replace(
            "Path(ident,'cwd.txt').write_text(str(Path.cwd()))\nos.chdir(ident)",
            "observed=Path(os.environ['OMAMAIL_TEST_ARTIFACTS'])/ident\nobserved.mkdir(exist_ok=True)\nobserved.joinpath('cwd.txt').write_text(str(Path.cwd()))\nos.chdir(observed)"
        )
        self.tool('claude', prelude + body)

    def call(self, *args, value=None, ok=True):
        if args[0] == 'run':
            argv = [str(BINARY), 'agent-worker', args[1]]
            encoded = None
        else:
            method = {'new':'agent.jobStart', 'list':'agent.jobsList', 'show':'agent.jobShow',
                      'cancel':'agent.jobCancel', 'forget':'agent.jobForget'}[args[0]]
            params = {'payload':value} if args[0] == 'new' else ({'id':args[1]} if len(args) > 1 else {})
            argv = [str(BINARY), '--json', 'call', method]
            encoded = json.dumps(params)
        result = subprocess.run(argv, input=encoded, text=True, capture_output=True,
                                env=self.env, timeout=8)
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout)
        if not result.stdout:
            return result.stderr
        answer = json.loads(result.stdout)
        return answer['result'] if answer.get('ok') else answer.get('error', {}).get('code', '')

    def cleanup(self):
        for ident in self.ids:
            subprocess.run([str(BINARY),'--json','call','agent.jobCancel'],
                           input=json.dumps({'id':ident}), text=True, env=self.env,
                           capture_output=True, timeout=8)
        time.sleep(.3)
        self.assertFalse((self.root/'TERMINAL').exists())

    def test_background_stdin_result_and_resume(self):
        ident = self.new(draft={'body':'Original'}, draftKey='ada-draft', draftFingerprint='abc')
        shown = self.wait(ident)
        self.assertEqual(shown['job']['state'], 'done', shown)
        self.assertTrue(shown['job']['resultReady'])
        self.assertTrue(shown['job']['canContinue'])
        self.assertIn('مرحبا', shown['output'])
        folder = self.store/ident
        observed = self.artifacts/ident
        argv = (observed/'argv.json').read_text()
        self.assertNotIn('SECRET-', argv)
        self.assertNotIn('ada@example', argv)
        self.assertIn('SECRET-MAIL', (observed/'stdin.txt').read_text())
        self.assertEqual(folder.stat().st_mode&0o777, 0o700)
        for name in ['context.json','job.json','display.json']:
            self.assertEqual((folder/name).stat().st_mode&0o777, 0o600)
        self.assertFalse((observed/'forbidden').exists())
        self.assertFalse((folder/'forbidden').exists())
        self.assertEqual(set(os.listdir(folder)), {'context.json','job.json','display.json'})
        self.tool('omarchy-default-agent', 'print("unsupported")')
        child = self.call('new',value={'parent':ident,'prompt':'Shorter'})['id'];self.ids.append(child)
        result = self.wait(child)
        self.assertEqual(result['job']['draftKey'], 'ada-draft')
        self.assertEqual(result['job']['accountId'], 'imap:ada@example.test')
        self.assertEqual(result['transcript'][:2], shown['transcript'])
        argv = json.loads((self.artifacts/child/'argv.json').read_text())
        self.assertEqual(argv[argv.index('--resume')+1], legacy.SESSION)
        self.assertIn('--fork-session', argv)
        self.assertEqual((self.artifacts/child/'stdin.txt').read_text(), 'Shorter')
        self.assertEqual((observed/'cwd.txt').read_text(), str(self.store))
        self.assertEqual((self.artifacts/child/'cwd.txt').read_text(), str(self.store))

    def test_unsupported_and_missing_provider(self):
        for selected in ('','codex','other'):
            self.tool('omarchy-default-agent', f'print({selected!r})')
            error = self.call('new',value={'messageId':'1','prompt':'p'},ok=False)
            self.assertEqual(error, 'agent_choose_claude')
        self.assertFalse(list(self.store.glob('*/job.json')))

    def test_cancel_and_active_limit(self):
        self.agent('time.sleep(30)')
        ident=self.new();self.wait(ident,('running',))
        for _ in range(3):self.new()
        self.call('new',value={'messageId':'1','prompt':'p'},ok=False)
        self.call('forget',ident,ok=False)
        for _ in range(40):
            if (self.artifacts/ident/'child.pid').exists():break
            time.sleep(.05)
        pid=int((self.artifacts/ident/'child.pid').read_text())
        self.call('cancel',ident)
        self.assertEqual(self.wait(ident)['job']['state'],'cancelled')
        self.assertFalse(Path('/proc/%d'%pid).exists())

    def test_deadline_and_stale_worker(self):
        # Actual short-deadline/native pipe cleanup is exercised by worker.rs's
        # injected-duration tests; production exposes no timeout-bypass setting.
        ident=self.new();self.wait(ident)
        file=self.store/ident/'job.json'
        original=json.loads(file.read_text())
        job=dict(original,state='queued',created=0,resultReady=False)
        file.write_text(json.dumps(job))
        self.assertEqual(self.call('show',ident)['job']['state'],'failed')
        job=dict(original,state='running',pid=os.getpid(),resultReady=False)
        file.write_text(json.dumps(job))
        self.call('cancel',ident)
        self.assertEqual(self.call('show',ident)['job']['state'],'failed')
        self.assertTrue(Path('/proc/%d'%os.getpid()).exists())

    def test_legacy_python_worker_is_adopted_and_cancelled(self):
        self.agent('time.sleep(30)')
        payload = dict(accountId='imap:ada@example.test', account='ada@example.test',
                       messageId='1:INBOX', subject='Upgrade', prompt='Synthetic prompt',
                       message='Synthetic legacy mail')
        started = subprocess.run(['python3', str(legacy.SCRIPT), 'new'],
                                 input=json.dumps(payload), text=True, capture_output=True,
                                 env=self.env, timeout=8)
        self.assertEqual(started.returncode, 0, started.stderr)
        ident = json.loads(started.stdout)['id']
        self.ids.append(ident)
        # Also clean up through the original bridge if native adoption regresses.
        self.addCleanup(lambda: subprocess.run(
            ['python3', str(legacy.SCRIPT), 'cancel', ident],
            env=self.env, capture_output=True, timeout=8))
        for _ in range(100):
            if (self.artifacts/ident/'child.pid').exists():
                break
            time.sleep(.04)
        child_pid = int((self.artifacts/ident/'child.pid').read_text())
        saved = json.loads((self.store/ident/'job.json').read_text())
        worker_pid = saved['pid']
        self.assertEqual(Path('/proc/%d/cmdline'%worker_pid).read_bytes().split(b'\0')[1:-1],
                         [os.fsencode(legacy.SCRIPT), b'run', ident.encode()])
        self.assertEqual(self.call('show', ident)['job']['state'], 'running')
        listed = self.call('list')
        self.assertTrue(any(job['id'] == ident and job['state'] == 'running'
                            for job in listed), listed)
        for _ in range(3):
            self.new()
        self.assertEqual(self.call('new', value=payload, ok=False), 'agent_active_limit')
        self.assertTrue(Path('/proc/%d'%child_pid).exists())
        self.call('cancel', ident)
        self.assertEqual(self.wait(ident)['job']['state'], 'cancelled')
        self.assertFalse(Path('/proc/%d'%child_pid).exists())

    def test_retention_metadata_identity(self):
        ident=self.new();self.wait(ident)
        template=json.loads((self.store/ident/'job.json').read_text())
        display=json.loads((self.store/ident/'display.json').read_text())
        context=json.loads((self.store/ident/'context.json').read_text())
        outside=self.root/'outside';outside.mkdir();marker=outside/'keep';marker.touch()
        for number in range(31):
            folder=self.store/('%032x'%number);folder.mkdir(mode=0o700)
            job=dict(template,id=folder.name,created=number,createdOrder=number)
            for name,value in [('job.json',job),('display.json',display),('context.json',context)]:
                file=folder/name;file.write_text(json.dumps(value));file.chmod(0o600)
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

    def test_ongoing_worker_survives_start_command_exit_and_another_backend_reads_it(self):
        self.agent("time.sleep(.5)\n" + legacy.SUCCESS)
        ident=self.new()
        # Every call starts and exits a separate backend process. The detached
        # worker must remain alive and its result readable across these exits.
        shown=self.wait(ident)
        self.assertEqual(shown['job']['state'],'done')
        self.assertTrue(shown['job']['resultReady'])
        self.assertEqual(self.call('show',ident)['output'],shown['output'])

    def test_stream_private_tokens_are_absent_from_all_persisted_records(self):
        self.agent("""emit({'type':'stream_event','event':{'type':'content_block_delta','delta':{'type':'thinking_delta','thinking':'PRIVATE-REASONING'}}})
emit({'type':'assistant','parent_tool_use_id':'child','message':{'content':[{'type':'text','text':'PRIVATE-SUBAGENT'}]}})
emit({'type':'user','message':{'content':[{'type':'tool_result','content':'PRIVATE-TOOL-RESULT'}]}})
print('PRIVATE-STDERR',file=sys.stderr)
emit({'type':'result','subtype':'success','result':'Visible answer'})
""")
        ident=self.new();shown=self.wait(ident)
        self.assertEqual(shown['job']['state'],'done')
        for name in ['context.json','job.json','display.json']:
            stored=(self.store/ident/name).read_text()
            self.assertNotIn('PRIVATE-',stored)

    def test_concurrent_admission_is_atomic_across_backend_processes(self):
        from concurrent.futures import ThreadPoolExecutor
        self.agent('time.sleep(30)')
        def start(index):
            payload={'accountId':'imap:ada@example.test','messageId':str(index),'prompt':'Synthetic request','message':'Synthetic body'}
            result=subprocess.run([str(BINARY),'--json','call','agent.jobStart'],input=json.dumps({'payload':payload}),text=True,capture_output=True,env=self.env,timeout=8)
            return result.returncode,json.loads(result.stdout)
        with ThreadPoolExecutor(max_workers=8) as executor:
            results=list(executor.map(start,range(8)))
        for code,result in results:
            if code==0:self.ids.append(result['result']['id'])
        self.assertEqual(len(self.ids),4,results)
        for code,result in results:
            if code:self.assertEqual(result['error']['code'],'agent_active_limit')
        self.assertEqual(len(self.call('list')),4)

    def test_oversized_provider_probe_starts_no_job(self):
        marker=self.root/'unexpected-claude'
        self.tool('claude',f"from pathlib import Path\nPath({str(marker)!r}).touch()")
        self.tool('omarchy-default-agent',"print('x'*(9*1024*1024))")
        self.call('new',value={'messageId':'1','prompt':'Synthetic'},ok=False)
        self.assertFalse(marker.exists())
        self.assertFalse(list(self.store.glob('*/job.json')))

    def test_legacy_cancelled_job_without_display_does_not_block_new_jobs(self):
        self.call('list')
        ident = '1' * 32
        folder = self.store / ident
        folder.mkdir(mode=0o700)
        job = {'id':ident, 'accountId':'imap:ada@example.test', 'subject':'Legacy',
               'messageId':'old', 'messageIds':['old'], 'draftKey':'',
               'draftFingerprint':'', 'kind':'message', 'state':'cancelled',
               'created':1, 'updated':1, 'resultReady':False}
        for name, value in [('job.json',job),('context.json',{'prompt':'Legacy'})]:
            path = folder / name
            path.write_text(json.dumps(value))
            path.chmod(0o600)
        response = folder / 'response.txt'
        response.write_text('Unverified legacy output must not become a resumable answer')
        response.chmod(0o600)
        listed = self.call('list')
        self.assertEqual(listed[0]['state'], 'cancelled')
        shown = self.call('show', ident)
        self.assertEqual(shown['output'], '')
        self.assertEqual(shown['transcript'], [])
        self.assertFalse(shown['job']['canContinue'])
        self.assertFalse((folder / 'display.json').exists())
        new_id = self.new()
        self.assertEqual(self.wait(new_id)['job']['state'], 'done')
        self.call('forget', ident)
        self.assertFalse(folder.exists())

    def test_saved_answer_session_mismatch_cannot_continue(self):
        ident=self.new();self.wait(ident)
        file=self.store/ident/'display.json'
        saved=json.loads(file.read_text())
        saved['sessionId']='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
        file.write_text(json.dumps(saved))
        shown=self.call('show',ident)
        self.assertFalse(shown['job']['resultReady'])
        self.assertFalse(shown['job']['canContinue'])
        before=sorted(os.listdir(self.store))
        self.call('new',value={'parent':ident,'prompt':'Continue'},ok=False)
        self.assertEqual(sorted(os.listdir(self.store)),before)


if __name__ == '__main__':
    unittest.main()
