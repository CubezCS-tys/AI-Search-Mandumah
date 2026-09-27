#!/usr/bin/env python3
"""Live dashboard for the OCR corpus embedding run (mandumah_ocr_v1).

Read-only. Pulls from the run log, the checkpoint, Qdrant, and the process
table to show progress, throughput, a full-run projection, collection growth,
failures, recent activity, and system load.

  ./content_shards/ocr_dashboard.sh          # live (refresh 2s, Ctrl-C to quit)
  ./content_shards/ocr_dashboard.sh --once    # one snapshot
"""
import glob, json, os, re, subprocess, sys, time, urllib.request

QDRANT = "http://localhost:6333"
COLLECTION = "mandumah_ocr_v1"
COLL_DIR = f"/disk1/qdrant/storage/collections/{COLLECTION}"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CKPT = os.path.join(ROOT, "ocr_ingest_state", "ingest_checkpoint.json")
NEW_TOTAL = 412658          # new (non-v2) docs to embed — from the overlap analysis
TOK_PER_CHUNK = 300         # rough Arabic-chunk token estimate for the cost figure
PRICE_PER_1M = 0.02         # text-embedding-3-small, USD / 1M tokens

G="\033[32m"; Y="\033[33m"; R="\033[31m"; DIM="\033[2m"; B="\033[1m"; C="\033[36m"; M="\033[35m"; X="\033[0m"


def qget(path, timeout=5):
    try:
        return json.load(urllib.request.urlopen(f"{QDRANT}{path}", timeout=timeout))["result"]
    except Exception:
        return None


def run_proc():
    """Return (pid, etime, cpu, rss_mb) for the live OCR ingest, or None."""
    try:
        out = subprocess.run(
            ["pgrep", "-f", "backend.pipeline.ingest"], capture_output=True, text=True, timeout=5
        ).stdout.split()
        for pid in out:
            cmd = subprocess.run(["ps", "-o", "cmd=", "-p", pid], capture_output=True, text=True).stdout
            if COLLECTION in cmd:
                ps = subprocess.run(
                    ["ps", "-o", "etime=,%cpu=,rss=", "-p", pid], capture_output=True, text=True
                ).stdout.split()
                if len(ps) >= 3:
                    return pid, ps[0], ps[1], int(ps[2]) // 1024
    except Exception:
        pass
    return None


def _build_start():
    """Epoch when the HNSW index build started (seeded marker), or None."""
    try:
        return float(open(os.path.join(ROOT, "ocr_ingest_state", ".index_build_start")).read().strip())
    except Exception:
        return None


def _heartbeat(idx):
    """Return the change in indexed count since the last refresh (proof of life)."""
    f = os.path.join(ROOT, "ocr_ingest_state", ".index_hb")
    prev = None
    try:
        prev = int(open(f).read().strip())
    except Exception:
        pass
    try:
        open(f, "w").write(str(idx))
    except Exception:
        pass
    if prev is None:
        return "…"
    delta = idx - prev
    return f"+{delta:,} vectors indexed since last refresh" if delta else "…working (segment flush)"


def coll_size():
    try:
        out = subprocess.run(["du", "-sh", COLL_DIR], capture_output=True, text=True, timeout=15).stdout.split()
        return out[0] if out else "?"
    except Exception:
        return "?"


def mem():
    d = {}
    for line in open("/proc/meminfo"):
        k, _, v = line.partition(":"); d[k] = int(v.split()[0]) // 1024
    try:
        load = open("/proc/loadavg").read().split()[0]
    except Exception:
        load = "?"
    return d, load


def latest_log():
    logs = sorted(glob.glob(os.path.join(ROOT, "ocr_embed_*.log")), key=os.path.getmtime)
    return logs[-1] if logs else None


def read_log(path):
    try:
        return open(path, encoding="utf-8", errors="ignore").read()
    except Exception:
        return ""


def parse_progress(data):
    # tqdm writes with \r and the logger appends INFO lines on the same physical
    # line, so a single "Ingesting:" line can carry trailing log noise. Extract
    # each field independently — far more robust than one big regex.
    lines = data.replace("\r", "\n").splitlines()
    prog = [l for l in lines if l.startswith("Ingesting:")]
    done = [l for l in lines if "Ingestion complete" in l]
    listing = any("Listing S3 doc_ids" in l for l in lines[-30:]) and not prog
    p = {"listing": listing, "complete": bool(done), "complete_line": done[-1] if done else None}
    if prog:
        line = prog[-1]
        mpct = re.search(r"(\d+)%", line)
        mct = re.search(r"(\d[\d,]*)/(\d[\d,]*)\s*\[", line)
        mrate = re.search(r"\[[0-9:]+,\s*([0-9.]+)(s/doc|doc/s)\]", line)
        meta = re.search(r"ETA:\s*([^\s|]+)", line)
        mch = re.search(r"([0-9.]+)\s*ch/s", line)
        mdd = re.search(r"dedup:\s*(\d+)p/(\d+)f", line)
        mcur = re.search(r"dedup:\s*\d+p/\d+f\s*\|\s*([0-9][^\s|]+)", line)
        if mpct and mct and mrate:
            rv = float(mrate.group(1)); ru = mrate.group(2)
            rate = (1.0 / rv if ru == "s/doc" and rv else (rv if ru == "doc/s" else 0.0))
            p.update(pct=int(mpct.group(1)), cur=int(mct.group(1).replace(",", "")),
                     tot=int(mct.group(2).replace(",", "")), rate=rate,
                     eta=meta.group(1) if meta else "?", chs=float(mch.group(1)) if mch else 0.0,
                     dedup_p=int(mdd.group(1)) if mdd else 0,
                     dedup_f=int(mdd.group(2)) if mdd else 0,
                     current=mcur.group(1) if mcur else "?")
    return p


