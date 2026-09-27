#!/usr/bin/env python3
"""One-shot status of the whole vector-DB pipeline: collections, ingest progress,
live runs, memory, and the scheduled stop.  Read-only, safe to run anytime.

  ./content_shards/vdb_status.sh          # one snapshot
  ./content_shards/vdb_status.sh --watch  # refresh every 5s
"""
import glob, json, os, subprocess, sys, time, urllib.request

QDRANT = "http://localhost:6333"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CKPT = os.path.join(ROOT, "content_shards", "ingest_checkpoint.json")
CORPUS_TOTAL = 451492  # distinct docs across all shards (from full shard scan 2026-07-08)

G="\033[32m"; Y="\033[33m"; R="\033[31m"; DIM="\033[2m"; B="\033[1m"; C="\033[36m"; X="\033[0m"


def qget(path, timeout=5):
    try:
        return json.load(urllib.request.urlopen(f"{QDRANT}{path}", timeout=timeout))["result"]
    except Exception:
        return None


def procs(pat):
    try:
        out = subprocess.run(["pgrep","-af",pat], capture_output=True, text=True, timeout=5).stdout.strip()
        return [l for l in out.splitlines() if "pgrep" not in l]
    except Exception:
        return []


def mem():
    d={}
    for line in open("/proc/meminfo"):
        k,_,v=line.partition(":"); d[k]=int(v.split()[0])//1024
    return d


def ckpt_docs():
    try:
        return len(json.load(open(CKPT)).get("processed",[]))
    except Exception:
        return None


def last_ingest_line():
    logs=sorted(glob.glob(os.path.join(ROOT,"ingest_*.log")), key=os.path.getmtime)
    if not logs: return None, None
    newest=logs[-1]
    try:
        data=open(newest,encoding="utf-8",errors="ignore").read().replace("\r","\n")
        prog=[l for l in data.splitlines() if l.startswith("Ingesting:")]
        done=[l for l in data.splitlines() if "Ingestion complete" in l]
        return (done[-1] if done else (prog[-1] if prog else None)), os.path.basename(newest)
    except Exception:
        return None, os.path.basename(newest)


def bar(pct,w=28):
    f=int(w*pct/100); return "["+"#"*f+"-"*(w-f)+"]"


def render():
    L=[]
    L.append(f"{B}═══ VECTOR-DB PIPELINE STATUS ═══{X}  {DIM}{time.strftime('%F %T %Z')}{X}")
    # collections
    L.append(f"\n{B}COLLECTIONS{X} (Qdrant @ localhost:6333)")
    cols=qget("/collections")
    names=[c["name"] for c in cols["collections"]] if cols else []
    for n in names:
        d=qget(f"/collections/{n}")
        if d:
            st=d["status"]; col=G if st=="green" else (Y if st=="yellow" else R)
            tag=" ← live corpus" if n=="mandumah_v2" else (f" {DIM}(legacy site){X}" if n.startswith("documents_async") else "")
            L.append(f"  {n:<28} {col}{st:<6}{X} {d['points_count']:>12,} pts{tag}")
    parked=os.path.isdir("/disk1/qdrant/parked/mandumah_v1")
    if parked: L.append(f"  {'mandumah_v1':<28} {DIM}PARKED (dir moved, recoverable){X}")

    # ingest progress
    L.append(f"\n{B}INGEST (corpus embedding into mandumah_v2){X}")
    docs=ckpt_docs()
    if docs is not None:
        pct=100*docs/CORPUS_TOTAL
        L.append(f"  docs done   {G}{bar(pct)}{X} {docs:,}/{CORPUS_TOTAL:,} ({pct:.1f}%)")
        L.append(f"  remaining   ~{CORPUS_TOTAL-docs:,} docs")
    line,logf=last_ingest_line()
    running=bool(procs("backend.pipeline.ingest"))
    state=f"{G}RUNNING{X}" if running else f"{Y}STOPPED{X}"
    L.append(f"  live run    {state}   {DIM}log: {logf or '-'}{X}")
    if line:
        # trim the progress line to the useful tail (docs, ch/s, ETA)
        L.append(f"  {DIM}{line.strip()[:96]}{X}")

    # processes
    L.append(f"\n{B}PROCESSES{X}")
    for label,pat in [("ingest","backend.pipeline.ingest"),("watchdog","watchdog_ingest.py"),
                      ("copy","copy_v1_to_v2.py"),("index-build","phase3_"),("checkpoint-rebuild","rebuild_checkpoint.py")]:
        ps=procs(pat)
        if ps:
            pid=ps[0].split()[0]; L.append(f"  {label:<18} {G}RUNNING{X} pid {pid}")
    if not any(procs(p) for p in ["backend.pipeline.ingest","watchdog_ingest.py","copy_v1_to_v2.py","phase3_","rebuild_checkpoint.py"]):
        L.append(f"  {DIM}(no pipeline processes running){X}")

    # memory
    m=mem(); av=m.get("MemAvailable",0); tot=m.get("MemTotal",0); su=m.get("SwapTotal",0)-m.get("SwapFree",0); stot=m.get("SwapTotal",0)
    swc=R if stot and su/stot>0.8 else (Y if stot and su/stot>0.5 else G)
    L.append(f"\n{B}MEMORY{X}")
    L.append(f"  RAM avail {av:,} / {tot:,} MB      swap {swc}{su:,}{X}/{stot:,} MB")

    # scheduled stop
    L.append(f"\n{B}SCHEDULED{X}")
    try:
        cron=subprocess.run(["crontab","-l"],capture_output=True,text=True,timeout=5).stdout
        stop=[l for l in cron.splitlines() if "scheduled_stop_ingest" in l and not l.startswith("#")]
        if stop:
            f=stop[0].split(); mm,hh,dd,mon=f[0],f[1],f[2],f[3]
            L.append(f"  stop ingest at {hh}:{mm} server-time on {mon}/{dd}  {DIM}(cron set){X}")
        else:
            L.append(f"  {DIM}no scheduled stop{X}")
    except Exception:
        L.append(f"  {DIM}(crontab unavailable){X}")
    return "\n".join(L)


def main():
    if "--watch" in sys.argv:
        tty=sys.stdout.isatty()
        try:
            while True:
                out=render()
                if tty: sys.stdout.write("\033[H\033[J"+out+"\n")
                else: sys.stdout.write(out+"\n"+"-"*50+"\n")
                sys.stdout.flush(); time.sleep(5)
        except KeyboardInterrupt:
            print(); return 0
    else:
        print(render()); return 0


if __name__=="__main__":
    raise SystemExit(main())
