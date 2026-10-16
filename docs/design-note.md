# MayaCardio — System Design Note: "Never Lose a Heartbeat"

## 1. Architecture Overview

MayaCardio is a durable, local-first biosignal acquisition and analytics pipeline designed for critical bedside medical monitoring. The system comprises two operational tiers:

```
  +--------------------------------------------------------------------------+
  |                           BEDSIDE DEVICE (ARM64)                         |
  |                                                                          |
  |  +--------------------+        TCP/NDJSON       +---------------------+  |
  |  |   biosignal-mock   | ----------------------> | Collector & CRC-32  |  |
  |  |  (Sensor 1 & 2)    | <---------------------- | Reread Coordinator  |  |
  |  +--------------------+   {"cmd":"read",...}    +----------+----------+  |
  |                                                            |             |
  |                                                 Atomic WAL | Commits     |
  |                                                            v             |
  |                                                 +---------------------+  |
  |                                                 | SQLite Storage      |  |
  |                                                 | (synchronous=FULL)  |  |
  |                                                 +----+-----------+----+  |
  |                                                      |           |       |
  |                       +------------------------------+           |       |
  |                       v                                          v       |
  |         +---------------------------+              +------------------+  |
  |         | Device Processor (Offline)|              | Sync & State     |  |
  |         | - Window Engine (§3)      |              | Machine Worker   |  |
  |         +---------------------------+              +--------+---------+  |
  +-------------------------------------------------------------|------------+
                                                                | HTTPS Batches
                                                                v
  +--------------------------------------------------------------------------+
  |                               CLOUD BACKEND                              |
  |                                                                          |
  |         +-------------------------------------------------------+        |
  |         | Fastify Ingestion API (/api/v1/sync/batch, /coverage)  |        |
  |         +---------------------------+---------------------------+        |
  |                                     |                                    |
  |                     +---------------+---------------+                    |
  |                     v                               v                    |
  |        +-------------------------+    +----------------------------+     |
  |        | PostgreSQL Timeseries   |    | Cloud Processor (Online)   |     |
  |        | - Idempotent Ingestion  |    | - Window Engine (<5s SLA)  |     |
  |        +-------------------------+    +----------------------------+     |
  +--------------------------------------------------------------------------+
```

### Component Boundaries
1. **Collector & CRC-32 Validator**: Sequentially queries Sensor 1 (3 channels) and Sensor 2 (2 channels) over raw TCP NDJSON, enforcing single-client discipline. Validates standard zlib CRC-32 across raw `data` text (`[` to `]`). Corrupt replies trigger immediate rereads via `from_index`.
2. **Durable Device Storage**: Backed by SQLite in WAL mode with `PRAGMA synchronous = FULL`. Transactions insert samples and advance sensor checkpoints atomically.
3. **Shared Signal Engine (`@mayacardio/processing`)**: Deterministic calculations shared between device and cloud:
   - Windowing: 1-second slices ($[400w, 400w+399]$), computing `missing_1`, `missing_2`, `complete`.
   - Descriptive Stats: Per-channel min, max, and 1-decimal rounded mean (null if count $= 0$).
   - Sensor 2 Magnitude: Mean of $\sqrt{ch1^2 + ch2^2}$ rounded to 1 decimal place.
   - Heart Rate: Evaluated on Sensor 1 Channel 2 using 800-sample history, 1-sample lookahead, strict local peak test, $> 0.5 \times \max(800)$, 100-sample refractory gap, and 5-second window $[400(w-4), 400(w+1)-1]$.
4. **State Machine & Catch-Up Reconciler**: Automatically transitions between `ONLINE`, `OFFLINE`, and `RECOVERING` within 10 seconds of network change. During outages, data accumulates locally and is processed offline. On reconnection, bursts of chunked batches reconcile cloud coverage without dropping or duplicating a single sample.

---

## 2. What is Guaranteed and What is Not

### Guarantees
- **Zero Silent Data Loss**: Every sample received from the mock is committed to non-volatile disk or explicitly recorded in the loss ledger with an auditable reason code (`buffer_overflow`, `mock_restart`, `outage`).
- **Zero Data Fabrication / Invention**: Gaps are never filled with interpolated, synthesized, or assumed values. Missing samples are honestly recorded.
- **Durable Checkpoint Atomicity**: A sensor checkpoint is never advanced unless the corresponding samples are flushed to physical disk.
- **Idempotent Cloud Completeness**: Final cloud storage contains every collected sample exactly once (`PRIMARY KEY (session_id, sensor, sample_index)`), tolerating network retries, duplicate responses, and interrupted uploads.
- **Mode Transition Latency**: Mode switching between online and offline triggers within $\le 10$ seconds of connectivity changes.
- **Deterministic Processing Parity**: A given sample set produces mathematically identical statistics, magnitude, and heart rate whether evaluated on device or in cloud.

### Non-Guarantees (Explicit Operational Boundaries)
- **Data Not Delivered by Mock Before Restart**: If the mock service restarts before delivering samples, unread samples never reached device memory. The pipeline formally lists this interval with `to_index: null, reason: "mock_restart"`.
- **Mock Ring Buffer Overflow During Extended Disconnect**: If the collector cannot poll the mock for $> 10$ seconds, the mock's internal ring buffer evicts unread samples. The pipeline records `buffer_overflow` losses for the evicted range.
- **Indefinite Storage Capacity**: Local disk assumes sufficient storage for operational buffering (e.g. at least 1 GB flash storage for ~30 hours of continuous offline data). Under disk-full conditions, SQLite halts write operations rather than corrupting existing committed records.

---

## 3. Maximum Data Loss on a Power Cut, and Why

### The Guarantee
**Maximum data loss on sudden power cutoff is strictly bounded to at most ONE in-flight read batch ($\le 0.5$ seconds / 200 samples), and 0.0 seconds of committed data.**

### Physical and Architectural Rationale
1. **SQLite WAL with `synchronous = FULL`**:
   In SQLite WAL mode, `PRAGMA synchronous = FULL` ensures that after every commit of a sample batch, an explicit `fsync()` system call is issued to both the Write-Ahead Log (`-wal`) and directory metadata before returning control. This forces OS page cache frames and physical flash storage controller write buffers to non-volatile media.
2. **Atomic Batch Ingestion**:
   Samples are fetched from the mock in small intervals ($\le 1$ second, typically 200–400 samples). Persisting the samples and updating the durable sensor checkpoint (`last_received_index`) occurs within a single `BEGIN IMMEDIATE ... COMMIT` transaction.
3. **Power Loss Recovery**:
   If power is yanked mid-write:
   - Any half-written WAL frame will fail its internal checksum upon restart.
   - During restart recovery, SQLite automatically truncates the torn frame and restores the database to the exact state of the last committed transaction.
   - The durable checkpoint will reflect the last successfully committed sample index.
   - On reboot, the collector inspects `last_received_index` and issues a `from_index: last_received_index + 1` reread. If the mock's 10-second ring buffer still retains those samples, **zero samples are lost**. If the mock also lost power and restarted, the unread gap is formally logged into the durable loss ledger with `reason: "mock_restart"`.