def ckpt():
    try:
        d = json.load(open(CKPT))
        return len(d.get("processed", [])), len(d.get("failed", [])), d.get("stats", {})
    except Exception:
        return 0, 0, {}


def recent_events(data, n=6):
    lines = data.replace("\r", "\n").splitlines()
    # Sub-second openai client retries are normal churn — count, don't list.
    retries = sum(1 for l in lines if "Retrying request to /embeddings" in l)
    keep = []
    for l in lines:
        if l.startswith("Ingesting:") or "HTTP Request" in l:
            continue
        if "Retrying request to /embeddings" in l:
            continue
        if "OpenAI API error" in l:
            keep.append((Y, l))               # embedder-level, after client retries exhausted
        elif "[ERROR]" in l or "Docs moved to failed" in l or "Qdrant upsert failed" in l:
            keep.append((R, l))
        elif "Ingestion complete" in l:
            keep.append((G, l))
        elif "Pipeline started" in l:
            keep.append((C, l))
        elif "MARC:" in l:
            keep.append((DIM, l))
    out = []
    for col, l in keep[-n:]:
        m = re.match(r"(?:\d{4}-\d\d-\d\d )?(\d\d:\d\d:\d\d)", l)
        ts = m.group(1) if m else ""
        msg = re.sub(r"^.*?\[\w+\] [\w.]+: ", "", l).strip()[:66]
        out.append(f"    {DIM}{ts}{X}  {col}{msg}{X}")
    if not out:
        out.append(f"    {DIM}(no notable events — embedding cleanly){X}")
    return out, retries


def fmt_hours(h):
    if h < 1: return f"{h*60:.0f}m"
    if h < 48: return f"{h:.1f}h"
    return f"{h/24:.1f}d"


def bar(pct, w=40):
    f = int(w * pct / 100)
    return f"{G}{'█'*f}{DIM}{'░'*(w-f)}{X}"


