<#
.SYNOPSIS
  Upload the corpus to S3, one zip at a time: extract -> upload doc folders ->
  verify -> delete the extracted folder -> next zip. The .zip files themselves
  are never deleted (they stay as the backup).

.DESCRIPTION
  For each output_batchNN.zip in -ZipDir this script:
    1. Extracts it into -WorkDir (7-Zip if available, else .NET; NOT the slow
       Expand-Archive).
    2. Finds every doc_id folder inside (name matches 0000-000-000-000),
       wherever it sits in the tree.
    3. Uploads each doc folder's files to  s3://<bucket>/<prefix>/<doc_id>/...
       matching exactly the keys the app reads (root-keyed by doc_id).
    4. Verifies the upload with `rclone check` (size-only).
    5. Only on a clean verify: deletes the extracted folder and writes a
       .done marker so re-runs skip it. On any failure it stops and leaves the
       folder in place for inspection.

  Resumable: interrupt any time. rclone skips objects already in S3, and done
  batches are skipped by their marker.

.PREREQUISITES
  * rclone installed and a remote configured for the bucket's region, e.g.:
        rclone config   ->  n) new remote, name it "s3", type "s3",
                            provider AWS, your keys, region eu-north-1
    Verify with:  rclone lsd s3:mandumah-source-docs
  * (Recommended) 7-Zip installed for fast extraction of the large archives.

.EXAMPLE
  .\upload_corpus_windows.ps1 -ZipDir "D:\output" -WorkDir "D:\_extract_work"
#>

[CmdletBinding()]
param(
  # Folder that holds output_batchNN.zip files (your external drive).
  [Parameter(Mandatory = $true)] [string] $ZipDir,

  # Scratch folder for extraction. Needs room for ONE extracted batch
  # (~75 GB). Deleted per-batch after a verified upload.
  [Parameter(Mandatory = $true)] [string] $WorkDir,

  # rclone remote name (from `rclone config`).
  [string] $Remote = "s3",

  # Destination bucket.
  [string] $Bucket = "mandumah-source-docs",

  # S3 key prefix. EMPTY = keyed at the bucket root (what the live app uses:
  # s3://bucket/<doc_id>/<file>). Set this only if the app's DOC_S3_PREFIX is set.
  [string] $Prefix = "",

  # Parallel uploads. 16 is a good start; raise if your uplink isn't saturated.
  [int] $Transfers = 16,

  # S3 storage class. STANDARD = no retrieval fees (safe default for files the
  # app serves on demand). STANDARD_IA is cheaper to store but charges per GB
  # retrieved and has a 30-day minimum.
  [ValidateSet("STANDARD", "STANDARD_IA", "INTELLIGENT_TIERING")]
  [string] $StorageClass = "STANDARD",

  # Optional glob to process a subset, e.g. "output_batch0*.zip".
  [string] $Filter = "*.zip"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$DocIdRe   = '^\d{4}-\d{3}-\d{3}-\d{3}$'
$StateDir  = Join-Path $WorkDir "_state"
$LogFile   = Join-Path $StateDir "upload.log"

function Log {
  param([string] $Msg, [string] $Level = "INFO")
  $line = "{0} [{1}] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Level, $Msg
  Write-Host $line
  Add-Content -Path $LogFile -Value $line
}

# ── Preflight ────────────────────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

if (-not (Get-Command rclone -ErrorAction SilentlyContinue)) {
  throw "rclone not found on PATH. Install it and run `rclone config` first."
}
if (-not (Test-Path $ZipDir)) { throw "ZipDir not found: $ZipDir" }

# Confirm the remote+bucket is reachable before touching anything.
Log "Checking remote ${Remote}:${Bucket} ..."
& rclone lsd "${Remote}:${Bucket}" 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "Cannot reach ${Remote}:${Bucket}. Check `rclone config` (keys/region) and bucket name."
}

# Prefer 7-Zip for extraction; fall back to .NET.
$SevenZip = @(
  "C:\Program Files\7-Zip\7z.exe",
  "C:\Program Files (x86)\7-Zip\7z.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $SevenZip -and (Get-Command 7z -ErrorAction SilentlyContinue)) { $SevenZip = "7z" }
Log ("Extractor: {0}" -f ($(if ($SevenZip) { $SevenZip } else { ".NET ZipFile (install 7-Zip for speed)" })))

function Extract-Zip {
  param([string] $Zip, [string] $Dest)
  # Start clean. Don't pre-create $Dest: 7-Zip makes it via -o, and .NET's
  # ExtractToDirectory throws on Win10/PS5.1 if the target already exists.
  if (Test-Path $Dest) { Remove-Item -LiteralPath $Dest -Recurse -Force }
  if ($SevenZip) {
    & $SevenZip x -y "-o$Dest" "$Zip" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "7-Zip failed on $Zip (exit $LASTEXITCODE)" }
  } else {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($Zip, $Dest)
  }
}

