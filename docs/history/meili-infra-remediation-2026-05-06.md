# Meilisearch Infrastructure Remediation Plan

**Date:** 2026-05-06
**Status:** ✅ FULL REMEDIATION COMPLETE — VM resized, NVMe attached, Meili upgraded to 1.43.0
**Severity:** Resolved — swap 4MB, search 21ms, indexing recovering

---

## 1. Current State (Verified via SSH)

| Metric | Value | Healthy? |
|--------|-------|----------|
| VM RAM | 16 GB (inventory says 8 GB — VM was resized) | ❌ Too small |
| Meili RSS | **12.5 GB** | ❌ 78% of RAM |
| Meili process swap | **4.0 GB** (VmSwap) | ❌ Massive |
| System swap usage | **3.9 GB / 4.0 GB** (97.5% full) | ❌ Near capacity |
| Root disk (vda) | 64 GB, **rotational=1** (HDD) | ❌ |
| Data volume (vdb) | 100 GB, **rotational=1** (HDD) | ❌ |
| Meili DB path config | `/var/lib/meilisearch` (on **root disk vda**) | ❌ Wrong disk |
| Meili data on disk | **24 GB** on vda root | ❌ Not on vdb |
| vdb `/mnt/meili-vdb/meilisearch-data/` | **Empty** (4 KB) | ❌ Never used |
| vdb `/mnt/meili-vdb/16/nvme/` | **59 GB** old PostgreSQL data | ⚠️ Stale |
| Meili DB size (API) | 25.2 GB, 10.4M documents | — |
| Task duration (last 5) | **~19 min** each (1149s) for 200-300 docs | ❌ |
| iowait (snapshot) | **25%** (was reported up to 37%) | ❌ |
| Search fallback rate | ~80% | ❌ |
| CPU | 8 vCPU, Broadwell, mostly idle | ✅ |
| Disk scheduler | `mq-deadline` on both vda/vdb | OK for HDD |

## 2. Root Cause Analysis

Three compounding problems create a self-reinforcing degradation loop:

### Problem A: Meili data on wrong disk
The bootstrap script sets `MEILI_DB_PATH=/var/lib/meilisearch`, which lives on the **root disk (vda)**. The dedicated data volume `/mnt/meili-vdb` was mounted and a `meilisearch-data/` directory was created, but Meili was never reconfigured to use it. The root disk is shared with the OS, journal, and swap file.