def render(baseline_pts):
    L = []
    ts = time.strftime('%F %T %Z')
    L.append(f"{B}{C}╔═ OCR CORPUS EMBEDDING · {COLLECTION} {'═'*20}{X}   {DIM}{ts}{X}")

    proc = run_proc()
    logf = latest_log()
    data = read_log(logf) if logf else ""
    p = parse_progress(data)

    # RUN
    if proc:
        pid, et, cpu, rss = proc
        L.append(f"  {B}RUN{X}     {G}● RUNNING{X}  pid {pid}  up {et}  cpu {cpu}%  rss {rss:,}MB")
    elif p.get("complete"):
        L.append(f"  {B}RUN{X}     {G}✓ COMPLETE{X}  {DIM}(process exited){X}")
    else:
        L.append(f"  {B}RUN{X}     {Y}○ STOPPED{X}  {DIM}(no live process){X}")
    phase = "listing S3 (~3 min)" if p.get("listing") else ("embedding" if proc else "idle")
    L.append(f"  {B}PHASE{X}   {phase}   {DIM}log: {os.path.basename(logf) if logf else '-'}{X}")

    # PROGRESS
    L.append("")
    if "pct" in p:
        L.append(f"  {B}PROGRESS{X}  this run")
        L.append(f"  {bar(p['pct'])}  {B}{p['pct']}%{X}   {p['cur']:,} / {p['tot']:,} docs")
        L.append(f"  {DIM}rate{X} {C}{p['rate']:.1f}{X} doc/s · {C}{p['chs']:.1f}{X} ch/s · "
                 f"{DIM}ETA{X} {p['eta']} · {DIM}now{X} {p['current']}")
    elif p.get("listing"):
        L.append(f"  {B}PROGRESS{X}  {Y}listing S3 prefixes… no docs processed yet{X}")
    else:
        L.append(f"  {B}PROGRESS{X}  {DIM}waiting for first progress line…{X}")

    # COLLECTION
    d = qget(f"/collections/{COLLECTION}")
    L.append("")
    if d:
        st = d["status"]; col = G if st == "green" else (Y if st == "yellow" else R)
        pts = d["points_count"]
        delta = f"  {DIM}(+{pts-baseline_pts:,} since open){X}" if baseline_pts is not None else ""
        L.append(f"  {B}COLLECTION{X}  {pts:,} pts   {C}{coll_size()}{X} on disk   {col}{st}{X}   "
                 f"segments {d.get('segments_count','?')}{delta}")

        # INDEX BUILD (finalize phase) — HNSW graph construction over all points.
        idx = d.get("indexed_vectors_count") or 0
        opt = d.get("optimizer_status")
        opt_s = opt if isinstance(opt, str) else (opt.get("error") if isinstance(opt, dict) and opt.get("error") else "ok")
        if st == "yellow" or (idx and idx < pts):
            # Qdrant publishes NO %/ETA for an HNSW build, and indexed_vectors_count
            # is inflated (counts vectors across segments being re-indexed), so a
            # progress fraction would be fake. Instead prove liveness: elapsed time
            # + a heartbeat (indexed count & on-disk size both tick up while building).
            # Real "done" signal is status → green.
            spin = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[int(time.time()) % 10]
            start = _build_start()
            el = f"{(time.time()-start)/60:.0f}m" if start else "?"
            hb = _heartbeat(idx)      # indexed delta since last refresh
            L.append(f"  {B}{M}INDEX BUILD{X}  {Y}{spin} building HNSW m=16 (on-disk){X}  "
                     f"{DIM}elapsed{X} {C}{el}{X}")
            L.append(f"  {DIM}heartbeat{X} {G}{hb}{X}  {DIM}· indexed {idx:,} · optimizer{X} "
                     f"{G if opt_s=='ok' else R}{opt_s}{X}  {DIM}(no ETA — done at status → green){X}")
        elif st == "green" and idx >= pts and idx > 0:
            L.append(f"  {B}{M}INDEX BUILD{X}  {G}✓ complete — HNSW m=16 built, ready to federate{X}")

    # QUALITY + PROJECTION
    proc_docs, failed, stats = ckpt()
    ev, retries = recent_events(data)
    # chunks/doc from LIVE points ÷ docs (the stale checkpoint stats block from an
    # earlier run under-reports it); fall back to stats only if points unavailable.
    pts_live = d["points_count"] if d else 0
    if proc_docs and pts_live:
        cpd = pts_live / proc_docs
    elif stats.get("total_docs"):
        cpd = stats.get("total_chunks", 0) / stats["total_docs"]
    else:
        cpd = 0
    # Retry health is meaningful per-doc, not as an absolute count (which just
    # grows with run length). ~0.7/doc was the slow baseline; <0.3 is healthy.
    rpd = retries / proc_docs if proc_docs else 0
    rcol = R if rpd > 1.0 else (Y if rpd > 0.5 else DIM)
    L.append(f"  {B}QUALITY{X}     failed {R if failed else G}{failed}{X}   "
             f"dedup {p.get('dedup_p',0)}p / {p.get('dedup_f',0)}f   "
             f"{DIM}~{cpd:.1f} chunks/doc{X}   {rcol}openai retries {retries} ({rpd:.2f}/doc){X}")

    remaining = max(NEW_TOTAL - proc_docs, 0)
    L.append("")
    L.append(f"  {B}{M}FULL-RUN PROJECTION{X}  ({NEW_TOTAL:,} new docs)")
    L.append(f"  processed {proc_docs:,} · remaining {remaining:,}")
    if p.get("rate"):
        hrs = remaining / p["rate"] / 3600
        proj_chunks = NEW_TOTAL * cpd if cpd else 0
        cost = proj_chunks * TOK_PER_CHUNK * PRICE_PER_1M / 1e6
        L.append(f"  at current rate ≈ {B}{fmt_hours(hrs)}{X} · "
                 f"~{proj_chunks/1e6:.1f}M chunks · {G}~${cost:.0f}{X} {DIM}(est){X}")
    else:
        L.append(f"  {DIM}(rate unknown — projection pending first docs){X}")

    # RECENT
    L.append("")
    L.append(f"  {B}RECENT{X}")
    L.extend(ev)

    # SYSTEM
    m, load = mem()
    av = m.get("MemAvailable", 0); tot = m.get("MemTotal", 0)
    su = m.get("SwapTotal", 0) - m.get("SwapFree", 0)
    L.append("")
    L.append(f"  {B}SYSTEM{X}   RAM {av:,}/{tot:,} MB · swap {su:,} MB · load {load}")
    L.append(f"{C}{B}╚{'═'*62}{X}")
    return "\n".join(L)


def main():
    once = "--once" in sys.argv
    baseline = None
    d = qget(f"/collections/{COLLECTION}")
    if d: baseline = d["points_count"]
    if once:
        print(render(baseline)); return 0
    tty = sys.stdout.isatty()
    try:
        while True:
            out = render(baseline)
            if tty: sys.stdout.write("\033[H\033[J" + out + "\n  " + DIM + "refreshing every 2s · Ctrl-C to quit" + X + "\n")
            else: sys.stdout.write(out + "\n" + "-"*64 + "\n")
            sys.stdout.flush(); time.sleep(2)
    except KeyboardInterrupt:
        print(); return 0


if __name__ == "__main__":
    raise SystemExit(main())
