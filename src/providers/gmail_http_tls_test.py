"""Synthetic TLS peer: report whether certificate refusal prevented HTTP bytes."""
import pathlib
import socket
import ssl
import sys

root = pathlib.Path(__file__).parent / "testdata" / "tls"
with socket.socket() as listener:
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(root / "server.pem", root / "server-key.pem")
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    listener.settimeout(10)
    print(listener.getsockname()[1], flush=True)
    print(root / "ca.pem", flush=True)
    for _ in range(int(sys.argv[1]) if len(sys.argv) > 1 else 2):
        connection, _ = listener.accept()
        connection.settimeout(5)
        try:
            with context.wrap_socket(connection, server_side=True) as secure:
                request = bytearray()
                while not request.endswith(b"\r\n\r\n") and len(request) < 65536:
                    chunk = secure.recv(4096)
                    if not chunk:
                        break
                    request.extend(chunk)
                print("http-received" if request else "empty", flush=True)
                if request:
                    secure.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{"ok":true}')
        except ssl.SSLError:
            print("tls-refused-no-http", flush=True)
        finally:
            connection.close()
