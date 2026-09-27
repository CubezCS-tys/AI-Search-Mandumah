#!/usr/bin/env bash
# Gracefully stop the corpus ingest before the 11pm BST (17:00 CDT) restart.
# SIGINT -> the ingest's handler does an atomic checkpoint + clean exit, so it's
# fully resumable afterwards. Self-removes its own cron line when done.
LOG=/home/appuser/AI-Search-Mandumah/content_shards/scheduled_stop.log
echo "$(date '+%F %T %Z') scheduled stop firing" >> "$LOG"

# graceful stop of the ingest (checkpoints on SIGINT)
for p in $(pgrep -f "backend.pipeline.ingest"); do
  kill -INT "$p" 2>/dev/null && echo "$(date '+%F %T %Z') SIGINT ingest pid $p" >> "$LOG"
done
# give it up to 5 min to checkpoint + exit, then escalate if still alive
for i in $(seq 1 30); do
  pgrep -f "backend.pipeline.ingest" >/dev/null || break
  sleep 10
done
for p in $(pgrep -f "backend.pipeline.ingest"); do kill -TERM "$p" 2>/dev/null; done
# stop the watchdog too
for p in $(pgrep -f "watchdog_ingest.py"); do kill -TERM "$p" 2>/dev/null; done

echo "$(date '+%F %T %Z') ingest stopped (running procs: $(pgrep -cf backend.pipeline.ingest))" >> "$LOG"
# remove this cron entry so it doesn't linger / refire
crontab -l 2>/dev/null | grep -v 'scheduled_stop_ingest' | crontab -
echo "$(date '+%F %T %Z') cron entry removed. done." >> "$LOG"
