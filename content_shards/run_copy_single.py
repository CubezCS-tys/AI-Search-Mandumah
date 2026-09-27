#!/usr/bin/env python3
"""Supervise a single corruption-tolerant copy worker, with auto-resume.

This box is memory-bound, so we run ONE worker (no concurrency -> no swap-thrash).
The worker is resumable via its checkpoint; this wrapper just relaunches it if it ever
exits before reaching the end (crash, mem-stop), backing off if memory is tight.
"""
import json
import os
import signal
import subprocess
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PYTHON = os.path.join(ROOT, ".venv", "bin", "python")
CKPT = os.path.join(HERE, "copy.cursor.json")
LOG = os.path.join(HERE, "copy.worker.log")

THRESHOLD_MB = int(os.environ.get("WD_THRESHOLD_MB", "1500"))
CAP = int(os.environ.get("COPY_RELAUNCH_CAP", "500"))


def avail_mb():
    with open("/proc/meminfo") as f:
        for line in f:
            if line.startswith("MemAvailable"):
                return int(line.split()[1]) // 1024
    return 10 ** 9


def done():
    try:
        with open(CKPT) as f:
            d = json.load(f)
        return d.get("cursor") is None and d.get("traversed", 0) > 0
    except Exception:
        return False


def log(m):
    print(f"{time.strftime('%H:%M:%S')} {m}", flush=True)


def main():
    child = {"p": None}

    def stop(*_):
        if child["p"] and child["p"].poll() is None:
            child["p"].send_signal(signal.SIGINT)
            try: child["p"].wait(timeout=40)
            except Exception: pass
        os._exit(130)
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    for attempt in range(CAP):
        if done():
            log("checkpoint shows complete."); break
        while avail_mb() < THRESHOLD_MB:
            log(f"low mem ({avail_mb()}MB) -> wait 30s before (re)launch"); time.sleep(30)
        logf = open(LOG, "a")
        cmd = [PYTHON, os.path.join(HERE, "copy_v1_to_v2.py"),
               "--source", "mandumah_v1", "--target", "mandumah_v2", "--page", "512",
               "--checkpoint", CKPT, "--skip-log", os.path.join(HERE, "copy_skipped.jsonl"),
               "--log-every", "100"]
        log(f"launch attempt {attempt} (avail={avail_mb()}MB)")
        child["p"] = subprocess.Popen(cmd, cwd=ROOT, stdout=logf, stderr=subprocess.STDOUT)
        rc = child["p"].wait()
        log(f"worker exited rc={rc} done={done()}")
        if done():
            log("COPY COMPLETE."); break
        time.sleep(10)
    else:
        log("hit relaunch cap without completing."); return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
