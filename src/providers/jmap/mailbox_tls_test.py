"""Synthetic native JMAP integration peer. All data and credentials are fictitious."""
import contextlib
import http.server
import json
import pathlib
import ssl
import socket
import threading
import sys

scenario = sys.argv[1] if len(sys.argv) > 1 else "default"

with contextlib.nullcontext(pathlib.Path(__file__).parent.parent / "testdata" / "tls") as root:
    requests = []
    email_gets = 0
    mode = "success"
    def email(id):
        folder = {"e1":"I", "e2":"S", "e3":"T"}.get(id,"I")
        keywords = {"$seen":True} if id == "e1" else {"$flagged":True} if id == "e2" else {}
        result = {"id":id,"threadId":"t1","mailboxIds":{folder:True},"keywords":keywords,"from":[{"email":"a@example.test","name":"Ada"}],"to":[{"email":"user@example.test"}],"subject":"Native test", "preview":"<3 native", "receivedAt":"2026-09-11T00:00:00Z", "bodyStructure":{"partId":"1","blobId":"tail","type":"text/plain","charset":"utf-8","size":13},"bodyValues":{"1":{"value":"short","isTruncated":True}}}
        if scenario in ("occurrences", "member-bytes") and id == "e2": result["threadId"] = "t2"
        if scenario == "roles": result["mailboxIds"] = {"NEW" if id == "e1" else "I": True}
        if scenario == "empty": result["mailboxIds"] = {"S": True}
        if scenario == "bad-membership": result["mailboxIds"] = {"I": "true"}
        return result
    def members(thread):
        if scenario == "oversized-thread": return ["e1"] + ["m" + str(i) for i in range(2000)]
        if scenario == "occurrences": return ["e1"] * (1000 if thread == "t1" else 1001)
        if scenario == "member-bytes": return [("x" * 5990) + thread + str(i) for i in range(400)]
        if scenario == "projection-bytes": return [("x" * 5990) + str(i) for i in range(400)]
        if scenario == "projection-count": return ["e1", "e2", "e4"] + ["m" + str(i) for i in range(664)]
        if scenario == "projection-at-limit": return ["e1", "e2"] + ["m" + str(i) for i in range(998)]
        if scenario == "repeated": return ["e1", "e2"]
        if scenario == "bad-member": return ["e1", 123]
        return ["e1", "e2", "e3"]
    class Handler(http.server.BaseHTTPRequestHandler):
        def parse_request(self):
            parsed = super().parse_request()
            if parsed:
                self.record = {"method":self.command,"path":self.path,"authorization":bool(self.headers.get("Authorization"))}
                requests.append(self.record)
            return parsed
        def log_message(self,*_args):
            pass
        def answer(self,payload,status=200):
            payload=json.dumps(payload).encode() if not isinstance(payload,bytes) else payload
            self.send_response(status);self.send_header("Content-Length",str(len(payload)));self.end_headers();self.wfile.write(payload)
        def do_GET(self):
            if self.path=="/report":
                # Omit only this final harness read from the returned snapshot.
                self.answer(requests[:-1]);threading.Thread(target=self.server.shutdown,daemon=True).start();return
            if self.path=="/events":
                payload=b'event: state\r\ndata: {"changed":{"account":{"Email":"e2","Mailbox":"m2"}}}\r\n\r\n'
                self.send_response(200);self.send_header("Content-Type","text/event-stream");self.send_header("Content-Length",str(len(payload)));self.end_headers();self.wfile.write(payload);return
            if self.path.startswith("/blob/"): self.answer(b"complete body")
            else: self.answer({},404)
        def do_POST(self):
            global mode, email_gets
            raw=self.rfile.read(int(self.headers.get("Content-Length","0")))
            if self.path=="/upload":
                mode="fail" if b"Subject: fail" in raw else "importfail" if b"Subject: importfail" in raw else "uncertain" if b"Subject: uncertain" in raw else "success"
                self.record["mode"]=mode;self.answer({"blobId":"uploaded"});return
            if self.path=="/refused":
                self.answer({},401);return
            try:
                body=json.loads(raw)
                calls=body["methodCalls"]
                if not isinstance(calls,list) or any(not isinstance(call,list) or len(call)!=3 for call in calls): raise ValueError("invalid methodCalls")
            except (ValueError, KeyError, TypeError):
                self.record["malformed"]=True;self.answer({},400);return
            self.record["calls"]=calls
            replies=[]
            for method,args,id in body["methodCalls"]:
                if method=="Email/query":
                    if "anchor" in args: replies.append(["error",{"type":"anchorNotFound"},id]);continue
                    result={"ids":["e1"],"position":0,"total":1,"queryState":"q1"}
                elif method=="Email/get":
                    email_gets += 1
                    if id=="3": replies.append(["error",{"type":"requestTooLarge"},id]);continue
                    result={"list":[email(v) for v in args.get("ids",["e1"])],"state":"e1"}
                    if scenario=="unsolicited-email": result["list"].append(email("unrequested"))
                    if scenario=="missing-email": result["list"]=[]
                    if scenario=="duplicate-email": result["list"].append(result["list"][0])
                    if scenario=="bad-email": result["list"][0]["threadId"]=42
                    if email_gets > 1:
                        if scenario=="unsolicited-member": result["list"].append(email("unrequested"))
                        if scenario=="missing-member": result["list"]=[]
                        if scenario=="duplicate-member": result["list"].append(result["list"][0])
                elif method=="Thread/get":
                    result={"list":[{"id":v,"emailIds":members(v)} for v in args.get("ids",["t1"])],"state":"t1"}
                    if scenario=="unsolicited-thread": result["list"].append({"id":"unrequested","emailIds":["e1"]})
                    if scenario=="missing-thread": result["list"]=[]
                    if scenario=="duplicate-thread": result["list"].append(result["list"][0])
                elif method=="Identity/get": result={"list":[{"id":"identity","email":"user@example.test","name":"User"}]}
                elif method=="Email/import": result={"notCreated":{"draft":{"type":"invalidEmail"}}} if mode=="importfail" else {"created":{"draft":{"id":"newdraft"}}}
                elif method=="EmailSubmission/set" and mode=="uncertain":
                    self.connection.shutdown(socket.SHUT_RDWR);self.connection.close();return
                elif method=="EmailSubmission/set": result={"notCreated":{"send":{"type":"forbiddenToSend"}}} if mode=="fail" else {"created":{"send":{"id":"submitted"}}}
                elif method=="Email/set" and args.get("destroy")==["old-fail"]: result={"notDestroyed":{"old-fail":{"type":"forbidden"}}}
                elif method=="Email/set" and scenario=="action-unknown" and "e2" in args.get("update",{}): result={"updated":[]}
                elif method=="Email/set" and scenario=="action-failed": result={"notUpdated":{key:{"type":"forbidden","description":"synthetic-secret"} for key in args.get("update",{})}}
                elif method=="Email/set" and scenario=="partial-action": result={"updated":{"e1":None},"notUpdated":{"e2":{"type":"notFound","description":"synthetic-secret"}}}
                elif method=="Email/set": result={"updated":{key:None for key in args.get("update",{})},"destroyed":args.get("destroy",[])}
                elif method=="Mailbox/get":
                    result={"list":[{"id":"I","role":"inbox"},{"id":"S","role":"sent"},{"id":"T","role":"trash"},{"id":"A","role":"archive"},{"id":"D","role":"drafts"}]}
                    if scenario!="default": result["list"].append({"id":"J","role":"junk"})
                    missing={"no-archive":"archive","no-trash":"trash","no-inbox":"inbox"}.get(scenario)
                    result["list"]=[box for box in result["list"] if box["role"]!=missing]
                    if scenario=="roles": result["list"][0]["id"]="NEW"
                else: replies.append(["error",{"type":"unknownMethod"},id]);continue
                replies.append([method,result,id])
            self.answer({"methodResponses":None if scenario=="bad-envelope" else replies,"sessionState":"s1"})
    server=http.server.HTTPServer(("127.0.0.1",0),Handler)
    context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);context.load_cert_chain(root / "server.pem",root / "server-key.pem")
    server.socket=context.wrap_socket(server.socket,server_side=True)
    print(server.server_port,flush=True);print(root / "ca.pem",flush=True)
    server.serve_forever(poll_interval=0.05);server.server_close()
