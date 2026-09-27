#!/usr/bin/env python3
"""Launch and supervise the parallel v1->v2 copy described by copy_plan.json.

Self-healing pool model (learned from a run where Qdrant dropped connections under
12 concurrent streams while the box was deep in swap):
  * At most COPY_MAXN workers run concurrently (default 3) -- fewer connections, less
    memory pressure than one-worker-per-slice.
  * Launches are staggered so workers don't all hit Qdrant at the same instant.
  * A slice is "done" only when its checkpoint shows copied >= max_points -- NOT by exit
    code (a graceful mem-stop also exits 0). Any worker that stops short is relaunched;
    it resumes from its checkpoint. So transient disconnects self-heal.
  * Built-in memory watchdog: if MemAvailable drops below threshold (consecutively) or
    qdrant restarts, all running workers are SIGINT'd (graceful, resumable) and the pool
    backs off before resuming.
"""
import json
import os
import signal
import subprocess
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PLAN = os.path.join(HERE, "copy_plan.json")
PYTHON = os.path.join(ROOT, ".venv", "bin", "python")

MAXN = int(os.environ.get("COPY_MAXN", "3"))
PAGE = os.environ.get("COPY_PAGE", "512")
STAGGER = int(os.environ.get("COPY_STAGGER", "4"))       # seconds between launches
THRESHOLD_MB = int(os.environ.get("WD_THRESHOLD_MB", "1800"))
CONSEC = int(os.environ.get("WD_CONSEC", "3"))
INTERVAL = int(os.environ.get("WD_INTERVAL", "10"))
RELAUNCH_CAP = int(os.environ.get("COPY_RELAUNCH_CAP", "100"))


def avail_mb():
    with open("/proc/meminfo") as f:
        for line in f:
            if line.startswith("MemAvailable"):
                return int(line.split()[1]) // 1024
    return 10 ** 9


def qdrant_pid():
    out = os.popen("pgrep -x qdrant").read().split()
    return out[0] if out else None


def log(msg):
    print(f"{time.strftime('%H:%M:%S')} {msg}", flush=True)


def copied_of(worker):
    try:
        with open(os.path.join(HERE, f"copy.cursor.{worker}.json")) as f:
            return int(json.load(f).get("copied", 0))
    except Exception:
        return 0


def main() -> int:
    with open(PLAN) as f:
        plan = json.load(f)
    slices = {s["worker"]: s for s in plan["slices"]}
    total = plan["total"]
    log(f"supervising {len(slices)} slices, {total:,} live points, MAXN={MAXN} page={PAGE}")

    running = {}      # worker -> Popen
    relaunch = {w: 0 for w in slices}
    last_launch = 0.0
    q0 = qdrant_pid()
    low = 0
    t0 = time.time()

    def is_done(w):
        return copied_of(w) >= slices[w]["max_points"]

    def launch(w):
        s = slices[w]
        cmd = [PYTHON, os.path.join(HERE, "copy_v1_to_v2.py"),
               "--source", plan["source"], "--target", "mandumah_v2",
               "--page", PAGE, "--max-points", str(s["max_points"]),
               "--checkpoint", os.path.join(HERE, f"copy.cursor.{w}.json"),
               "--log-every", "50"]
        if s["start_id"] is not None:
            cmd += ["--start-id", s["start_id"]]
        logf = open(os.path.join(ROOT, s["log"]), "a")
        p = subprocess.Popen(cmd, cwd=ROOT, stdout=logf, stderr=subprocess.STDOUT)
        running[w] = p
        log(f"  launched worker {w} pid={p.pid} (resume from {copied_of(w):,}/{s['max_points']:,}, "
            f"relaunch #{relaunch[w]})")

    def stop_all():
        for w, p in running.items():
            if p.poll() is None:
                try:
                    p.send_signal(signal.SIGINT)
                except ProcessLookupError:
                    pass
        deadline = time.time() + 30
        for w, p in running.items():
            try:
                p.wait(timeout=max(1, deadline - time.time()))
            except Exception:
                pass

    signal.signal(signal.SIGINT, lambda *_: (log("SIGINT -> stopping all"), stop_all(), os._exit(130)))
    signal.signal(signal.SIGTERM, lambda *_: (log("SIGTERM -> stopping all"), stop_all(), os._exit(143)))

    while True:
        pending = [w for w in slices if not is_done(w) and w not in running]
        if not running and not pending:
            break

        # reap finished procs
        for w in list(running):
            p = running[w]
            if p.poll() is not None:
                del running[w]
                if is_done(w):
                    log(f"worker {w} DONE ({copied_of(w):,}/{slices[w]['max_points']:,})")
                else:
                    relaunch[w] += 1
                    if relaunch[w] > RELAUNCH_CAP:
                        log(f"worker {w} exceeded relaunch cap -- ABORT")
                        stop_all()
                        return 1
                    log(f"worker {w} stopped short ({copied_of(w):,}/{slices[w]['max_points']:,}); will resume")

        # memory / qdrant watchdog
        a = avail_mb()
        q = qdrant_pid()
        if q and q0 and q != q0:
            log(f"QDRANT RESTARTED ({q0}->{q}) -> stop all, back off 30s, resume")
            stop_all(); running.clear(); q0 = q; time.sleep(30); continue
        if a < THRESHOLD_MB:
            low += 1
            log(f"LOW MEM avail={a}MB ({low}/{CONSEC})")
            if low >= CONSEC:
                log(f"avail<{THRESHOLD_MB}MB x{CONSEC} -> stop all, back off 30s")
                stop_all(); running.clear(); low = 0; time.sleep(30); continue
        else:
            low = 0

        # top up the pool (staggered)
        if len(running) < MAXN and pending and (time.time() - last_launch) >= STAGGER:
            launch(sorted(pending)[0])
            last_launch = time.time()

        # periodic aggregate progress
        if int(time.time() - t0) % 60 < INTERVAL:
            done = sum(copied_of(w) for w in slices)
            rate = done / max(1e-6, time.time() - t0)
            eta = (total - done) / max(1e-6, rate) / 3600
            log(f"progress ~{done:,}/{total:,} rate~{rate:.0f}/s eta~{eta:.1f}h "
                f"avail={a}MB running={sorted(running)}")
        time.sleep(INTERVAL)

    done = sum(copied_of(w) for w in slices)
    log(f"ALL SLICES DONE: copied~{done:,}/{total:,} in {(time.time()-t0)/60:.0f}min")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
