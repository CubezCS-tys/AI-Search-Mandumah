#!/usr/bin/env python3
"""Memory watchdog for the embedding ingest.

The ingest's built-in _check_memory() only watches the ingest process's own RSS
(~1.8GB) — useless for the real risk, which is QDRANT's RAM. This watchdog
watches *system* available memory and the qdrant pid, and gracefully stops the
ingest (SIGINT -> atomic checkpoint + clean shutdown) BEFORE the OOM-killer
fires or if qdrant restarts underneath it. Worst case: the ingest pauses
itself, resumable from checkpoint. The box stays up.

Run alongside the ingest (run_ingest_safe.sh starts both).
"""
import os, time, signal, glob

THRESHOLD_MB = int(os.environ.get("WD_THRESHOLD_MB", "1536"))  # stop if avail < this
CONSEC       = int(os.environ.get("WD_CONSEC", "3"))           # consecutive low reads
INTERVAL     = int(os.environ.get("WD_INTERVAL", "10"))        # seconds between checks
PATTERN      = os.environ.get("WD_PATTERN", "backend.pipeline.ingest")  # target cmdline substring
LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "watchdog_ingest.log")


def log(msg):
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}"
    print(line, flush=True)
    with open(LOG, "a") as f:
        f.write(line + "\n")


def avail_mb():
    with open("/proc/meminfo") as f:
        for line in f:
            if line.startswith("MemAvailable"):
                return int(line.split()[1]) // 1024
    return 10 ** 9


def qdrant_pid():
    out = os.popen("pgrep -x qdrant").read().split()
    return out[0] if out else None


def find_ingest_pid():
    for p in glob.glob("/proc/[0-9]*/cmdline"):
        try:
            with open(p, "rb") as f:
                cmd = f.read().replace(b"\x00", b" ").decode("utf-8", "ignore")
            if PATTERN in cmd and "watchdog" not in cmd:
                return int(p.split("/")[2])
        except Exception:
            continue
    return None


def main():
    log(f"watchdog start: threshold={THRESHOLD_MB}MB consec={CONSEC} interval={INTERVAL}s")
    ing = None
    for _ in range(36):                 # wait up to 3 min for ingest to appear
        ing = find_ingest_pid()
        if ing:
            break
        time.sleep(5)
    if not ing:
        log("no ingest process found after 3 min; exiting")
        return
    log(f"watching ingest pid {ing}")
    q0 = qdrant_pid()
    low = 0
    while True:
        if not os.path.exists(f"/proc/{ing}"):
            log("ingest exited; watchdog done")
            return
        a = avail_mb()
        q = qdrant_pid()
        if q and q0 and q != q0:
            log(f"QDRANT RESTARTED (pid {q0}->{q}) — stopping ingest (SIGINT)")
            try: os.kill(ing, signal.SIGINT)
            except ProcessLookupError: pass
            return
        if a < THRESHOLD_MB:
            low += 1
            log(f"LOW MEM avail={a}MB ({low}/{CONSEC})")
            if low >= CONSEC:
                log(f"avail {a}MB < {THRESHOLD_MB}MB x{CONSEC} -> SIGINT ingest (graceful stop)")
                try: os.kill(ing, signal.SIGINT)
                except ProcessLookupError: pass
                return
        else:
            if low:
                log(f"mem recovered avail={a}MB")
            low = 0
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
