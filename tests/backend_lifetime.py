"""Linux process-lifetime regression; uses synthetic accounts and no network.

The single-threaded supervisor adopts/reaps descendants and deliberately holds
the backend stdin open after its launcher dies.
"""
import ctypes
import json
import os
from pathlib import Path
import select
import signal
import time
import sys
import tempfile

BINARY = Path(sys.argv[1]).resolve()
# Keep all synthetic state under the caller-supplied build/review directory.
workspace = tempfile.TemporaryDirectory(prefix='backend-lifetime-', dir=sys.argv[2])
ROOT = Path(workspace.name).resolve()
mode = sys.argv[3]
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
    raise OSError(ctypes.get_errno(), 'cannot become test subreaper')

env = {'HOME': os.environ['HOME'], 'LANG': 'C.UTF-8', 'PATH': '/usr/bin:/bin'}
for key, leaf in [('XDG_CONFIG_HOME', 'config'), ('XDG_CACHE_HOME', 'cache'),
                  ('XDG_DATA_HOME', 'data'), ('XDG_STATE_HOME', 'state'),
                  ('XDG_RUNTIME_DIR', 'runtime')]:
    path = ROOT / 'isolated' / leaf
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    env[key] = str(path)
(ROOT / 'isolated/config/omamail').mkdir(exist_ok=True)
(ROOT / 'isolated/config/omamail/accounts.json').write_text(
    '{"version":1,"accounts":[],"activeId":""}')

in_r, in_w = os.pipe()
out_r, out_w = os.pipe()
control_r, control_w = os.pipe()
parent = None
backend = None
reaped = set()
result = {}

def read_line(fd, timeout=5):
    answer = b''
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], max(0, deadline - time.monotonic()))
        if not ready:
            raise TimeoutError('synthetic response deadline')
        byte = os.read(fd, 1)
        if not byte:
            raise EOFError('synthetic response closed')
        answer += byte
        if byte == b'\n':
            return answer
        if len(answer) > 1048576:
            raise ValueError('synthetic response limit')
    raise TimeoutError('synthetic response deadline')

def info(number):
    os.write(in_w, (json.dumps({'jsonrpc': '2.0', 'id': number,
                             'method': 'system.info'}) + '\n').encode())
    reply = json.loads(read_line(out_r))
    assert reply['id'] == number and reply['result']['name'] == 'omamail', reply
    return reply['result']

def reap(pid):
    if pid is None or pid <= 0 or pid in reaped:
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        try:
            found, status = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            reaped.add(pid)
            return
        if found:
            reaped.add(pid)
            return
        time.sleep(0.02)
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    os.waitpid(pid, 0)
    reaped.add(pid)

try:
    parent = os.fork()
    if parent == 0:
        os.close(in_w)
        os.close(out_r)
        os.close(control_r)
        child = os.fork()
        if child == 0:
            os.close(control_w)
            # Even a host that ignores/blocks TERM must not leave an orphan.
            if mode == 'parent-death':
                signal.signal(signal.SIGTERM, signal.SIG_IGN)
                signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM})
            os.dup2(in_r, 0)
            os.dup2(out_w, 1)
            null = os.open(os.devnull, os.O_WRONLY)
            os.dup2(null, 2)
            os.chdir(ROOT)
            try:
                os.execve(str(BINARY), [str(BINARY), 'serve'], env)
            except BaseException:
                os._exit(127)
        os.close(in_r)
        os.close(out_w)
        os.write(control_w, (str(child) + '\n').encode())
        os.close(control_w)
        if mode == 'parent-death':
            while True:
                signal.pause()
        _, status = os.waitpid(child, 0)
        os._exit(os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else 1)
    os.close(in_r)
    os.close(out_w)
    os.close(control_w)
    backend = int(read_line(control_r))
    info(1)
    assert Path(f'/proc/{backend}/status').read_text().split('PPid:')[1].split()[0] == str(parent)
    if mode == 'parent-death':
        os.kill(parent, signal.SIGKILL)
        os.waitpid(parent, 0)
        reaped.add(parent)
        # in_w remains open in this independent supervisor: EOF cannot pass.
    elif mode == 'quit':
        os.write(in_w, b'{"jsonrpc":"2.0","id":2,"method":"system.quit"}\n')
        assert json.loads(read_line(out_r))['id'] == 2
    elif mode == 'eof':
        os.close(in_w)
        in_w = -1
    else:
        raise ValueError(mode)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        found, status = os.waitpid(backend if mode == 'parent-death' else parent, os.WNOHANG)
        if found:
            reaped.add(backend)
            if mode != 'parent-death':
                reaped.add(parent)
            break
        time.sleep(0.02)
    else:
        raise AssertionError(f'backend survived {mode} with inherited stdin held open')
    if mode == 'parent-death':
        assert os.WIFSIGNALED(status) and os.WTERMSIG(status) == signal.SIGKILL, status
    else:
        assert os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0, status
    result = {'passed': mode}

finally:
    reap(parent)
    reap(backend)
    for fd in (in_r, in_w, out_r, out_w, control_r, control_w):
        try:
            os.close(fd)
        except OSError:
            pass
    result['cleanupReapedAll'] = all(pid in reaped for pid in (parent, backend) if pid)
    workspace.cleanup()
    print(json.dumps(result))
