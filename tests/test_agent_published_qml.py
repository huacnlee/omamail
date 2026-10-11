#!/usr/bin/env python3
"""Production Service/App/AgentRunner flow against the pinned API-5 executable.

Pass a checksum-verified published binary explicitly. Claude is a synthetic CLI;
no real mailbox, model, keyring or terminal is used. The loopback bridge admits
only the four agent methods needed by the fixture.
"""
import argparse
import http.server
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
ALLOWED = {'agent.jobStart', 'agent.jobsList', 'agent.jobShow', 'agent.jobsProjection'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--runner', default=shutil.which('qmltestrunner6') or '/usr/lib/qt6/bin/qmltestrunner')
    args = parser.parse_args()
    binary = str(args.binary.resolve())
    with tempfile.TemporaryDirectory(prefix='omamail-published-agent-') as temporary:
        root = Path(temporary).resolve()
        env = dict(os.environ, HOME=str(root), XDG_CONFIG_HOME=str(root/'config'),
                   XDG_CACHE_HOME=str(root/'cache'), XDG_STATE_HOME=str(root/'state'),
                   XDG_DATA_HOME=str(root/'data'), XDG_RUNTIME_DIR=str(root/'runtime'),
                   QT_QPA_PLATFORM='offscreen', QT_QUICK_BACKEND='software',
                   QT_QPA_PLATFORMTHEME='', GSETTINGS_BACKEND='memory')
        for name in ('config', 'cache', 'state', 'data', 'runtime', 'bin'):
            (root/name).mkdir(mode=0o700)
        env['PATH'] = os.pathsep.join([str(root/'bin'), str(Path(sys.executable).parent), '/usr/bin', '/bin'])
        def tool(name, source):
            path = root/'bin'/name
            path.write_text('#!'+sys.executable+'\n'+source+'\n')
            path.chmod(0o700)
        tool('omarchy-default-agent', 'print("claude")')
        tool('claude', '''import json, sys
from pathlib import Path
sys.stdin.read()
with Path.home().joinpath('launches.jsonl').open('a') as log:
    log.write(json.dumps(sys.argv[1:])+'\\n')
session = '11111111-2222-3333-4444-555555555555'
print(json.dumps({'type':'system','subtype':'init','session_id':session}), flush=True)
print(json.dumps({'type':'result','subtype':'success','result':'Synthetic Claude reply','session_id':session}), flush=True)
''')
        def rpc(method, params):
            result = subprocess.run([binary, '--json', 'call', method], input=json.dumps(params),
                                    text=True, capture_output=True, env=env, timeout=15)
            reply = json.loads(result.stdout)
            if reply.get('ok'):
                return {'result': reply['result']}
            return {'error': {'code': -32000, 'message': str(reply.get('error'))}}
        info = rpc('system.info', {})['result']
        assert info['version'] == (ROOT/'backend-version').read_text().strip(), info
        assert info['apiVersion'] == 5, 'This regression specifically exercises the API-5 compatibility path'
        secret = secrets.token_urlsafe(24)
        started = []
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(self):
                self.connection.settimeout(20)
                if self.path != '/'+secret:
                    self.send_error(404); return
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length < 1024*1024:
                    self.send_error(413); return
                request = json.loads(self.rfile.read(length))
                if request.get('method') not in ALLOWED:
                    self.send_error(403); return
                reply = rpc(request['method'], request.get('params', {}))
                if request['method'] == 'agent.jobStart' and 'result' in reply:
                    started.append(reply['result']['id'])
                data = json.dumps(reply).encode()
                self.send_response(200)
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        imports = root/'imports'
        shutil.copytree(ROOT/'ui/tests/qml/imports', imports)
        mock = imports/'Quickshell/Quickshell.qml'
        endpoint = f'http://127.0.0.1:{server.server_port}/{secret}'
        mock.write_text(mock.read_text().replace('function env(name) { return "" }',
            'function env(name) { return name === "OMAMAIL_TEST_AGENT_URL" ? '+json.dumps(endpoint)+' : "" }'))
        try:
            result = subprocess.run([args.runner, '-input', str(ROOT/'ui/tests/compatibility/tst_published_agent.qml'),
                                     '-import', str(imports)], env=env, timeout=75)
        finally:
            server.shutdown(); server.server_close()
            for ident in started:
                rpc('agent.jobCancel', {'id': ident})
            deadline = time.monotonic()+8
            for ident in started:
                while rpc('agent.jobShow', {'id': ident}).get('result', {}).get('job', {}).get('state') in ('queued', 'running'):
                    assert time.monotonic() < deadline, 'Worker did not stop'
                    time.sleep(.04)
        assert result.returncode == 0, 'Published QML user-flow regression failed'
        launches = [json.loads(line) for line in (root/'launches.jsonl').read_text().splitlines()]
        assert len(launches) == 4, launches
        assert sum('--resume' in argv for argv in launches) == 2, launches
        print(f'Published {info["version"]}/API 5: reader/composer entry, four real jobs, two Claude continuations, insertion and no send PASS')


if __name__ == '__main__':
    main()
