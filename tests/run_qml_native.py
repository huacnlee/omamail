#!/usr/bin/env python3
"""QML tests with real native pure-model RPC through a loopback-only bridge."""
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

ROOT=Path(__file__).resolve().parents[1]
ALLOWED={'providers.resolve','model.intent','model.apply','model.unified','account.identities','account.conversation','agent.jobsProjection','message.render'}


def main():
    runner=sys.argv[1]
    with tempfile.TemporaryDirectory(prefix='omamail-native-qml-') as directory:
        directory=Path(directory)
        env=dict(os.environ,HOME=str(directory/'home'),XDG_CONFIG_HOME=str(directory/'config'),
                 XDG_CACHE_HOME=str(directory/'cache'),XDG_DATA_HOME=str(directory/'data'),XDG_STATE_HOME=str(directory/'state'),
                 QT_QPA_PLATFORM='offscreen',QT_QUICK_BACKEND='software',QT_QPA_PLATFORMTHEME='',GSETTINGS_BACKEND='memory')
        for name in ['home','config','cache','data','state']:(directory/name).mkdir()
        backend=subprocess.Popen([str(ROOT/'target/debug/omamail'),'serve'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
        lock=threading.Lock()
        secret=secrets.token_urlsafe(24)
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_POST(self):
                self.connection.settimeout(15)
                if self.path!='/'+secret:self.send_error(404);return
                try:length=int(self.headers.get('Content-Length','0'))
                except ValueError:self.send_error(400);return
                if length<=0:self.send_error(400);return
                if length>4*1024*1024:self.send_error(413);return
                try:request=json.loads(self.rfile.read(length))
                except (ValueError,UnicodeError):self.send_error(400);return
                if not isinstance(request,dict):self.send_error(400);return
                if request.get('method') not in ALLOWED:self.send_error(403);return
                with lock:
                    backend.stdin.write(json.dumps(request)+'\n');backend.stdin.flush()
                    while True:
                        line=backend.stdout.readline()
                        if not line:raise RuntimeError('Native test backend exited')
                        response=json.loads(line)
                        if response.get('id')==request.get('id'):break
                data=json.dumps(response).encode()
                self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
        server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        endpoint=f'http://127.0.0.1:{server.server_port}/{secret}'
        imports=directory/'imports'
        shutil.copytree(ROOT/'ui/tests/qml/imports',imports)
        mock=imports/'Quickshell/Quickshell.qml'
        mock.write_text(mock.read_text().replace('function env(name) { return "" }','function env(name) { return name === "OMAMAIL_TEST_BACKEND_URL" ? '+json.dumps(endpoint)+' : "" }'))
        try:
            arguments=[]
            rest=iter(sys.argv[2:])
            for argument in rest:
                if argument=='-import':
                    path=next(rest)
                    if Path(path).resolve()==ROOT/'ui/tests/qml/imports':continue
                    arguments.extend([argument,path])
                else:arguments.append(argument)
            command=[runner,*arguments,'-import',str(imports)]
            completed=subprocess.run(command,cwd=ROOT,env=dict(env,OMAMAIL_TEST_BACKEND_URL=endpoint))
        finally:
            server.shutdown();server.server_close()
            backend.terminate()
            try:backend.wait(timeout=5)
            except subprocess.TimeoutExpired:backend.kill();backend.wait()
        raise SystemExit(completed.returncode)


if __name__=='__main__':main()
