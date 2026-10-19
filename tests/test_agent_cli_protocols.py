#!/usr/bin/env python3
"""Opt-in real CLI protocol test, with isolated HOME and loopback model fixtures.

OMAMAIL_TEST_OPENCODE / OMAMAIL_TEST_CODEX name real executables to exercise.
No provider account, real model, mailbox, credential or existing session is used.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import agent_broker_fixture

BINARY = Path(os.environ.get('OMAMAIL_TEST_BIN', Path(__file__).resolve().parents[1]/'target/debug/omamail')).resolve()


class LocalModel(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        raw = self.rfile.read(int(self.headers['Content-Length']))
        request = json.loads(raw)
        self.server.requests.append(request)
        self.server.headers.append(dict(self.headers))
        if self.server.stall:
            # Start a streamed answer before stalling, so cancellation exercises
            # a native session in progress, not only pre-session startup.
            self.send_response(200)
            self.send_header('Content-Type','text/event-stream')
            self.end_headers()
            if self.path == '/v1/chat/completions':
                chunk={'id':'chatcmpl-stalled','object':'chat.completion.chunk','created':1,
                    'model':'fixture-model','choices':[{'index':0,'delta':{'role':'assistant','content':'Partial'},'finish_reason':None}]}
                self.wfile.write(('data: '+json.dumps(chunk)+'\n\n').encode())
                self.wfile.flush()
            self.server.waiting.set()
            self.server.release.wait(15)
            return
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        if self.path.startswith('/v1/messages'):
            messages=request.get('messages',[])
            last_user=next((m.get('content',[]) for m in reversed(messages) if m.get('role')=='user'),[])
            tool_result=isinstance(last_user,list) and any(m.get('type')=='tool_result' for m in last_user)
            propose=self.server.propose and not tool_result
            content=({'type':'tool_use','id':'tool_proposal_'+str(len(self.server.requests)),'name':'mcp__omamail__propose_draft','input':{}} if propose
                     else {'type':'text','text':''})
            delta=({'type':'input_json_delta','partial_json':json.dumps({'subject':'Re: Synthetic','body':'The exact proposed body.'})} if propose
                   else {'type':'text_delta','text':'Synthetic answer مرحبا'})
            for event in [
                {'type':'message_start','message':{'id':'msg_fixture','type':'message','role':'assistant','model':request['model'],'content':[], 'stop_reason':None,'usage':{'input_tokens':5,'output_tokens':0}}},
                {'type':'content_block_start','index':0,'content_block':content},
                {'type':'content_block_delta','index':0,'delta':delta},
                {'type':'content_block_stop','index':0},
                {'type':'message_delta','delta':{'stop_reason':'tool_use' if propose else 'end_turn','stop_sequence':None},'usage':{'output_tokens':3}},
                {'type':'message_stop'},
            ]:
                self.wfile.write(('event: '+event['type']+'\ndata: '+json.dumps(event)+'\n\n').encode())
        elif self.path == '/v1/chat/completions':
            tools=[t['function']['name'] for t in request.get('tools',[])]
            messages=request.get('messages',[])
            last_user=max((i for i,m in enumerate(messages) if m.get('role')=='user'),default=-1)
            if self.server.propose and 'omamail_propose_draft' in tools and not any(m.get('role')=='tool' for m in messages[last_user+1:]):
                for delta,finish in [({'role':'assistant','tool_calls':[{'index':0,'id':'call_proposal','type':'function','function':{
                    'name':'omamail_propose_draft','arguments':json.dumps({'subject':'Re: Synthetic','body':'The exact proposed body.'})}}]},None),({},'tool_calls')]:
                    chunk={'id':'chatcmpl-proposal','object':'chat.completion.chunk','created':1,'model':'fixture-model',
                           'choices':[{'index':0,'delta':delta,'finish_reason':finish}]}
                    self.wfile.write(('data: '+json.dumps(chunk)+'\n\n').encode())
                self.wfile.write(b'data: [DONE]\n\n')
                return
            for delta, finish in [({'role':'assistant','content':'Synthetic '},None),
                                  ({'content':'answer مرحبا'},None), ({},'stop')]:
                chunk = {'id':'chatcmpl-test','object':'chat.completion.chunk','created':1,
                         'model':'fixture-model','choices':[{'index':0,'delta':delta,'finish_reason':finish}]}
                self.wfile.write(('data: '+json.dumps(chunk)+'\n\n').encode())
            self.wfile.write(b'data: [DONE]\n\n')
        elif self.path == '/v1/responses':
            inputs=request.get('input',[])
            last_user=max((i for i,m in enumerate(inputs) if m.get('role')=='user'),default=-1)
            advertised = any(t.get('name') == 'mcp__omamail' and any(tool.get('name') == 'propose_draft' for tool in t.get('tools', [])) for t in request.get('tools', []))
            if self.server.propose and advertised and not any(m.get('type')=='function_call_output' for m in inputs[last_user+1:]):
                call={'id':'fc_proposal','type':'function_call','call_id':'call_proposal','name':'propose_draft','namespace':'mcp__omamail',
                      'arguments':json.dumps({'subject':'Re: Synthetic','body':'The exact proposed body.'})}
                response={'id':'resp_proposal','object':'response','status':'completed','output':[call],
                          'usage':{'input_tokens':5,'output_tokens':3,'total_tokens':8}}
                for event in [
                    {'type':'response.created','response':dict(response,status='in_progress',output=[])},
                    {'type':'response.output_item.added','output_index':0,'item':dict(call,arguments='')},
                    {'type':'response.function_call_arguments.delta','item_id':'fc_proposal','output_index':0,'delta':call['arguments']},
                    {'type':'response.output_item.done','output_index':0,'item':call},
                    {'type':'response.completed','response':response},
                ]:
                    self.wfile.write(('event: '+event['type']+'\ndata: '+json.dumps(event)+'\n\n').encode())
                return
            msg = {'id':'msg_test','type':'message','role':'assistant','status':'completed',
                   'content':[{'type':'output_text','text':'Synthetic answer مرحبا','annotations':[]}]}
            response = {'id':'resp_test','object':'response','status':'completed','output':[msg],
                        'usage':{'input_tokens':5,'output_tokens':3,'total_tokens':8}}
            for event in [
                {'type':'response.created','response':dict(response,status='in_progress',output=[])},
                {'type':'response.output_item.added','output_index':0,'item':dict(msg,status='in_progress',content=[])},
                {'type':'response.output_text.delta','item_id':'msg_test','output_index':0,'content_index':0,'delta':'Synthetic answer مرحبا'},
                {'type':'response.output_item.done','output_index':0,'item':msg},
                {'type':'response.completed','response':response},
            ]:
                self.wfile.write(('event: '+event['type']+'\ndata: '+json.dumps(event)+'\n\n').encode())


class NativeCliProtocol(unittest.TestCase):
    def exercise(self, provider, executable, omit_finish=False, proposals=False, code_mode_model=None):
        server = ThreadingHTTPServer(('127.0.0.1',0), LocalModel)
        server.requests = []
        server.headers = []
        server.stall = False
        server.propose = proposals
        server.waiting = threading.Event()
        server.release = threading.Event()
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        with tempfile.TemporaryDirectory(prefix='omamail-cli-') as tmp:
            root = Path(tmp).resolve()
            toolbin = root/('.local/bin' if sys.platform == 'darwin' else 'bin')
            toolbin.mkdir(parents=True)
            if omit_finish:
                # Reproduce a V2 run that returns completed text without its
                # step_finish notification. Keep the real session outcome/API.
                (toolbin/provider).write_text('''#!/usr/bin/python3
import subprocess,sys,json,os
if sys.argv[1] != 'run':
    os.execv('''+repr(str(Path(executable).resolve()))+''', ['''+repr(str(Path(executable).resolve()))+''']+sys.argv[1:])
result=subprocess.run(['''+repr(str(Path(executable).resolve()))+''']+sys.argv[1:],input=sys.stdin.buffer.read(),capture_output=True)
sys.stderr.buffer.write(result.stderr)
if sys.argv[1] == 'run':
    for line in result.stdout.splitlines():
        if json.loads(line).get('type') != 'step_finish':
            sys.stdout.buffer.write(line+b'\\n')
else:
    sys.stdout.buffer.write(result.stdout)
sys.exit(result.returncode)
''')
                (toolbin/provider).chmod(0o700)
            else:
                (toolbin/provider).symlink_to(Path(executable).resolve())
            if provider == 'claude' and sys.platform == 'darwin':
                # A synthetic HOME alone does not isolate macOS Keychain.
                # Bare mode explicitly prevents reading its OAuth credentials.
                tool=toolbin/provider
                tool.unlink()
                tool.write_text('#!/usr/bin/python3\nimport os,sys\nos.execv('+repr(str(Path(executable).resolve()))+', ['+repr(str(Path(executable).resolve()))+', "--bare"]+sys.argv[1:])\n')
                tool.chmod(0o700)
            if provider == 'codex':
                tool = toolbin/provider
                tool.unlink()
                tool.write_text('#!/usr/bin/python3\n' + '''import subprocess,sys,os
from pathlib import Path
import json
with (Path(os.environ['HOME'])/'synthetic-cli-argv.json').open('w') as args: json.dump(sys.argv,args)
with (Path(os.environ['HOME'])/'synthetic-cli-errors.log').open('w') as errors, (Path(os.environ['HOME'])/'synthetic-cli-events.log').open('w') as events:
    extra = ['-c', 'model_catalog_json='+json.dumps(str(Path(os.environ['HOME'])/'model-catalog.json'))] if (Path(os.environ['HOME'])/'model-catalog.json').exists() else []
    child=subprocess.Popen(['''+repr(str(Path(executable).resolve()))+''']+sys.argv[1:]+extra,stdin=sys.stdin,stdout=subprocess.PIPE,stderr=errors,text=True)
    for line in child.stdout:
        events.write(line);events.flush();sys.stdout.write(line);sys.stdout.flush()
    raise SystemExit(child.wait())
''')
                tool.chmod(0o700)
            (toolbin/'omarchy-default-agent').write_text('#!/usr/bin/python3\nprint('+repr(provider)+')\n')
            (toolbin/'omarchy-default-agent').chmod(0o700)
            config = root/'config/opencode'
            config.mkdir(parents=True)
            model = 'fixture/test' if provider == 'opencode' else 'fixture-model'
            if code_mode_model:
                model = code_mode_model
                (root/'model-catalog.json').write_text(json.dumps({'models':[{
                    'slug':model, 'display_name':model, 'description':'Synthetic code-mode model',
                    'default_reasoning_level':'medium', 'supported_reasoning_levels':[],
                    'shell_type':'unified_exec', 'visibility':'list', 'supported_in_api':True,
                    'priority':1, 'base_instructions':'You are a mail assistant using the supplied tools.',
                    'include_skills_usage_instructions':False, 'include_plugin_usage_instructions':False,
                    'support_verbosity':True, 'default_verbosity':'low', 'apply_patch_tool_type':'freeform',
                    'truncation_policy':{'mode':'tokens','limit':10000}, 'context_window':272000,
                    'effective_context_window_percent':95, 'experimental_supported_tools':[],
                    'supports_search_tool':True, 'tool_mode':'code_mode_only', 'multi_agent_version':'v2'
                }]}))
            base = f'http://127.0.0.1:{server.server_port}/v1'
            forbidden = root/'unrelated-integration-started'
            plugin = root/'unrelated-plugin.mjs'
            plugin.write_text("import fs from 'node:fs'; fs.writeFileSync("+json.dumps(str(forbidden))+", 'plugin'); export default async () => ({});\n")
            (config/'opencode.json').write_text(json.dumps({
                'model':'fixture/default','update':'disable','snapshots':False,
                'plugins':[str(plugin)],
                'mcp':{'servers':{'unrelated':{'type':'local','command':['/usr/bin/touch',str(forbidden)]}}},
                'providers':{'fixture':{'package':'@opencode/ai/providers/openai-compatible',
                    'settings':{'baseURL':base,'apiKey':'synthetic'},'models':{
                        'test':{'limit':{'context':100000,'output':1000}},
                        'default':{'limit':{'context':100000,'output':1000}}}}}
            }))
            codex = root/'codex'
            codex.mkdir()
            (codex/'config.toml').write_text(f'''model = "configured-default"
model_provider = "fixture"
check_for_update_on_startup = false
cli_auth_credentials_store = "file"
[model_providers.fixture]
name = "fixture"
base_url = "{base}"
wire_api = "responses"
http_headers = {{ "X-Synthetic-Auth" = "synthetic-header-secret" }}
[features]
enable_request_compression = false
[mcp_servers.unrelated]
command = "/usr/bin/touch"
args = [{json.dumps(str(forbidden))}]
''')
            env = {'PATH':('/usr/bin:/bin' if sys.platform == 'darwin' else str(toolbin)+':/usr/bin:/bin'), 'HOME':str(root),
                   'XDG_CONFIG_HOME':str(root/'config'),'XDG_DATA_HOME':str(root/'data'),
                   'XDG_STATE_HOME':str(root/'state'),'XDG_CACHE_HOME':str(root/'cache'),
                   'TMPDIR':str(root),'CODEX_HOME':str(codex)}
            if provider == 'claude':
                env.update(ANTHROPIC_API_KEY='synthetic', ANTHROPIC_BASE_URL=base.removesuffix('/v1'),
                           ANTHROPIC_MODEL='configured-default', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1')
                settings=root/'.claude'; settings.mkdir()
                (settings/'settings.json').write_text(json.dumps({'hooks':{'SessionStart':[{'hooks':[{'type':'command','command':'touch '+str(forbidden)}]}]}}))
                (root/'.claude.json').write_text(json.dumps({'mcpServers':{'unrelated':{'command':'/usr/bin/touch','args':[str(forbidden)]}}}))
            broker = None
            def call(method, params):
                if sys.platform == 'darwin' and method == 'agent.jobStart' and not params.get('payload',{}).get('parent'):
                    params = dict(params, provider=provider)
                result = subprocess.run([str(BINARY),'--json','call',method],input=json.dumps(params),
                                        text=True,capture_output=True,env=env,cwd=root,timeout=10)
                self.assertEqual(result.returncode,0,result.stderr or result.stdout)
                return json.loads(result.stdout)['result']
            def wait(ident):
                deadline = time.monotonic() + 60
                while time.monotonic() < deadline:
                    result = call('agent.jobShow',{'id':ident})
                    if result['job']['state'] not in ('queued','running'):
                        if result['job']['state'] != 'done':
                            if provider == 'claude': print('SYNTHETIC CLAUDE REQUESTS',server.requests[-2:])
                            for log in root.glob('synthetic-cli-*.log'): print(log.name,log.read_text()[-4000:])
                            if broker and broker.poll() is not None: print('BROKER ERROR',broker.stderr.read().decode())
                            for log in root.rglob('opencode.log'):
                                print('SYNTHETIC LOG', log.read_text()[-8000:])
                            for log in codex.rglob('*.jsonl'):
                                print('SYNTHETIC CODEX LOG', log.read_text()[-8000:])
                        self.assertEqual(result['job']['state'],'done',result)
                        return result
                    time.sleep(.05)
                self.fail('CLI did not finish')
            first = call('agent.jobStart', {'model':model,'payload':{
                'messageId':'synthetic','prompt':'Summarize this synthetic text.',
                'message':'Synthetic fixture only. No real mail.'}})['id']
            try:
                initial = wait(first)
                self.assertFalse(forbidden.exists(), 'Unrelated configured MCP/plugin must never start')
                if provider == 'claude':
                    self.assertTrue(all([tool['name'] for tool in request.get('tools',[])] == ['mcp__omamail__propose_draft'] for request in server.requests))
                if provider == 'codex':
                    self.assertNotIn('synthetic-header-secret',(root/'synthetic-cli-argv.json').read_text())
                    self.assertTrue(any(any(key.lower()=='x-synthetic-auth' and value=='synthetic-header-secret' for key,value in headers.items()) for headers in server.headers))
                    catalogs = [[tool.get('name',tool.get('type')) for tool in request.get('tools',[])] for request in server.requests]
                    allowed = {'list_mcp_resources','list_mcp_resource_templates','read_mcp_resource','mcp__omamail'}
                    if code_mode_model: allowed |= {'exec','wait'}
                    self.assertTrue(all(set(names) <= allowed for names in catalogs), catalogs)
                    for request in server.requests:
                        for tool in request.get('tools',[]):
                            if tool.get('name') == 'mcp__omamail':
                                self.assertEqual([t['name'] for t in tool['tools']],['propose_draft'])
                self.assertEqual(initial['output'],'Synthetic answer مرحبا')
                self.assertEqual(initial['job']['provider'],provider)
                self.assertEqual(initial['job']['model'],model)
                if proposals:
                    if not initial['proposals']:
                        for log in root.rglob('opencode.log'):
                            print('SYNTHETIC MCP LOG', '\n'.join(line for line in log.read_text().splitlines() if any(word in line.lower() for word in ('mcp','error','location','workspace')))[-20000:])
                    self.assertEqual(len(initial['proposals']),1, server.requests)
                    self.assertEqual(initial['proposals'][0]['body'],'The exact proposed body.')
                    self.assertTrue(initial['proposals'][0]['applicable'])
                    self.assertTrue(any(entry.get('role')=='status' and entry.get('text')=='Creating draft' for entry in initial['transcript']),initial['transcript'])
                self.assertTrue(any(request['model'] == ('test' if provider == 'opencode' else model) for request in server.requests))
                child = call('agent.jobStart',{'payload':{'parent':first,'prompt':'Make it shorter.'}})['id']
                try:
                    final = wait(child)
                    self.assertEqual(final['output'],'Synthetic answer مرحبا')
                    self.assertTrue(final['job']['canContinue'])
                    self.assertEqual(final['job']['sessionId'],initial['job']['sessionId'])
                    if proposals:
                        self.assertTrue(any(p['jobId']==child and p['applicable'] for p in final['proposals']), final)
                    self.assertEqual(call('agent.jobShow',{'id':first})['transcript'],initial['transcript'])
                    self.assertGreaterEqual(len(server.requests),2)
                    if provider == 'opencode':
                        self.assertTrue(all(not request.get('tools') or [t['function']['name'] for t in request['tools']]==['omamail_propose_draft'] for request in server.requests), 'Only the proposal tool may be exposed')
                        systems=[message for request in server.requests for message in request.get('messages',[]) if message.get('role')=='system']
                        self.assertTrue(any("Omamail's mail conversation assistant" in json.dumps(message) for message in systems))
                finally:
                    call('agent.jobCancel',{'id':child})
                server.requests.clear()
                default = call('agent.jobStart',{'payload':{'messageId':'synthetic-default','prompt':'Synthetic default model test.'}})['id']
                try:
                    result = wait(default)
                    self.assertEqual(result['job']['model'],'')
                    expected = 'default' if provider == 'opencode' else 'configured-default'
                    self.assertTrue(any(request['model'] == expected for request in server.requests))
                finally:
                    call('agent.jobCancel',{'id':default})
                if proposals:
                    concurrent = []
                    try:
                        for index in range(2):
                            concurrent.append(call('agent.jobStart',{'model':model,'payload':{
                                'accountId':'synthetic-account-'+str(index),'messageId':'concurrent-'+str(index),
                                'prompt':'Draft a synthetic response.'}})['id'])
                        sessions=[]
                        for index, ident in enumerate(concurrent):
                            result=wait(ident)
                            self.assertEqual(len(result['proposals']),1,result)
                            proposal=result['proposals'][0]
                            self.assertEqual(proposal['jobId'],ident)
                            self.assertEqual(proposal['accountId'],'synthetic-account-'+str(index))
                            self.assertEqual(proposal['messageId'],'concurrent-'+str(index))
                            sessions.append(result['job']['sessionId'])
                        self.assertNotEqual(*sessions)
                    finally:
                        for ident in concurrent: call('agent.jobCancel',{'id':ident})
                # Background event extraction uses the same isolated launch
                # policy, with no draft tool or unrelated integrations.
                server.requests.clear()
                server.propose = False
                event = call('agent.jobStart', {'model':model, 'payload':{
                    'messageId':'synthetic-event', 'prompt':'Find calendar events.',
                    'message':'Synthetic meeting Thursday at 7pm.', 'events':True}})['id']
                try:
                    event_result = wait(event)
                    self.assertFalse(forbidden.exists(), 'Event extraction started an unrelated integration')
                    self.assertEqual(event_result['proposals'], [])
                    self.assertTrue(server.requests)
                    for request in server.requests:
                        names = [tool.get('name',tool.get('function',{}).get('name',tool.get('type'))) for tool in request.get('tools',[])]
                        allowed = {'list_mcp_resources','list_mcp_resource_templates','read_mcp_resource'} if provider == 'codex' else set()
                        if code_mode_model: allowed |= {'exec','wait'}
                        self.assertTrue(set(names) <= allowed, names)
                finally:
                    call('agent.jobCancel', {'id':event})
                    server.propose = proposals
                # Exercise real CLI/private-server teardown, not just the fake
                # worker's process-group unit test. Only this test's PID tree
                # is inspected; no other process data or session files are read.
                server.stall = True
                stopped = call('agent.jobStart',{'payload':{'messageId':'synthetic-cancel','prompt':'Synthetic cancellation test.'}})['id']
                try:
                    self.assertTrue(server.waiting.wait(30),'CLI reached the local fixture')
                    time.sleep(.2)
                    worker = call('agent.jobShow',{'id':stopped})['job']['pid']
                    children = agent_broker_fixture.descendants(worker)
                    self.assertTrue(children,'native CLI is a child of the worker')
                    call('agent.jobCancel',{'id':stopped})
                    for _ in range(100):
                        state = call('agent.jobShow',{'id':stopped})['job']['state']
                        if state not in ('queued','running'): break
                        time.sleep(.05)
                    self.assertEqual(state,'cancelled')
                    for pid in children:
                        self.assertFalse(agent_broker_fixture.alive(pid),f'CLI descendant {pid} survived cancellation')
                finally:
                    call('agent.jobCancel',{'id':stopped})
                    server.release.set()
                server.stall = False
                self.assertTrue(call('agent.jobShow',{'id':stopped})['job']['canContinue'])
                stopped_session=call('agent.jobShow',{'id':stopped})['job']['sessionId']
                if not omit_finish: self.assertTrue(stopped_session,'stopped native session identity retained')
                continuation = call('agent.jobStart',{'payload':{'parent':stopped,'prompt':'Continue with a shorter answer.'}})['id']
                try:
                    continued=wait(continuation)
                    self.assertEqual(continued['output'],'Synthetic answer مرحبا')
                    self.assertEqual(continued['job']['conversationId'],stopped)
                    self.assertEqual(call('agent.jobShow',{'id':stopped})['job']['state'],'cancelled')
                finally:
                    call('agent.jobCancel',{'id':continuation})
            finally:
                call('agent.jobCancel',{'id':first})
                agent_broker_fixture.shutdown(root)
                if broker:
                    broker.wait(timeout=10)
                    broker.stderr.close()

    @unittest.skipUnless(os.environ.get('OMAMAIL_TEST_OPENCODE'), 'set OMAMAIL_TEST_OPENCODE for isolated V2 CLI fixture')
    def test_opencode(self):
        self.exercise('opencode',os.environ['OMAMAIL_TEST_OPENCODE'])

    @unittest.skipUnless(os.environ.get('OMAMAIL_TEST_OPENCODE'), 'set OMAMAIL_TEST_OPENCODE for isolated V2 CLI fixture')
    def test_opencode_proposal(self):
        self.exercise('opencode',os.environ['OMAMAIL_TEST_OPENCODE'],proposals=True)

    @unittest.skipUnless(os.environ.get('OMAMAIL_TEST_OPENCODE'), 'set OMAMAIL_TEST_OPENCODE for isolated V2 CLI fixture')
    def test_opencode_durable_completion_without_step_finish(self):
        self.exercise('opencode',os.environ['OMAMAIL_TEST_OPENCODE'],omit_finish=True)

    @unittest.skipUnless(os.environ.get('OMAMAIL_TEST_CODEX'), 'set OMAMAIL_TEST_CODEX for isolated Codex CLI fixture')
    def test_codex(self):
        self.exercise('codex',os.environ['OMAMAIL_TEST_CODEX'])

    @unittest.skipUnless(os.environ.get('OMAMAIL_TEST_CODEX'), 'set OMAMAIL_TEST_CODEX for isolated CLI fixture')
    def test_codex_proposal(self):
        self.exercise('codex',os.environ['OMAMAIL_TEST_CODEX'],proposals=True)

    @unittest.skipUnless(os.environ.get('OMAMAIL_TEST_CODEX'), 'set OMAMAIL_TEST_CODEX for isolated CLI fixture')
    def test_codex_code_mode_models(self):
        for model in ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna']:
            with self.subTest(model=model):
                self.exercise('codex',os.environ['OMAMAIL_TEST_CODEX'],proposals=True,code_mode_model=model)

    @unittest.skipUnless(os.environ.get('OMAMAIL_TEST_CLAUDE'), 'set OMAMAIL_TEST_CLAUDE for isolated CLI fixture')
    def test_claude_proposal(self):
        self.exercise('claude',os.environ['OMAMAIL_TEST_CLAUDE'],proposals=True)


if __name__ == '__main__':
    unittest.main()