# Destination base: "remote:bucket" or "remote:bucket/prefix".
$DestBase = "${Remote}:${Bucket}"
if ($Prefix.Trim("/") -ne "") { $DestBase = "$DestBase/$($Prefix.Trim('/'))" }

$commonRcloneArgs = @(
  "--transfers", $Transfers,
  "--checkers", ([Math]::Max(8, $Transfers)),
  "--s3-chunk-size", "32M",
  "--s3-storage-class", $StorageClass,
  "--exclude", "Thumbs.db", "--exclude", "*.tmp", "--exclude", ".DS_Store",
  "--stats", "30s", "--stats-one-line"
)

# ── Main loop ────────────────────────────────────────────────────────────────
$zips = Get-ChildItem -Path $ZipDir -Filter $Filter -File | Sort-Object Name
if (-not $zips) { Log "No zips matched '$Filter' in $ZipDir" "WARN"; return }
Log ("Found {0} zip(s) to process." -f $zips.Count)

foreach ($zip in $zips) {
  $name   = [System.IO.Path]::GetFileNameWithoutExtension($zip.Name)
  $marker = Join-Path $StateDir "$name.done"
  if (Test-Path $marker) { Log "SKIP $name (already done)"; continue }

  Log "=== BATCH $name ==="
  $extractPath = Join-Path $WorkDir $name

  try {
    # Free-space guard: need roughly the zip size again for the extracted tree.
    $drive = (Get-Item $WorkDir).PSDrive
    $freeGb = [math]::Round($drive.Free / 1GB, 1)
    $needGb = [math]::Round(($zip.Length / 1GB) * 1.6, 1)
    if ($freeGb -lt $needGb) {
      throw "Low disk on $($drive.Name): ${freeGb}GB free, need ~${needGb}GB for $name."
    }

    Log "Extracting ($([math]::Round($zip.Length/1GB,1)) GB zip) ..."
    Extract-Zip -Zip $zip.FullName -Dest $extractPath

    # Find every doc_id folder anywhere under the extracted tree.
    $docDirs = Get-ChildItem -LiteralPath $extractPath -Recurse -Directory |
               Where-Object { $_.Name -match $DocIdRe }
    if (-not $docDirs) { throw "No doc_id folders found in $name (bad layout?)." }

    $parents = $docDirs | ForEach-Object { $_.Parent.FullName } | Sort-Object -Unique
    Log ("{0} doc folder(s) under {1} parent path(s)." -f $docDirs.Count, $parents.Count)

    if ($parents.Count -eq 1) {
      # Flat layout: doc_id folders share one parent -> one bulk copy.
      # Copying <parent> into <DestBase> yields keys <doc_id>/<file>. Correct.
      $src = $parents[0]
      Log "Uploading (bulk) -> $DestBase"
      & rclone copy "$src" "$DestBase" @commonRcloneArgs
      if ($LASTEXITCODE -ne 0) { throw "rclone copy failed for $name (exit $LASTEXITCODE)" }

      Log "Verifying ..."
      & rclone check "$src" "$DestBase" --one-way --size-only
      if ($LASTEXITCODE -ne 0) { throw "Verify FAILED for $name — leaving folder in place." }
    }
    else {
      # Nested/mixed (e.g. per-journal) layout: upload each doc folder to its
      # own <doc_id> key so the journal dir never leaks into the key.
      $i = 0
      foreach ($d in $docDirs) {
        $i++
        $dest = "$DestBase/$($d.Name)"
        & rclone copy "$($d.FullName)" "$dest" @commonRcloneArgs
        if ($LASTEXITCODE -ne 0) { throw "rclone copy failed for $($d.Name) (exit $LASTEXITCODE)" }
        if ($i % 500 -eq 0) { Log "  ...$i/$($docDirs.Count) folders" }
      }
      Log "Verifying $($docDirs.Count) folders ..."
      foreach ($d in $docDirs) {
        & rclone check "$($d.FullName)" "$DestBase/$($d.Name)" --one-way --size-only
        if ($LASTEXITCODE -ne 0) { throw "Verify FAILED for $($d.Name) — leaving folder in place." }
      }
    }

    # Verified OK -> free the disk and mark done. Zip is untouched.
    Log "Verified. Deleting extracted folder $extractPath"
    Remove-Item -LiteralPath $extractPath -Recurse -Force
    Set-Content -Path $marker -Value (Get-Date -Format o)
    Log "DONE $name"
  }
  catch {
    Log ("ERROR on {0}: {1}" -f $name, $_.Exception.Message) "ERROR"
    Log "Stopping. Extracted folder kept at $extractPath for inspection. Fix and re-run to resume." "ERROR"
    throw
  }
}

Log "All batches processed."
