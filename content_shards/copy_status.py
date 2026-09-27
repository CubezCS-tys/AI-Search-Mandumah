#!/usr/bin/env python3
"""Live CLI status for the v1->v2 copy. Reads copy.cursor.json (no load on Qdrant).

  ./content_shards/copy_status.sh          # live, refreshes in place (Ctrl-C to quit)
  ./content_shards/copy_status.sh --once   # print one snapshot and exit
"""
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
CKPT = os.path.join(HERE, "copy.cursor.json")
LIVE_TOTAL = 11_737_507

C_GRN = "\033[32m"; C_YEL = "\033[33m"; C_RED = "\033[31m"; C_DIM = "\033[2m"; C_0 = "\033[0m"


def read_ckpt():
    try:
        return json.load(open(CKPT))
    except Exception:
        return {}


def alive():
    return bool(os.popen("pgrep -f copy_v1_to_v2.py").read().strip())


def mem():
    d = {}
    with open("/proc/meminfo") as f:
        for line in f:
            k, _, v = line.partition(":")
            d[k] = int(v.split()[0]) // 1024
    return d.get("MemAvailable", 0), d.get("SwapTotal", 0) - d.get("SwapFree", 0), d.get("SwapTotal", 0)


def bar(pct, width=32):
    fill = int(width * pct / 100)
    return "[" + "#" * fill + "-" * (width - fill) + "]"


def render(d, rate):
    trav = int(d.get("traversed", 0)); cop = int(d.get("copied", 0)); skip = int(d.get("skipped", 0))
    pct = 100 * trav / LIVE_TOTAL if LIVE_TOTAL else 0
    complete = d.get("cursor") is None and trav > 0
    eta = (LIVE_TOTAL - trav) / rate / 3600 if rate > 0 else None
    if complete:
        state = f"{C_GRN}COMPLETE{C_0}"
    elif alive():
        state = f"{C_GRN}RUNNING{C_0}"
    else:
        state = f"{C_RED}STOPPED{C_0}"
    av, su, st = mem()
    sw_c = C_RED if st and su / st > 0.8 else (C_YEL if st and su / st > 0.5 else C_GRN)
    lines = [
        f"  mandumah_v1 -> mandumah_v2 copy        {state}",
        f"  {C_GRN}{bar(pct)}{C_0} {pct:5.1f}%",
        f"  copied  {cop:>12,} / {LIVE_TOTAL:,}",
        f"  rate    {rate:>7.0f}/s     eta {('%.1f h' % eta) if eta else '--'}",
        f"  skipped {skip:>12,}  {C_DIM}(corrupt, logged for re-embed){C_0}",
        f"  RAM     {av:>7,} MB avail    swap {sw_c}{su:,}{C_0}/{st:,} MB",
    ]
    return "\n".join(lines)


def main():
    once = "--once" in sys.argv
    if once:  # take a quick 2s sample so the rate is real, not 0
        prev_trav = int(read_ckpt().get("traversed", 0)); prev_t = time.time(); time.sleep(2)
        d = read_ckpt(); now = time.time()
        rate = (int(d.get("traversed", 0)) - prev_trav) / max(1e-6, now - prev_t)
        print(render(d, rate)); return 0

    tty = sys.stdout.isatty()
    prev_t = prev_trav = None
    try:
        while True:
            d = read_ckpt(); trav = int(d.get("traversed", 0)); now = time.time()
            rate = (trav - prev_trav) / (now - prev_t) if (prev_trav is not None and now > prev_t) else 0.0
            prev_t, prev_trav = now, trav
            hdr = f"  {C_DIM}{time.strftime('%H:%M:%S')} - live, Ctrl-C to quit{C_0}"
            block = hdr + "\n" + render(d, rate)
            if tty:
                sys.stdout.write("\033[H\033[J" + block + "\n")   # home + clear screen, like top
            else:
                sys.stdout.write(block + "\n" + "-" * 46 + "\n")   # non-tty: just scroll
            sys.stdout.flush()
            time.sleep(2)
    except KeyboardInterrupt:
        print(); return 0


if __name__ == "__main__":
    raise SystemExit(main())
