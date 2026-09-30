"""Close only the private broker created under a synthetic test HOME."""
import fcntl
import socket
import subprocess
import time


def alive(pid):
    result = subprocess.run(['ps', '-o', 'stat=', '-p', str(pid)], capture_output=True, text=True)
    return result.returncode == 0 and bool(result.stdout.strip()) and not result.stdout.strip().startswith('Z')


def descendants(pid):
    result = subprocess.run(['pgrep', '-P', str(pid)], capture_output=True, text=True)
    children = [int(line) for line in result.stdout.split() if line.isdigit()]
    return children + [child for parent in children for child in descendants(parent)]


def shutdown(root):
    directory = root / 'state/omamail/agent-runtime'
    for path in directory.glob('server.sock'):
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(5)
            client.connect(str(path))
            client.recv(4096)
            client.sendall(b's')
    for lock in directory.glob('*.lock'):
        with lock.open('rb') as stream:
            deadline = time.monotonic() + 10
            while True:
                try:
                    fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    return
                except BlockingIOError:
                    if time.monotonic() > deadline:
                        raise AssertionError('Synthetic OpenCode broker did not stop')
                    time.sleep(.02)
