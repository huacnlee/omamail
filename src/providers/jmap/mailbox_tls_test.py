"""Synthetic native JMAP integration peer. All data and credentials are fictitious."""
import http.server
import json
import pathlib
import ssl
import socket
import subprocess
import tempfile
import threading

with tempfile.TemporaryDirectory(prefix="omamail-jmap-mailbox-") as directory:
    root = pathlib.Path(directory)
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(root / "key.pem"), "-out", str(root / "cert.pem"), "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost", "-addext", "basicConstraints=critical,CA:FALSE"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
    requests = []
    mode = "success"
    def email(id):
        folder = {"e1":"I", "e2":"S", "e3":"T"}.get(id,"I")
        return {"id":id,"threadId":"t1","mailboxIds":{folder:True},"keywords":{} if id != "e2" else {"$seen":True},"from":[{"email":"a@example.test","name":"Ada"}],"to":[{"email":"user@example.test"}],"subject":"Native test", "preview":"<3 native", "receivedAt":"2026-09-11T00:00:00Z", "bodyStructure":{"partId":"1","blobId":"tail","type":"text/plain","charset":"utf-8","size":13},"bodyValues":{"1":{"value":"short","isTruncated":True}}}
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self,*_args):
            pass
        def answer(self,payload,status=200):
            payload=json.dumps(payload).encode() if not isinstance(payload,bytes) else payload
            self.send_response(status);self.send_header("Content-Length",str(len(payload)));self.end_headers();self.wfile.write(payload)
        def do_GET(self):
            if self.path=="/report":
                self.answer(requests);threading.Thread(target=self.server.shutdown,daemon=True).start();return
            requests.append({"path":self.path,"authorization":bool(self.headers.get("Authorization"))})
            if self.path=="/events":
                payload=b'event: state\r\ndata: {"changed":{"account":{"Email":"e2","Mailbox":"m2"}}}\r\n\r\n'
                self.send_response(200);self.send_header("Content-Type","text/event-stream");self.send_header("Content-Length",str(len(payload)));self.end_headers();self.wfile.write(payload);return
            if self.path.startswith("/blob/"): self.answer(b"complete body")
            else: self.answer({},404)
        def do_POST(self):
            global mode
            raw=self.rfile.read(int(self.headers.get("Content-Length","0")))
            if self.path=="/upload":
                mode="fail" if b"Subject: fail" in raw else "importfail" if b"Subject: importfail" in raw else "uncertain" if b"Subject: uncertain" in raw else "success"
                requests.append({"path":self.path,"mode":mode,"authorization":bool(self.headers.get("Authorization"))});self.answer({"blobId":"uploaded"});return
            if self.path=="/refused":
                requests.append({"path":self.path,"authorization":bool(self.headers.get("Authorization"))});self.answer({},401);return
            body=json.loads(raw);requests.append({"path":self.path,"calls":body["methodCalls"],"authorization":bool(self.headers.get("Authorization"))})
            replies=[]
            for method,args,id in body["methodCalls"]:
                if method=="Email/query":
                    if "anchor" in args: replies.append(["error",{"type":"anchorNotFound"},id]);continue
                    result={"ids":["e1"],"position":0,"total":1,"queryState":"q1"}
                elif method=="Email/get":
                    if id=="3": replies.append(["error",{"type":"requestTooLarge"},id]);continue
                    result={"list":[email(v) for v in args.get("ids",["e1"])],"state":"e1"}
                elif method=="Thread/get": result={"list":[{"id":"t1","emailIds":["e1","e2","e3"]}],"state":"t1"}
                elif method=="Identity/get": result={"list":[{"id":"identity","email":"user@example.test","name":"User"}]}
                elif method=="Email/import": result={"notCreated":{"draft":{"type":"invalidEmail"}}} if mode=="importfail" else {"created":{"draft":{"id":"newdraft"}}}
                elif method=="EmailSubmission/set" and mode=="uncertain":
                    self.connection.shutdown(socket.SHUT_RDWR);self.connection.close();return
                elif method=="EmailSubmission/set": result={"notCreated":{"send":{"type":"forbiddenToSend"}}} if mode=="fail" else {"created":{"send":{"id":"submitted"}}}
                elif method=="Email/set" and args.get("destroy")==["old-fail"]: result={"notDestroyed":{"old-fail":{"type":"forbidden"}}}
                elif method=="Email/set": result={"updated":{key:None for key in args.get("update",{})},"destroyed":args.get("destroy",[])}
                elif method=="Mailbox/get": result={"list":[]}
                else: replies.append(["error",{"type":"unknownMethod"},id]);continue
                replies.append([method,result,id])
            self.answer({"methodResponses":replies,"sessionState":"s1"})
    server=http.server.HTTPServer(("127.0.0.1",0),Handler)
    context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);context.load_cert_chain(root / "cert.pem",root / "key.pem")
    server.socket=context.wrap_socket(server.socket,server_side=True)
    print(server.server_port,flush=True);print(root / "cert.pem",flush=True)
    server.serve_forever(poll_interval=0.05);server.server_close()
