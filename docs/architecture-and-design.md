# MayaCardio — Architecture and System Design Document

## 1. System Overview

MayaCardio is an edge-to-cloud biosignal acquisition and processing pipeline engineered for high-criticality bedside environments (e.g., intensive care, remote triage). Bedside environments suffer from intermittent connectivity, process crashes, power cutoffs, and unattended operation.

The system guarantees:
- **Zero Silent Data Loss**: Every received sample is either persisted durably on disk or formally recorded in a durable loss ledger with an explicit causality code.
- **Zero Data Fabrication / Interpolation**: Missing data is never synthetically filled or averaged away.
- **Parity Across Boundaries**: The edge device and cloud backend share the exact same deterministic signal-processing engine (`@mayacardio/processing`).
- **Resilient Automatic Mode Switching**: Fast (<=10s) transition between ONLINE, OFFLINE, and RECOVERING states without sample duplication or omission.
- **Resource Discipline**: Operates strictly within Raspberry Pi 4 constraints (ARM64, <= 4 cores, <= 2 GB RAM).

```
 +-----------------------------------------------------------------------------------------+
 |                                  BEDSIDE DEVICE (ARM64)                                 |
 |                                                                                         |
 |  +--------------------+       TCP / NDJSON        +----------------------------------+  |
 |  |   biosignal-mock   | ------------------------> |   @mayacardio/collector          |  |
 |  |  (Sensor 1 & 2)    | <------------------------ |   - Strict Framing & CRC-32      |  |
 |  +--------------------+   {"cmd":"read",...}      |   - Session & Reread Coordinator |  |
 |                                                   +-----------------+----------------+  |
 |                                                                     |                   |
 |                                                       Atomic Commit | Samples & Losses  |
 |                                                                     v                   |
 |                                                   +----------------------------------+  |
 |                                                   |   @mayacardio/device-storage     |  |
 |                                                   |   - SQLite WAL (synchronous=FULL)|  |
 |                                                   |   - Samples, Checkpoints, Losses |  |
 |                                                   +-----------------+----------------+  |
 |                                                                     |                   |
 |               +-----------------------------------------------------+                   |
 |               |                                                     |                   |
 |               v                                                     v                   |
 |  +--------------------------+                         +------------------------------+  |
 |  | @mayacardio/processor    |                         |  @mayacardio/sync            |  |
 |  | (Offline Mode Worker)    |                         |  - Resilient Catch-Up Worker |  |
 |  | - Shared Processing Core |                         |  - Tri-State Mode Controller |  |
 |  +--------------------------+                         +--------------+---------------+  |
 +----------------------------------------------------------------------|------------------+
                                                                        | HTTPS (mTLS/Token)
                                                                        | Idempotent Batches
                                                                        v
 +-----------------------------------------------------------------------------------------+
 |                                     CLOUD BACKEND                                       |
 |                                                                                         |
 |  +-----------------------------------------------------------------------------------+  |
 |  |                            @mayacardio/cloud-api (Fastify)                        |  |
 |  |  - Ingestion Endpoints (/api/v1/sessions, /samples, /losses, /sync/reconcile)       |  |
 |  |  - Authentication & Zod Request Schema Validation                                 |  |
 |  +---------------------------------------------+-------------------------------------+  |
 |                                                |                                        |
 |                       +------------------------+------------------------+               |
 |                       |                                                 |               |
 |                       v                                                 v               |
 |        +------------------------------+                  +----------------------------+ |
 |        |    PostgreSQL Timeseries     |                  |  @mayacardio/processor     | |
 |        |    - Idempotent Ingestion    |                  |  (Online Mode Engine)      | |
 |        |    - Coverage & Gap Ledger   |                  |  - Window Results (<5s)    | |
 |        +------------------------------+                  +----------------------------+ |
 +-----------------------------------------------------------------------------------------+
```

---

## 2. Sensor Protocol & Integrity Layer

### 2.1 Sensor Characteristics
- **Sensor 1**: 3 channels, 400 Hz sampling rate, signed 24-bit integer values $[-8,388,608 \dots 8,388,607]$.
- **Sensor 2**: 2 channels, 400 Hz sampling rate, signed 24-bit integer values.
- Synchronized timebases: Sample $i$ of Sensor 1 and Sample $i$ of Sensor 2 correspond to the exact same temporal instance.

