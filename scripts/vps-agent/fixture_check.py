import json, os, sqlite3, threading, sys, http.server, time
import shutil; shutil.rmtree("/tmp/vps-fixture", ignore_errors=True); __import__("os").makedirs("/tmp/vps-fixture")
os.environ["INVERK_AGENT_CONF"]="/tmp/vps-fixture/conf"; os.environ["INVERK_AGENT_STATE"]="/tmp/vps-fixture/state"
db="/tmp/vps-fixture/rs.sqlite3"; [os.remove(db+x) for x in ("","-wal","-shm") if os.path.exists(db+x)]
c=sqlite3.connect(db)
c.executescript("""create table stories(id TEXT PRIMARY KEY, community TEXT, title TEXT, url TEXT, seen INTEGER);
create table archive_text(id TEXT PRIMARY KEY, body TEXT, manual INTEGER);
create table settings(id INTEGER PRIMARY KEY, enabled INTEGER, minutes INTEGER);
insert into settings values(1,1,60); insert into stories values('t3_old','AskReddit','Old','https://www.reddit.com/r/AskReddit/comments/old/x/',1);
create table secrets(token text); insert into secrets values('SHOULD_NOT_MIRROR');""")
c.commit(); c.close(); open("/tmp/vps-fixture/buffer.key","w").write("BUFKEY")
mirror={}; gq=[]; mode={"draft":"ok"}
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(s):
        b=json.loads(s.rfile.read(int(s.headers["content-length"])))
        if s.path=="/buffer":
            assert s.headers["authorization"]=="Bearer BUFKEY"; q=b["query"]; gq.append(q.split("{")[0].strip())
            if "account" in q: d={"account":{"organizations":[{"id":"org1"}]}}
            elif "channels(" in q: d={"channels":[{"id":"6b00651cece6dfde5f33640c","name":"inverk","service":"tiktok"}]}
            elif "posts(" in q: d={"posts":{"edges":[{"node":{"id":"p1","text":"hi","status":"draft","dueAt":None,"channelId":"6b00651cece6dfde5f33640c"}}]}}
            else:
                inp=b["variables"]["input"]; assert inp["saveToDraft"] is True and inp["mode"]=="addToQueue" and inp["assets"][0]["video"]["url"].startswith("https://")
                if mode["draft"]=="hang": time.sleep(3)
                d={"createPost":{"post":{"id":"newpost"}}}
            out={"data":d}
        else:
            if b["action"]=="mirror": mirror[b["kind"]]=b["rows"]
            out={"token":"vpa_x","agent_id":"A","server_ts":"T"}
        s.send_response(200); s.end_headers(); s.wfile.write(json.dumps(out).encode())
    def log_message(s,*a): pass
srv=http.server.ThreadingHTTPServer(("127.0.0.1",0),H); threading.Thread(target=srv.serve_forever,daemon=True).start()
base=f"http://127.0.0.1:{srv.server_port}"
os.makedirs("/tmp/vps-fixture/conf",exist_ok=True); json.dump({"server":base,"db":db,"buffer_key":"/tmp/vps-fixture/buffer.key"},open("/tmp/vps-fixture/conf/config.json","w"))
sys.path.insert(0,os.path.join(os.path.dirname(os.path.abspath(__file__)),"../../public/vps")); import inverk_agent as A; A.BUFFER_URL=base+"/buffer"
A.pair("GOOD"); cf=A.conf(); st=A.load_state()
u="https://www.reddit.com/r/GTA6/comments/1AbC2d/leak_talk/"
r1=A.run_op(cf,"t",{"id":"c1","op":"reddit.add","args":{"url":u,"title":"Leak","body":"first"}},st)
r2=A.run_op(cf,"t",{"id":"c2","op":"reddit.add","args":{"url":u,"body":"edited"}},st)
x=sqlite3.connect(db); print("add:",r1["result"],"| again:",r2["result"]["existing"])
print("rows:",x.execute("select * from stories where id='t3_1abc2d'").fetchall(), x.execute("select * from archive_text").fetchall())
r3=A.run_op(cf,"t",{"id":"c3","op":"collect.set","args":{"enabled":False,"minutes":15}},st); print("settings:",x.execute("select * from settings").fetchall())
print("mirror kinds:",sorted(mirror),"| secret leaked:", "SHOULD_NOT_MIRROR" in json.dumps(mirror))
print("story mirrored:",[m for m in mirror["stories"] if m["key"]=="t3_1abc2d"][0]["data"], "| settings:",mirror["settings"])
A.mirror_buffer(cf,"t"); print("buffer:",mirror["buffer:channels"],len(mirror["buffer:posts"]),"err:",mirror["buffer:error"])
args={"channel_id":"6b00651cece6dfde5f33640c","text":"cap","video_url":"https://x.example/v.mp4"}
print("draft:",A.run_op(cf,"t",{"id":"d1","op":"buffer.create_draft","args":args},st))
mode["draft"]="hang"; orig=A.gql; A.gql=lambda c,q,v=None,timeout=30: orig(c,q,v,timeout=1)
print("timeout:",A.run_op(cf,"t",{"id":"d2","op":"buffer.create_draft","args":args},st)["error"][:60])
del st["done"]["d2"]; mode["draft"]="ok"
print("retry same cmd:",A.run_op(cf,"t",{"id":"d2","op":"buffer.create_draft","args":args},st)["error"][:70])
print("graphql calls:",gq)
