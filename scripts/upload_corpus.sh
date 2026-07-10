#!/usr/bin/env bash
#
# Upload the corpus to S3 one zip at a time, or report what's already uploaded.
#
#   Report (no changes, just tells you coverage):
#     ./upload_corpus.sh --zips /mnt/drive/output --work /mnt/drive/_work --report
#
#   Upload (extract -> upload doc folders -> verify -> delete extract -> next):
#     ./upload_corpus.sh --zips /mnt/drive/output --work /mnt/drive/_work
#
# Each document is a folder named by its doc_id (regex 0000-000-000-000) holding
# that doc's pdf/json/html. Files are keyed at  s3://<bucket>/<doc_id>/<file>
# (root, matching backend/services/runtime.py ensure_doc_file). The batch/journal
# structure inside the zip must NOT appear in the key.
#
# Safety: the .zip files are never deleted (they are the backup); only the
# extracted folder is removed, and only after `rclone check` passes. Resumable:
# re-run any time — rclone skips objects already in S3, and finished batches are
# skipped via .done markers / the S3 doc_id snapshot.
#
# Run it inside tmux so a disconnect doesn't kill a multi-day transfer:
#     tmux new -s upload      # then run the command; detach with Ctrl-b d
#
set -euo pipefail

# ── defaults ─────────────────────────────────────────────────────────────────
REMOTE=s3
BUCKET=mandumah-source-docs
PREFIX=""                 # EMPTY = bucket root (what the live app expects)
TRANSFERS=16
STORAGE=STANDARD          # or STANDARD_IA (cheaper storage, retrieval fees)
ZIPDIR=""
WORKDIR=""
MODE=upload
REFRESH=0
VERIFY_EXISTING=0         # 1 = never skip on S3 presence; always extract+copy+check
FILTER="*.zip"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --zips)            ZIPDIR="$2"; shift 2;;
    --work)            WORKDIR="$2"; shift 2;;
    --remote)          REMOTE="$2"; shift 2;;
    --bucket)          BUCKET="$2"; shift 2;;
    --prefix)          PREFIX="$2"; shift 2;;
    --transfers)       TRANSFERS="$2"; shift 2;;
    --storage)         STORAGE="$2"; shift 2;;
    --filter)          FILTER="$2"; shift 2;;
    --report)          MODE=report; shift;;
    --refresh)         REFRESH=1; shift;;
    --verify-existing) VERIFY_EXISTING=1; shift;;
    -h|--help)         sed -n '2,26p' "$0"; exit 0;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

# ── validation / preflight ───────────────────────────────────────────────────
[[ -n "$ZIPDIR" && -d "$ZIPDIR" ]] || { echo "need --zips <dir with output_batchNN.zip>" >&2; exit 2; }
[[ -n "$WORKDIR" ]] || { echo "need --work <scratch dir, ~75G free>" >&2; exit 2; }
command -v rclone >/dev/null || { echo "install rclone (curl https://rclone.org/install.sh | sudo bash)" >&2; exit 2; }
command -v unzip  >/dev/null || { echo "install unzip (sudo apt install -y unzip)" >&2; exit 2; }

STATE="$WORKDIR/_state"; mkdir -p "$STATE"
LOG="$STATE/upload.log"
S3LIST="$STATE/s3_docids.txt"
DEST="$REMOTE:$BUCKET"
PFX="${PREFIX#/}"; PFX="${PFX%/}"
[[ -n "$PFX" ]] && DEST="$DEST/$PFX"

log(){ echo "$(date '+%F %T') [$1] ${*:2}"; echo "$(date '+%F %T') [$1] ${*:2}" >>"$LOG"; }

rclone lsd "$REMOTE:$BUCKET" >/dev/null 2>&1 \
  || { log ERROR "cannot reach $REMOTE:$BUCKET — check 'rclone config' (keys/region/bucket)"; exit 1; }

# doc_ids currently in S3 (immediate subfolders at the prefix root).
build_snapshot(){
  log INFO "listing doc_ids already in $DEST (one-time; a few minutes for a full bucket)…"
  rclone lsf --dirs-only "$DEST" 2>/dev/null | sed 's#/$##' | sort -u > "$S3LIST"
  log INFO "$(wc -l <"$S3LIST") doc_ids already present in S3"
}
[[ "$MODE" == report || "$REFRESH" == 1 || ! -s "$S3LIST" ]] && build_snapshot

# doc_ids inside a zip WITHOUT extracting it (reads the central directory only).
zip_docids(){ unzip -Z1 "$1" 2>/dev/null | grep -oE '[0-9]{4}-[0-9]{3}-[0-9]{3}-[0-9]{3}' | sort -u; }