### 2.2 TCP / NDJSON Wire Framing
- The mock communicates over raw TCP using newline-delimited JSON (`\n`).
- The collector coordinates polling sequentially between Sensor 1 and Sensor 2 because the mock enforces a strict single-client connection rule.
- Request format: `{"cmd": "read", "sensor": 1}` or with reread parameter `{"cmd": "read", "sensor": 1, "from_index": 120000}`.
- Reply format:
  ```json
  {
    "session_id": "5f0c2a9e",
    "sensor": 1,
    "first_index": 120000,
    "count": 3,
    "lost": [],
    "session_end": false,
    "crc32": "f9a5bf62",
    "data": [[720, 1200, 1560], [708, 1180, 1534], [726, 1210, 1573]]
  }
  ```

### 2.3 Strict CRC-32 Verification
- The assessment specifies: `CRC-32 (zlib) of the data text exactly as sent, from [ to the matching ]. A reply with a wrong value is corrupt and must not be used.`
- Standard zlib CRC-32 (polynomial `0xEDB88320`) is evaluated directly across the exact substring matching `data`.
- If the computed CRC-32 does not match the received hexadecimal string:
  1. The entire batch is rejected.
  2. A diagnostic fault event is logged.
  3. The collector issues an immediate reread for the same sensor using `from_index: first_index`.
  4. If the mock repeatedly fails or data slides past the 10-second mock ring buffer, a loss entry is recorded in the loss ledger.

---

## 3. Durable Storage & Power-Cut Loss Model

### 3.1 SQLite Engine Configuration
Edge-side durability is implemented via SQLite (`better-sqlite3`):
```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```
- **Atomic Batches**: Inserting a batch of $N$ samples and updating the durable sensor checkpoint occurs inside a single explicit `BEGIN IMMEDIATE ... COMMIT` transaction.
- **Unique Constraint**: `PRIMARY KEY (session_id, sensor, sample_index)`. Duplicate arrivals (e.g. from retried reads or overlaps) are checked for consistency:
  - If received values identical: skipped idempotently (`ON CONFLICT DO NOTHING`).
  - If values conflict: flagged as an unrecoverable corruption fault and logged into the audit ledger.

### 3.2 Maximum Data Loss on Sudden Power Cut
- **Guaranteed Bound**: Maximum theoretical loss upon unannounced power cut is **0.0 seconds of acknowledged/committed data**, and at most **1 batch in flight between mock read and disk flush** ($\le 0.5$ seconds or 200 samples).
- **Physical Rationale**:
  With `PRAGMA synchronous = FULL` in SQLite WAL mode:
  1. Every committed transaction executes an explicit `fsync()` to flush WAL frames to the physical storage device before reporting success.
  2. Operating system page caches and dirty drive buffers for committed transactions are forced to non-volatile flash.
  3. The mock delivers data in chunks of at most 1 second (typically 200 to 400 samples). Because our ingestion transaction flushes immediately upon receiving and validating each chunk before querying the next sensor, uncommitted in-memory data never exceeds one pending read buffer.
  4. Upon reboot, SQLite WAL recovery automatically rolls back any torn or half-written transaction frame, preserving database consistency without index corruption. The collector inspects its durable checkpoint table and issues a reread (`from_index`) for any missing range if the mock buffer still holds it.

---

## 4. Deterministic Signal Processing Engine

Both edge offline mode and cloud online mode execute the identical `@mayacardio/processing` package.

### 4.1 Windowing Model
- One-second windows: Window $w$ spans sample indexes $[400w, 400w + 399]$ for both sensors.
- Completeness:
  $$\text{complete} = (\text{missing\_1} == 0) \land (\text{missing\_2} == 0)$$

### 4.2 Descriptive Statistics & Magnitude
- **Mean, Min, Max**: Computed across available samples for each channel independently. If count $= 0$, all three are `null`.
- **Magnitude** (Sensor 2):
  $$\text{magnitude} = \frac{1}{K} \sum_{k=1}^{K} \sqrt{\text{ch1}_k^2 + \text{ch2}_k^2}$$
  over all $K$ available Sensor 2 samples in window $w$. If $K = 0$, `null`.
