import json,time,urllib.request
from screen import PROVIDERS
_,TOK=PROVIDERS["zai"]
ANTH="https://api.z.ai/api/anthropic/v1/messages"
OAI ="https://api.z.ai/api/coding/paas/v4/chat/completions"
Q="explain what TTFT means for an LLM in about 100 words"

def anth(model,nothink):
    b={"model":model,"max_tokens":400,"stream":True,"messages":[{"role":"user","content":Q}]}
    if nothink: b["thinking"]={"type":"disabled"}
    r=urllib.request.Request(ANTH,data=json.dumps(b).encode(),
      headers={"content-type":"application/json","anthropic-version":"2023-06-01",
               "Authorization":"Bearer "+TOK,"x-api-key":TOK})
    t0=time.monotonic(); tf=tl=hf=None; tn=hn=0
    with urllib.request.urlopen(r,timeout=120) as resp:
        for raw in resp:
            s=raw.decode("utf-8","replace").strip()
            if not s.startswith("data:"): continue
            try: ev=json.loads(s[5:].strip())
            except: continue
            if ev.get("type")!="content_block_delta": continue
            d=ev.get("delta",{}); now=time.monotonic()-t0
            if d.get("type")=="thinking_delta":
                hn+=1; hf=hf if hf is not None else now
            elif d.get("type")=="text_delta":
                tn+=1; tl=now
                if tf is None: tf=now
    return tf,tl,tn,hn

def oai(model,nothink):
    b={"model":model,"max_tokens":400,"stream":True,"messages":[{"role":"user","content":Q}]}
    if nothink: b["thinking"]={"type":"disabled"}
    r=urllib.request.Request(OAI,data=json.dumps(b).encode(),
      headers={"content-type":"application/json","Authorization":"Bearer "+TOK})
    t0=time.monotonic(); tf=tl=None; tn=hn=0
    with urllib.request.urlopen(r,timeout=120) as resp:
        for raw in resp:
            s=raw.decode("utf-8","replace").strip()
            if not s.startswith("data:"): continue
            p=s[5:].strip()
            if p=="[DONE]": break
            try: ev=json.loads(p)
            except: continue
            d=(ev.get("choices") or [{}])[0].get("delta") or {}
            now=time.monotonic()-t0
            if d.get("reasoning_content"): hn+=1
            if d.get("content"):
                tn+=1; tl=now
                if tf is None: tf=now
    return tf,tl,tn,hn

f=lambda x:"%5.2f"%x if x is not None else "  -  "
print("%-12s %-9s %-6s %8s %8s %7s %8s  %s"%("model","surface","think","txt1st","txtlast","txtN","reasonN","verdict"))
print("-"*86)
for m in ["glm-5.2","glm-4.6","glm-5-turbo"]:
    for sname,fn in (("anthropic",anth),("openai",oai)):
        for nt in (False,True):
            try: tf,tl,tn,hn=fn(m,nt)
            except Exception as e:
                print("%-12s %-9s %-6s ERR %s"%(m,sname,"off" if nt else "on",str(e)[:40])); continue
            if tn==0: v="NO TEXT"
            elif tl is not None and tf is not None and (tl-tf)>0.3: v="streams"
            else: v="BURST"
            print("%-12s %-9s %-6s %8s %8s %7d %8d  %s"%(
                m,sname,"off" if nt else "on",f(tf),f(tl),tn,hn,v))