# ── report mode ──────────────────────────────────────────────────────────────
if [[ "$MODE" == report ]]; then
  printf '%-26s %9s %9s %9s\n' BATCH DOCS IN_S3 MISSING
  printf '%-26s %9s %9s %9s\n' '--------------------------' -------- -------- --------
  td=0; tp=0
  shopt -s nullglob
  for z in "$ZIPDIR"/$FILTER; do
    name=$(basename "$z" .zip)
    ids=$(zip_docids "$z"); n=$(printf '%s' "$ids" | grep -c . || true)
    present=$(comm -12 <(printf '%s\n' "$ids") "$S3LIST" | grep -c . || true)
    printf '%-26s %9d %9d %9d\n' "$name" "$n" "$present" "$((n-present))"
    td=$((td+n)); tp=$((tp+present))
  done
  printf '%-26s %9s %9s %9s\n' '--------------------------' -------- -------- --------
  printf '%-26s %9d %9d %9d\n' TOTAL "$td" "$tp" "$((td-tp))"
  exit 0
fi

# ── upload mode ──────────────────────────────────────────────────────────────
RCLONE_COMMON=( --transfers "$TRANSFERS" --checkers "$TRANSFERS"
  --s3-chunk-size 32M --s3-storage-class "$STORAGE"
  --exclude 'Thumbs.db' --exclude '*.tmp' --exclude '.DS_Store'
  --stats 30s --stats-one-line )

shopt -s nullglob
zips=( "$ZIPDIR"/$FILTER )
[[ ${#zips[@]} -gt 0 ]] || { log WARN "no zips match '$FILTER' in $ZIPDIR"; exit 0; }
log INFO "${#zips[@]} zip(s) to consider"

for z in "${zips[@]}"; do
  name=$(basename "$z" .zip)
  marker="$STATE/$name.done"
  [[ -f "$marker" ]] && { log INFO "SKIP $name (done marker)"; continue; }

  mapfile -t ids < <(zip_docids "$z")
  n=${#ids[@]}

  # Fast skip: every doc_id already in S3. Disabled by --verify-existing, which
  # forces a file-accurate extract+copy+check (use it for the FIRST pass if you
  # don't trust earlier partial uploads).
  if [[ "$VERIFY_EXISTING" == 0 && "$n" -gt 0 ]]; then
    missing=$(comm -23 <(printf '%s\n' "${ids[@]}") "$S3LIST" | grep -c . || true)
    if [[ "$missing" -eq 0 ]]; then
      log INFO "SKIP $name — all $n docs already in S3"; touch "$marker"; continue
    fi
  else
    missing=$n
  fi

  log INFO "=== BATCH $name : $n docs, ~$missing missing ==="

  # free-space guard (~1.6x the zip size for the extracted tree)
  need_kb=$(( $(stat -c%s "$z") / 1024 * 16 / 10 ))
  avail_kb=$(df -Pk "$WORKDIR" | awk 'NR==2{print $4}')
  if [[ "$avail_kb" -lt "$need_kb" ]]; then
    log ERROR "low disk on $WORKDIR: need ~$((need_kb/1048576))G, have $((avail_kb/1048576))G"; exit 1
  fi

  ex="$WORKDIR/$name"; rm -rf "$ex"; mkdir -p "$ex"
  log INFO "extracting ($(( $(stat -c%s "$z")/1073741824 ))G)…"
  unzip -q -o "$z" -d "$ex"

  mapfile -t docdirs < <(find "$ex" -type d -regextype posix-extended \
                         -regex '.*/[0-9]{4}-[0-9]{3}-[0-9]{3}-[0-9]{3}')
  [[ ${#docdirs[@]} -gt 0 ]] || { log ERROR "no doc folders in $name — keeping $ex"; exit 1; }

  mapfile -t parents < <(printf '%s\n' "${docdirs[@]}" | xargs -rn1 dirname | sort -u)

  if [[ ${#parents[@]} -eq 1 ]]; then
    # Flat layout: copying the shared parent yields keys <doc_id>/<file>.
    log INFO "flat layout — bulk copy → $DEST"
    if ! rclone copy "${parents[0]}" "$DEST" "${RCLONE_COMMON[@]}" --log-file "$LOG" --log-level INFO; then
      log ERROR "rclone copy failed for $name — keeping $ex"; exit 1
    fi
    log INFO "verifying…"
    if ! rclone check "${parents[0]}" "$DEST" --one-way --size-only; then
      log ERROR "verify FAILED for $name — keeping $ex"; exit 1
    fi
  else
    # Nested/mixed (per-journal) layout: copy each doc folder to its own key.
    log INFO "nested layout — per-folder copy (${#docdirs[@]})"
    for d in "${docdirs[@]}"; do
      id=$(basename "$d")
      if ! rclone copy "$d" "$DEST/$id" "${RCLONE_COMMON[@]}"; then
        log ERROR "rclone copy failed for $id — keeping $ex"; exit 1
      fi
    done
    for d in "${docdirs[@]}"; do
      id=$(basename "$d")
      if ! rclone check "$d" "$DEST/$id" --one-way --size-only; then
        log ERROR "verify FAILED for $id — keeping $ex"; exit 1
      fi
    done
  fi

  # verified → record ids, reclaim disk, mark done. Zip untouched.
  printf '%s\n' "${ids[@]}" >> "$S3LIST"; sort -u -o "$S3LIST" "$S3LIST"
  rm -rf "$ex"; touch "$marker"
  log INFO "DONE $name"
done

log INFO "all batches processed"