- All decimal results are rounded to 1 decimal place (`Number(val.toFixed(1))`).

### 4.3 Heart-Rate Detection Specification
Evaluated on **Sensor 1, Channel 2**:
1. **Candidate Peak Criteria**: Sample $i$ is an accepted peak if and only if:
   - All 800 preceding samples ($[i-800, i-1]$) and the subsequent sample ($i+1$) are present and valid.
   - Strict local maximum: $v[i] > v[i-1]$ and $v[i] > v[i+1]$.
   - Dynamic threshold: $v[i] > 0.5 \times \max(v[i-800 \dots i-1])$.
   - Refractory period: $i - \text{last\_peak\_index} \ge 100$ samples.
2. **5-Second Window Evaluation**:
   For window $w$, peaks are selected within interval:
   $$[400(w - 4), 400(w + 1) - 1]$$
   - If $w < 4 \implies \text{heart\_rate} = \text{null}$.
   - If any sample in $[400(w - 4), 400(w + 1) - 1]$ is missing $\implies \text{heart\_rate} = \text{null}$.
   - Let qualifying peaks in this 5-second window be $P = [p_1, p_2, \dots, p_M]$.
   - If $M < 2 \implies \text{heart\_rate} = \text{null}$.
   - Consecutive peak sample differences: $g_k = p_{k+1} - p_k$ (in samples).
   - Mean gap in seconds: $\bar{G}_{\text{sec}} = \frac{1}{(M-1) \cdot 400} \sum_{k=1}^{M-1} g_k$.
   - Heart rate:
     $$\text{heart\_rate} = \frac{60}{\bar{G}_{\text{sec}}} = \frac{24000}{\frac{1}{M-1} \sum g_k}$$
   - Rounded to 1 decimal place.

---

## 5. Automatic Mode Switching & Reconciliation

### 5.1 Tri-State Mode Controller
- **ONLINE**: Network healthy, Cloud API responding to health probes (HTTP ping $\le 1000$ ms). Live batches are pushed directly to cloud ingestion; cloud computes and persists window results within 5 seconds.
- **OFFLINE**: Network partitioned or Cloud API unreachable after 3 consecutive failed attempts / timeouts. Device switches within $\le 10$ seconds. Device triggers local offline processing worker for all completed windows.
- **RECOVERING**: Network restored. Dual-stream execution:
  1. High-priority stream: Live incoming data streams to cloud without interruption.
  2. Background catch-up stream: Backlog reconciliation queries missing ranges, uploads unacknowledged samples in chunked batches (500–1000 samples) with backpressure.
  3. Once cloud acknowledges identical sample coverage and loss ledger alignment, state returns to ONLINE.

### 5.2 Catch-Up Timing Bounds
- Maximum 2-hour outage $= 2 \times 3600 \times 400 = 2,880,000$ samples per sensor ($\approx 5.76$M samples total).
- Transmission requirement: catch up within 15 minutes ($900$ seconds).
- Required throughput: $\frac{5,760,000}{900} = 6,400$ samples/sec.
- In compressed binary or NDJSON batches of 2,000 samples ($\approx 40$ KB/batch), this is only $\approx 3.2$ requests/sec ($\approx 128$ KB/sec bandwidth), effortlessly handled within Fastify and PostgreSQL transaction limits on standard WiFi/LAN.

---

## 6. Required CLI Interface

A single executable entry point `pipeline` on the device:

1. `pipeline status`:
   Emits exactly one JSON line on stdout:
   ```json
   {"mode":"online","samples_saved":124800,"samples_in_cloud":124800,"backlog":0}
   ```
2. `pipeline export --session ID --from [device|cloud]`:
   Streams JSON lines on stdout:
   - First, every stored sample:
     `{"sensor": 1, "index": 120000, "values": [720, 1200, 1560]}`
   - Then, every loss record:
     `{"sensor": 2, "from_index": 4000, "to_index": 4399, "reason": "buffer_overflow"}`
     (If open-ended: `"to_index": null`)
3. `pipeline results --session ID`:
   Streams one JSON line per window on stdout containing the section 3 outputs.