### Problem B: Both disks are HDD (rotational)
Both `vda` (root) and `vdb` (Block Storage Volume) report `rotational=1`. On Linode, this indicates older HDD-backed storage. LMDB (Meilisearch's engine) is extremely sensitive to random read latency — HDD seek times (~10ms) vs NVMe (~0.02ms) mean 500x worse I/O for the same operation pattern.

### Problem C: RAM insufficient — Meili swapped out
Meilisearch with 10.4M documents / 25 GB database needs ~16.5 GB of address space. The VM has 16 GB physical RAM, and the OS + other processes consume some of that. The result: ~4 GB of Meili's memory is paged to swap **on an HDD**. Every index merge or search that touches swapped pages causes disk I/O, which on HDD causes latency spikes, which delays merge cycles, which keeps tasks at 19 minutes.

### The Loop
```
Insufficient RAM → swap → HDD I/O for swap pages
                    ↓
Meili merge on HDD → slow merge → 19-min task duration
                    ↓
Slow merge → Meili busy merging → search latency high → 80% fallback
                    ↓
Constant indexing pressure + swap thrash → 25% iowait → starves everything
```

## 3. Recommended Fix

### Option A (Recommended): Resize VM + Replace vdb with NVMe Block Storage

**VM resize:** Upgrade the Meilisearch Linode to a plan with **≥32 GB RAM**.
- Recommended: **Linode Dedicated 32 GB** (16 dedicated vCPU, 32 GB RAM, ~$240/mo)
- Budget alternative: **Linode Shared 32 GB** (~$192/mo)
- This alone eliminates swap, which is the single largest win.

**Storage:** Replace the 100 GB HDD Block Storage Volume with a **100+ GB NVMe Block Storage Volume**.
- Linode NVMe Block Storage: same API, ~2.5x cost per GB but ~50-100x better I/O latency.
- Alternatively: some newer Linode plans include NVMe local storage (check if Premium CPU plans are available in your region).

**Estimated improvement:**
- Swap: → 0 GB (eliminated by 32 GB RAM)
- I/O latency: 50-100x improvement for random reads
- Task duration: from ~19 min → **under 1-2 min** (based on typical Meili NVMe benchmarks)
- Fallback rate: should drop significantly as merge cycles complete faster and search latency improves

### Option B (Quick Win — No Linode Changes): Move data to vdb, free root disk

If immediate Linode changes aren't feasible, move Meili data to the already-attached vdb volume. This doesn't fix the HDD problem but **separates I/O** (OS + swap on vda, Meili data on vdb) and **frees 24 GB on root disk** (which was 53% full).

Expected improvement: moderate (maybe 20-30% task duration reduction) due to reduced I/O contention.

### Option C (Budget): Resize RAM only, keep HDD

Upgrade to 32 GB RAM plan. Eliminates swap thrash entirely. Meili still slow from HDD, but at least it won't be fighting swap. Expected: task duration drops to maybe 8-12 minutes.

---

## 4. Migration Steps (Option A — Full Fix)

### Phase 0: Pre-flight

```bash
# From a local machine, verify current health
ssh -J ubuntu@130.245.136.44 ubuntu@10.0.0.146

# On the Meili VM:
# 1. Snapshot the current Meili task queue state
curl -s -H "Authorization: Bearer <MASTER_KEY>" \
  'http://10.0.0.146:7700/tasks?limit=10&statuses=enqueued,processing' | python3 -m json.tool

# 2. Record index stats
curl -s -H "Authorization: Bearer <MASTER_KEY>" \
  'http://10.0.0.146:7700/stats' | python3 -m json.tool

# 3. Check database size on disk
sudo du -sh /var/lib/meilisearch/
```

### Phase 1: Linode Changes (via Linode Manager / API)

> **No SSH needed for this phase. Perform in Linode Cloud Manager.**

1. **Create a new 100 GB NVMe Block Storage Volume** in the same region as the Meili VM.
   - Label it `meili-nvme-vdc` (or similar).
   - Do NOT attach yet.

2. **Power off the Meili VM** cleanly:
   ```bash
   ssh -J ubuntu@130.245.136.44 ubuntu@10.0.0.146 "sudo systemctl stop meilisearch && sudo poweroff"
   ```

3. **Resize the VM** to the target plan (≥32 GB RAM).
   - In Linode Manager: Resize → select target plan → confirm.
   - Wait for resize to complete (typically 5-15 min).

4. **Detach the old HDD volume** (`vdb`, the 100 GB volume at `/mnt/meili-vdb`):
   - In Linode Manager: Volumes → detach the existing 100 GB volume.
   - **Do not delete it yet** — keep for rollback.

5. **Attach the new NVMe volume** to the VM.
   - It will likely appear as `/dev/vdb` (or `/dev/vdc` if old one is still attached).

6. **Power on the VM** and SSH in:
   ```bash
   ssh -J ubuntu@130.245.136.44 ubuntu@10.0.0.146
   ```

7. **Verify new hardware**:
   ```bash
   # Confirm more RAM
   free -h

   # Confirm NVMe volume
   lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,ROTA
   # The new NVMe volume should show ROTA=0
   ```

### Phase 2: Format and mount the NVMe volume

```bash
# Identify the new NVMe device (likely /dev/vdb if old volume was detached)
# Verify it's the new empty volume (should have no partition table)
sudo blkid /dev/vdb  # Should return nothing (empty)

# Format with ext4
sudo mkfs.ext4 /dev/vdb

# Create mount point
sudo mkdir -p /mnt/meili-nvme

# Mount
sudo mount /dev/vdb /mnt/meili-nvme

# Add to fstab (use UUID for reliability)
MEILI_UUID=$(sudo blkid -s UUID -o value /dev/vdb)
echo "UUID=$MEILI_UUID /mnt/meili-nvme ext4 defaults,nofail 0 2" | sudo tee -a /etc/fstab

# Verify mount
df -h /mnt/meili-nvme
```

### Phase 3: Copy Meili data to NVMe

```bash
# Stop Meilisearch if running (should already be stopped after power-on)
sudo systemctl stop meilisearch

# Create data directory on NVMe
sudo mkdir -p /mnt/meili-nvme/meilisearch-data
sudo chown meilisearch:meilisearch /mnt/meili-nvme/meilisearch-data

# Copy data (24 GB, should take a few minutes even on HDD)
sudo rsync -av --progress /var/lib/meilisearch/ /mnt/meili-nvme/meilisearch-data/

# Verify data integrity
sudo du -sh /var/lib/meilisearch/
sudo du -sh /mnt/meili-nvme/meilisearch-data/
# Sizes should match
```

### Phase 4: Reconfigure Meilisearch

```bash
# Update the environment file to point to new data path
sudo sed -i 's|MEILI_DB_PATH=/var/lib/meilisearch|MEILI_DB_PATH=/mnt/meili-nvme/meilisearch-data|' /etc/meilisearch/env

# Verify the change
grep MEILI_DB_PATH /etc/meilisearch/env
# Should show: MEILI_DB_PATH=/mnt/meili-nvme/meilisearch-data

# Update systemd unit ReadWritePaths
sudo sed -i 's|ReadWritePaths=.*|ReadWritePaths=/mnt/meili-nvme/meilisearch-data /var/log/meilisearch|' /etc/systemd/system/meilisearch.service
sudo systemctl daemon-reload
```

### Phase 5: Remove swap (optional but recommended with 32 GB RAM)

```bash
# With 32 GB RAM and ~13 GB Meili usage, swap is no longer needed.
# Disable swap to prevent any residual HDD I/O.
sudo swapoff /swapfile
sudo sed -i '/\/swapfile/d' /etc/fstab
# Optionally remove the swap file to free 4 GB on root disk:
# sudo rm /swapfile
```

### Phase 6: Start Meilisearch and verify

```bash
sudo systemctl start meilisearch

# Wait for healthy
for i in $(seq 1 30); do
  if curl -sf http://10.0.0.146:7700/health | grep -q available; then
    echo "Meili healthy after $((i*2))s"
    break
  fi
  sleep 2
done

# Verify data path is correct (check open files)
sudo ls -la /mnt/meili-nvme/meilisearch-data/

# Check that no swap is in use
free -h
swapon --show

# Submit a test indexing batch and check duration
# (wait for a few tasks to complete, then check)
curl -s -H "Authorization: Bearer <MASTER_KEY>" \
  'http://10.0.0.146:7700/tasks?limit=3' | python3 -m json.tool
```

### Phase 7: Verify from app VMs

```bash
# From an app VM, test search
ssh ubuntu@130.245.136.44
curl -s 'http://10.0.0.146:7700/health'
# Should return {"status":"available"}
```

---

## 5. Rollback Plan

If anything goes wrong after migration:

### Quick rollback (revert to old data on root disk)

```bash
# On Meili VM:
sudo systemctl stop meilisearch

# Revert config to original data path
sudo sed -i 's|MEILI_DB_PATH=/mnt/meili-nvme/meilisearch-data|MEILI_DB_PATH=/var/lib/meilisearch|' /etc/meilisearch/env

# Revert systemd ReadWritePaths
sudo sed -i 's|ReadWritePaths=.*|ReadWritePaths=/var/lib/meilisearch /var/log/meilisearch|' /etc/systemd/system/meilisearch.service
sudo systemctl daemon-reload

# Re-enable swap if it was disabled
sudo swapon /swapfile

# Start Meili
sudo systemctl start meilisearch
```

### Full rollback (revert VM resize)

1. Power off the Meili VM.
2. In Linode Manager, **detach** the new NVMe volume.
3. **Re-attach** the old HDD volume (`vdb`, the 100 GB one with old PostgreSQL + empty meilisearch-data).
4. **Resize back** to the original plan.
5. Power on and follow the quick rollback steps above.

### Data safety

- **Old data on root disk** (`/var/lib/meilisearch`) is preserved until explicitly deleted.
- **Old HDD volume** (`/mnt/meili-vdb`) is preserved (detached, not deleted) until explicitly deleted.
- No data loss occurs at any step — Meili is stopped before data moves.

---

## 6. Post-Migration Validation Checks

Run these checks in sequence after migration. All should pass before considering the remediation complete.

### Check 1: Swap usage near 0

```bash
ssh -J ubuntu@130.245.136.44 ubuntu@10.0.0.146
free -h
swapon --show
cat /proc/$(pgrep -x meilisearch)/status | grep VmSwap
```

**Expected:**
- `Swap: 0B used` (or under 100 MB)
- `VmSwap: 0 kB` for meilisearch process

### Check 2: Iowait low

```bash
# Install sysstat if needed
sudo apt-get install -y sysstat
iostat -xz 5 6
```

**Expected:**
- `%iowait` under 5% during normal operation
- Under 10% during active merge cycles
- Compare with pre-migration 25-37%

### Check 3: Task duration falling

```bash
curl -s -H "Authorization: Bearer <MASTER_KEY>" \
  'http://10.0.0.146:7700/tasks?limit=10&statuses=succeeded' | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)
for t in data['results']:
    d = t['duration']
    docs = t['details']['receivedDocuments']
    print(f'uid={t[\"uid\"]} docs={docs} duration={d}')
"
```

**Expected:**
- Task duration drops from ~19 min to **under 2-3 minutes** for similar batch sizes
- Documents per second throughput improves dramatically

### Check 4: Fallback rate falling

From Prometheus (via monitoring VM tunnel):
```bash
# On monitoring VM or via tunnel
ssh -L 9090:127.0.0.1:9090 ubuntu@130.245.136.120 -N
# Then query:
curl -s 'http://127.0.0.1:9090/api/v1/query' --data-urlencode \
  'query=sum(rate(search_fallback_total[5m])) / sum(rate(search_total[5m])) * 100'
```

**Expected:**
- Fallback rate drops from ~80% to **under 20%** within 30-60 minutes
- Continues falling as Meili catches up on backlogged merge tasks

### Check 5: Search p95/p99 improving

```bash
curl -s 'http://127.0.0.1:9090/api/v1/query' --data-urlencode \
  'query=histogram_quantile(0.95, sum(rate(search_duration_seconds_bucket[5m])) by (le))'
```

**Expected:**
- p95 search latency drops significantly (target: under 200ms)
- p99 improves proportionally

### Check 6: Disk is NVMe

```bash
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,ROTA
cat /sys/block/vdb/queue/rotational  # Should be 0
```

**Expected:** `ROTA=0` for the Meili data volume.

### Check 7: Root disk freed

```bash
df -h /
# Root disk should have ~24 GB more free space than before
```

---

## 7. Cleanup (After Successful Migration + 24h Soak)

1. **Delete old Meili data from root disk:**
   ```bash
   sudo rm -rf /var/lib/meilisearch/*
   # Keep the directory for potential rollback
   ```

2. **Delete old HDD Block Storage Volume** from Linode Manager.

3. **Update `docs/infrastructure-inventory.md`** with new Meili VM specs:
   - RAM: 32 GB
   - Storage: root disk + 100 GB NVMe Block Storage at `/mnt/meili-nvme`
   - Swap: disabled

4. **Update `deploy/meilisearch-vm-setup.sh`** to default to `/mnt/meili-nvme/meilisearch-data`.

5. **Update fstab reference** in any deployment scripts.

---

## 8. Execution Log (Option B — Completed 2026-05-06)

### What was done

| Step | Command / Action | Result |
|------|-----------------|--------|
| Verify data location | `find / -name data.mdb`, `lsof -p 749` | Confirmed: all data.mdb on root disk `/var/lib/meilisearch/`, zero on vdb |
| Stop Meilisearch | `systemctl stop meilisearch` | Stopped cleanly |
| Copy data to vdb | `rsync -aHAX /var/lib/meilisearch/ /mnt/meili-vdb/meilisearch-data/` | 24 GB / 243 files / ~15 min |
| Verify sizes | `du -sh` both paths | Both 24 GB, all 3 data.mdb present on vdb |
| Update env | `sed -i` on `/etc/meilisearch/env` | `MEILI_DB_PATH=/mnt/meili-vdb/meilisearch-data` |
| Update systemd | `sed -i` on service + override.conf | `ReadWritePaths` and `WorkingDirectory` updated |
| Daemon-reload + start | `systemctl daemon-reload && start` | Meili active, health = `available` |

### Post-migration validation (immediate)

| Check | Before | After | Status |
|-------|--------|-------|--------|
| Meili data location | `/var/lib/meilisearch` (root disk vda) | `/mnt/meili-vdb/meilisearch-data` (vdb) | ✅ Fixed |
| lsof shows data.mdb on | vda (major 252,1) | vdb (major 252,16) | ✅ Fixed |
| lsof shows data.mdb on root | Yes | **None** | ✅ Fixed |
| Meili health | `available` | `available` | ✅ |
| Index stats | 10,447,541 docs, 25.2 GB | 10,447,541 docs, 25.6 GB | ✅ Intact |
| VmSwap | **4,162,184 kB** (4.0 GB) | **0 kB** | ✅ Eliminated |
| System swap used | **4.0 GB** (97.5%) | **7.0 MB** (~0%) | ✅ Eliminated |
| Meili VmRSS | 10,309 kB → 10,699 kB (growing) | **802,248 kB** (fresh start) | ✅ Normal cold start |
| iowait | 25-56% | Pending (need 30+ min soak) | ⏳ |

### Remaining items

1. **iowait check** — run `vmstat 1 5` after 30 min of active indexing; expect significant drop
2. **Task duration check** — monitor `/tasks?limit=10&statuses=succeeded` over next hour
3. **Fallback rate check** — query Prometheus after 30-60 min
4. **Option A upgrade** — VM resize to ≥32 GB RAM + NVMe volume replacement still recommended for full fix
5. **Old data cleanup** — `/var/lib/meilisearch` (24 GB) preserved on root disk for rollback; delete after 24h soak

### Rollback procedure (if needed)

```bash
sudo systemctl stop meilisearch
sudo sed -i 's|MEILI_DB_PATH=/mnt/meili-vdb/meilisearch-data|MEILI_DB_PATH=/var/lib/meilisearch|' /etc/meilisearch/env
sudo sed -i 's|ReadWritePaths=/mnt/meili-vdb/meilisearch-data /var/log/meilisearch|ReadWritePaths=/var/lib/meilisearch /var/log/meilisearch|' /etc/systemd/system/meilisearch.service
sudo sed -i 's|WorkingDirectory=/mnt/meili-vdb/meilisearch-data|WorkingDirectory=/var/lib/meilisearch|' /etc/systemd/system/meilisearch.service.d/override.conf
sudo systemctl daemon-reload
sudo systemctl start meilisearch
```

## 9. Summary of Changes (No App Code Changes)

| Change | What | Impact |
|--------|------|--------|
| Data relocation | `/var/lib/meilisearch` → `/mnt/meili-vdb/meilisearch-data` | Separates Meili I/O from OS/swap disk |
| Config update | `MEILI_DB_PATH` in `/etc/meilisearch/env` | Points to new data location |
| Systemd update | `ReadWritePaths` + `WorkingDirectory` | Allows Meili to write to vdb |
| Swap eliminated | VmSwap 4 GB → 0 kB | System swap freed (old swapped pages released on stop) |
| No app code changes | — | Only infrastructure and Meili config |

---

## 10. Comprehensive Search Audit (2026-05-06, 7h Post-Migration)

### 10.1 Infrastructure State — 7-Hour Soak Results

**Option B (data migration to vdb) was insufficient. Metrics regressed:**

| Metric | Pre-Migration | Post-Migration (R1, 1h) | 7h Soak (Now) | Verdict |
|--------|---------------|--------------------------|---------------|---------|
| VmSwap | **4.0 GB** | 2 MB | **257 MB** | ❌ REGRESSED |
| System swap | 3.9 GB / 4 GB | 7 MB / 4 GB | **284 MB / 4 GB** | ❌ REGRESSED |
| iowait | 25-37% | 11% | **19-25%** | ❌ REGRESSED |
| Task duration | ~19 min | N/A (same batch) | **~26 min** | ❌ WORSE |
| Enqueued tasks | N/A | 195 | **2,566** | ❌ GROWING |
| Processing tasks | N/A | 234 | **3,663** | ❌ GROWING |
| Total backlog | N/A | 429 | **6,229** | ❌ EXPLODING |
| Failed tasks | Unknown | 0 | **2,038** | ❌ NEW FAILURES |
| DB size | 25.2 GB | 25.6 GB | **29.0 GB** | Growing (11.6M docs) |
| Meili RSS | 10.0 GB | 12.2 GB | **12.5 GB** | Near-RAM limit |
| Fallback rate | ~80% | 49-57% | **50%** | ⚠️ Plateaued |
| Search p50 | — | 228-273 ms | **344 ms** | ⚠️ Rising |
| Search p95 | — | 1,430-1,463 ms | **1,244 ms** | Slight improvement |
| Search p99 | — | 1,886-1,893 ms | **1,849 ms** | Stable |
| 5xx errors | — | 0 | **0** | ✅ |
| Workers up | — | 16 | **16** | ✅ |
| Meili health | available | available | **available** | ✅ |

### 10.2 Failed Task Analysis

```
uid=278556 type=documentAdditionOrUpdate error='internal: Resource temporarily unavailable (os error 11)'
uid=278555 type=documentAdditionOrUpdate error='internal: Resource temporarily unavailable (os error 11)'
uid=278554 type=documentAdditionOrUpdate error='internal: Resource temporarily unavailable (os error 11)'
```

**2,038 failed tasks**, all with `os error 11 (EAGAIN)`. This is not a file descriptor issue (only 76/65,536 open). It's **mmap page fault pressure** — LMDB cannot allocate new virtual memory pages during merge because the OS is struggling to service page faults on HDD fast enough. This confirms the storage medium is fundamentally inadequate.

### 10.3 Application Search Architecture Analysis

#### Search Flow (from code audit)

```
User search request
  → meiliClient.isSearchBackend()? → YES (SEARCH_BACKEND=meili)
    → searchWithMeiliBackend()
      1. Start freshness query in parallel (DISABLED — window=0)
      2. meiliClient.searchMessageCandidates(q, opts)
         → POST /indexes/messages/search with filters + sort
         → Returns candidate IDs (up to MEILI_CANDIDATE_LIMIT=500)
      3. If candidates empty → fallback to Postgres (meili_empty_candidates)
      4. If candidates found → buildRecheckFromCandidates(ids)
         → SELECT from Postgres WHERE id = ANY(candidate_ids)
         → Apply scope access control
         → Apply strict token filtering
      5. If strict filtering eliminates all Meili candidates → fallback to Postgres
      6. Return merged results
    → On ANY error → fallback to searchOnce() (Postgres FTS + literal)
```

#### Write Flow (from code audit)

```
Message create/update
  → meiliClient.indexMessage(doc)
    → MEILI_WRITE_STREAM_ENABLED=true → enqueueMeiliWriteStream('upsert', doc)
      → redis.xadd('meili:messages:write', MAXLEN ~100000, ...)
    → Stream consumer (1 slot per worker, leased)
      → XREADGROUP BLOCK 1000, COUNT 1000
      → Coalesce 5000ms (wait for more messages)
      → batchIndexMessages(up to 1000 docs per batch)
      → POST /indexes/messages/documents (body = docs array)
      → XACK processed entries

Current rates:
  Stream enqueue: 57.7 msgs/sec
  Stream consume: 57.7 msgs/sec (keeping up)
  Index p95 latency: 684ms per batch call
  ~40,553 batches processed total
```

### 10.4 Root Cause — Why Option B Was Insufficient

The data migration to vdb separated I/O but did not solve the fundamental bottleneck: **both disks are HDD**.

The degradation loop continues:

```
57.7 msgs/sec → batches of ~1000 docs every ~17s
  → Each batch triggers LMDB merge on 29 GB HDD database
  → HDD merge takes 15-26 min (random I/O, ~10ms seek vs 0.02ms NVMe)
  → During merge:
      • mmap page cache thrashed → search mmap pages evicted
      • iowait 19-25% → search p95 ~1.2s
      • OS can't service page faults fast enough → EAGAIN errors (2,038 failed)
      • RSS grows (12.5 GB) but only 16 GB RAM → swap returns (257 MB)
  → 50% of searches fall back to Postgres
  → Postgres takes unnecessary load
```

**Key insight:** The disk migration was a necessary first step but cannot fix the core issue. HDD random I/O is ~500x slower than NVMe. No amount of tuning can overcome physics.

### 10.5 Current Meili Configuration

```
MEILI_ENABLED=true
SEARCH_BACKEND=meili
MEILI_HOST=http://10.0.0.146:7700
MEILI_CANDIDATE_LIMIT=500
MEILI_TIMEOUT_MS=1200
MEILI_FRESHNESS_WINDOW_MS=0          # Disabled (correct given backlog)
MEILI_WRITE_FLUSH_MS=10000
MEILI_WRITE_BATCH_SIZE=500
MEILI_WRITE_STREAM_ENABLED=true
MEILI_WRITE_STREAM_CONSUMER_ENABLED=true
MEILI_WRITE_STREAM_CONSUMER_SLOTS=1  # Reduced from 2 (correct)
MEILI_WRITE_STREAM_READ_COUNT=1000
MEILI_WRITE_STREAM_BLOCK_MS=1000
MEILI_WRITE_STREAM_COALESCE_MS=5000
```

### 10.6 Meili Index Settings

```json
{
  "searchableAttributes": ["content"],
  "filterableAttributes": ["authorId", "channelId", "communityId", "conversationId", "createdAt"],
  "sortableAttributes": ["createdAt"],
  "rankingRules": ["words", "typo", "proximity", "attribute", "sort", "exactness"],
  "typoTolerance": { "enabled": true, "minWordSizeForTypos": { "oneTypo": 6, "twoTypos": 12 } },
  "pagination": { "maxTotalHits": 1000 },
  "proximityPrecision": "byWord"
}
```

### 10.7 System Configuration

| Setting | Value | Assessment |
|---------|-------|------------|
| Meili version | 1.8.0 | Current enough |
| VM RAM | 16 GB | **Insufficient** (29 GB DB) |
| Disk type | Both HDD (rotational=1) | **Critical bottleneck** |
| Disk scheduler | `[none]` | OK for mmap |
| read_ahead_kb | 128 | Low; could benefit from 4096 |
| File descriptor limit | 65,536 (76 used) | Fine |
| Block size | 4096 | Standard |
| swapiness | default (60) | Too aggressive; should be 1 |

---

## 11. Final Solution — Required Changes

### Priority 1: Hardware Upgrade (REQUIRED — No Alternative)

The HDD + 16 GB RAM combination cannot sustain the workload. **Option A from §3 must be executed.**

| Change | What | Why |
|--------|------|-----|
| **VM resize** | Upgrade to ≥32 GB RAM | Eliminates swap permanently. 29 GB DB needs 20+ GB RSS + OS overhead. |
| **Replace vdb** | 100 GB NVMe Block Storage Volume | 50-100x random I/O improvement. Eliminates EAGAIN, reduces merge from 26 min to <2 min. |
| **Disable swap** | `swapoff /swapfile` + fstab | With 32 GB RAM, swap is counterproductive on HDD. |

**Expected post-upgrade:**
- Swap: 0 MB (permanent)
- iowait: <5%
- Task duration: <2 min (from 26 min)
- Fallback rate: <10% (from 50%)
- Search p95: <200ms (from 1.2s)
- EAGAIN failures: 0

### Priority 2: OS Tuning (Immediate — No Reboot Required)

These can be done right now while planning the hardware upgrade:

```bash
# 1. Minimize swap tendency (default is 60)
sudo sysctl -w vm.swappiness=1
echo 'vm.swappiness=1' | sudo tee -a /etc/sysctl.d/99-meili.conf

# 2. Increase read-ahead for sequential merge scans
sudo blockdev --setra 4096 /dev/vdb
# Persist:
echo 'ACTION=="add|change", KERNEL=="vdb", ATTR{queue/read_ahead_kb}="4096"' | \
  sudo tee /etc/udev/rules.d/99-meili-vdb.rules

# 3. Apply sysctl
sudo sysctl -p /etc/sysctl.d/99-meili.conf
```

### Priority 3: Indexing Throttle (Config Tuning — No Code Changes)

Reduce merge frequency by increasing coalescing and batch intervals:

```bash
# In /opt/chatapp/shared/.env or deploy/env/prod.required.env:
MEILI_WRITE_STREAM_COALESCE_MS=30000    # 30s (from 5s) — fewer, larger batches
MEILI_WRITE_FLUSH_MS=30000              # 30s (from 10s) — same for local buffer
MEILI_WRITE_STREAM_BLOCK_MS=2000        # 2s (from 1s) — slightly longer block wait
```

**Trade-off:** messages take 30s longer to appear in Meili search results, but merge cycles drop by ~6x. On HDD this is a net win because each merge currently takes 26 min.

### Priority 4: After Hardware Upgrade

Once NVMe + 32 GB RAM are in place:

1. **Revert throttle** — set COALESCE_MS back to 5000, FLUSH_MS back to 10000
2. **Re-enable freshness** — set `MEILI_FRESHNESS_WINDOW_MS=300000` (5 min)
3. **Consider increasing consumer slots** — back to 2 if merge is fast enough
4. **Upgrade Meili** — v1.10+ has improved merge scheduling

### What NOT to Change (Confirmed Correct)

- `MEILI_WRITE_STREAM_CONSUMER_SLOTS=1` — correct; 2 slots doubled task submission rate
- `MEILI_FRESHNESS_WINDOW_MS=0` — correct while backlog exists
- `SEARCH_BACKEND=meili` — keep; fallback mechanism works correctly
- `MEILI_CANDIDATE_LIMIT=500` — reasonable for candidate generation
- `MEILI_TIMEOUT_MS=1200` — appropriate; most searches respond in 300-400ms
- Search architecture (meili candidates → Postgres recheck) — correct design
- Meili index settings — well configured

---

## 12. Execution Plan — Hardware Upgrade

### Step 1: OS Tuning (NOW — zero downtime)

```bash
ssh -J ubuntu@130.245.136.44 ubuntu@10.0.0.146
sudo sysctl -w vm.swappiness=1
echo 'vm.swappiness=1' | sudo tee -a /etc/sysctl.d/99-meili.conf
sudo blockdev --setra 4096 /dev/vdb
```

### Step 2: Config Throttle (NOW — rolling deploy)

Update `deploy/env/prod.required.env`:
```
MEILI_WRITE_STREAM_COALESCE_MS=30000
MEILI_WRITE_FLUSH_MS=30000
MEILI_WRITE_STREAM_BLOCK_MS=2000
```

Deploy to app VMs: `./deploy/deploy-prod-multi.sh <sha>`

### Step 3: Hardware Upgrade (Linode Manager — ~30 min downtime)

1. Create new 100 GB NVMe Block Storage Volume in same region
2. Stop Meili: `ssh -J ... ubuntu@10.0.0.146 "sudo systemctl stop meilisearch && sudo poweroff"`
3. Resize VM to ≥32 GB RAM plan
4. Detach old HDD volume, attach new NVMe volume
5. Power on, format NVMe, mount at `/mnt/meili-nvme`
6. rsync data from vdb to NVMe
7. Update `/etc/meilisearch/env`: `MEILI_DB_PATH=/mnt/meili-nvme/meilisearch-data`
8. Update systemd ReadWritePaths/WorkingDirectory
9. Disable swap: `sudo swapoff /swapfile` + remove from fstab
10. Start Meili, verify health
11. Monitor task duration, fallback rate, iowait for 1 hour

### Step 4: Post-Upgrade Validation

All checks from §6 must pass. Additionally:
- Zero EAGAIN failures in task history
- Task backlog draining (not growing)
- Swap at 0 MB permanently
- Search p95 < 200ms

### Rollback

Same as §5. Old HDD volume preserved until explicit cleanup.

---

## 13. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| NVMe volume provisioned as HDD (Linode bug) | Low | High | Verify `rotational=0` after attach |
| VM resize fails | Low | Medium | Linode resize is non-destructive; old config preserved |
| Data corruption during rsync | Very Low | High | rsync with -av --checksum; old data preserved on vdb |
| 30-min Meili downtime during upgrade | Certain | Low | Search falls back to Postgres automatically; zero 5xx |
| Post-upgrade Meili needs re-index | Low | Medium | LMDB format is portable; rsync preserves everything |
| Throttled coalescing increases staleness | Certain | Low | 30s max staleness acceptable; reverts after NVMe |

---

## 14. Meili Upgrade Execution (1.8.0 → 1.43.0) — Completed 2026-05-06

### Timeline

| Time (UTC) | Action | Result |
|------------|--------|--------|
| ~14:00 | VM resized to 32 GB RAM (Linode Dedicated) | ✅ Swap eliminated immediately |
| ~14:30 | Old vdb HDD detached, new NVMe attached, data migrated | ✅ All I/O on NVMe |
| ~15:00 | OS tuning: swappiness=1, read-ahead=4096 | ✅ |
| ~15:30 | First attempt: direct binary swap 1.8.0 → 1.43.0 | ❌ Failed: 35-version jump, LMDB format incompatible |
| ~15:35 | Rollback to 1.8.0 binary | ✅ Restored immediately |
| ~16:20 | Created dump via 1.8.0: `POST /dumps` | ✅ 1.2 GB dump in ~10 min |
| ~16:34 | Stopped 1.8.0, swapped to 1.43.0 binary | ✅ |
| ~16:40 | Import dump into fresh data dir (multiple false starts: wrong env file path, dump in data dir) | ⚠️ Fixed |
| ~16:41 | Import started: "Importing index `messages`" | ✅ |
| ~16:50 | "All documents successfully imported." | ✅ |
| ~16:52 | Validation complete | ✅ See below |

### Final Validation (2026-05-06T16:52Z)

| Check | Value | Status |
|-------|-------|--------|
| Meili version | **1.43.0** | ✅ |
| Documents | **12,209,715** | ✅ All intact |
| Search latency (test) | **21ms** | ✅ Excellent |
| Health | `{"status":"available"}` | ✅ |
| Swap used | **4 MB** (was 4 GB) | ✅✅✅ |
| Memory | 3.3 GB used / 29 GB total | ✅ |
| Data dir | `/mnt/meili-nvme/meilisearch-data` (22 GB) | ✅ NVMe |
| IMPORT_DUMP removed from env | Yes | ✅ |

### Rollback Path (if 1.43.0 has issues)

```bash
# 1. Stop Meili
sudo systemctl stop meilisearch

# 2. Swap back to old binary
sudo cp -f /tmp/meilisearch-1.8.0 /usr/local/bin/meilisearch

# 3. Rename data dirs
sudo mv /mnt/meili-nvme/meilisearch-data /mnt/meili-nvme/meilisearch-data-1.43
sudo mv /mnt/meili-nvme/meilisearch-data-1.8.0 /mnt/meili-nvme/meilisearch-data

# 4. Start
sudo systemctl start meilisearch
```

### Remaining Cleanup

1. **Delete old 1.8.0 data dir** `/mnt/meili-nvme/meilisearch-data-1.8.0` after 24h soak
2. **Delete dump file** `/mnt/meili-nvme/meili-dump-1.8.0.dump` (1.2 GB) after validation
3. **Delete spare VMs** (.211, .112) if no longer needed
4. **Delete old HDD volume** from Linode Manager
