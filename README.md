# MayaCardio — "Never Lose a Heartbeat"

> A high-resilience, edge-to-cloud biosignal data pipeline engineered for bedside medical devices operating in hospital environments prone to network loss, unexpected reboots, and sudden power cuts.

Conforms strictly to the **MayaCardio Software Systems Engineering Candidate Assessment (Oct 2026)**.

---

## Key Highlights & Architectural Guarantees

- **Zero Silent Data Loss**: Every sample received is persisted to non-volatile disk or formally recorded in the loss ledger with an explicit reason code.
- **Zero Fabrication / Interpolation**: Sensor gaps are never filled with invented, synthetic, or interpolated values.
- **Strict CRC-32 Validation**: Standard zlib CRC-32 (polynomial `0xEDB88320`) is evaluated across the raw `data` text (`[` to `]`). Corrupt replies are discarded and immediately re-read.
- **Durable Local-First SQLite**: Uses Write-Ahead Logging (`WAL`) with `PRAGMA synchronous = FULL`. Checkpoints advance atomically with sample insertion.
- **Bounded Power Cut Loss**: Maximum data loss upon sudden unannounced power cut is strictly bounded to at most **one in-flight read batch ($\le 0.5$ seconds / 200 samples)**, and **0.0 seconds of committed data**.
- **Deterministic Parity Across Boundaries**: The edge device and cloud backend share the exact same mathematical processing engine (`@mayacardio/processing`).
- **Resilient Mode Switching**: Detects actual cloud service reachability and transitions between `ONLINE`, `OFFLINE`, and `RECOVERING` within $\le 10$ seconds without sample duplication or omission.
- **Resource Discipline**: Peak memory remains **< 125 MB** (well below the 2.0 GB limit), and average CPU load remains **< 20%** on 4-core ARM64 processors.

---

## Architecture

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

---

## Installation & Setup on a Fresh Board (Raspberry Pi 4)

### 1. Prerequisites
- Raspberry Pi OS (64-bit Linux / ARM64) or compatible x86-64 Linux/macOS/Windows.
- Node.js LTS (v20+ or v22+ or v24+).
- Git.

```bash
# On Debian/Ubuntu/Raspberry Pi OS:
sudo apt update && sudo apt install -y git curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

### 2. Clone & Install Dependencies
```bash
git clone https://github.com/aryanmittal/mayacardio.git
cd mayacardio
npm install
```

### 3. Build & Typecheck
```bash
npm run build
npm run typecheck
```

---

## Running the Pipeline

### Option 1: Complete Automated Demo Run

Open 3 separate terminals:

**Terminal 1 — Mock Biosensor Service**:
```bash
# Runs the synthetic biosignal generator (ECG + Slow Variation or Ramp mode)
npm run mock:signal
# Or for deterministic formula verification:
# npm run mock:ramp
```

**Terminal 2 — Cloud Backend API**:
```bash
# Starts Fastify cloud API on port 8080 with zero-config embedded storage
npm run cloud
```

**Terminal 3 — Bedside Device Daemon**:
```bash
# Starts the continuous collector, state-machine, and synchronization worker
npm run device
```

---

## Required CLI Commands

A single unified binary `pipeline` is provided on the device:

### 1. Pipeline Status
Prints one JSON line on stdout with the current operational state:
```bash
npm run pipeline -- status
```
*Output*:
```json
{"mode":"online","samples_saved":124800,"samples_in_cloud":124800,"backlog":0}
```

### 2. Pipeline Export (Device or Cloud)
Streams data as JSON Lines: first every collected sample, then every recorded loss:
```bash
# Export from local device disk:
npm run pipeline -- export --session <SESSION_ID> --from device > device_export.ndjson

# Export from cloud copy:
npm run pipeline -- export --session <SESSION_ID> --from cloud > cloud_export.ndjson
```
*Output stream*:
```json
{"sensor": 1, "index": 120000, "values": [720, 1200, 1560]}
{"sensor": 1, "index": 120001, "values": [708, 1180, 1534]}
...
{"sensor": 2, "from_index": 4000, "to_index": 4399, "reason": "buffer_overflow"}
```

### 3. Pipeline Results
Prints one JSON line per 1-second window and processing mode with Section 3 outputs:
```bash
npm run pipeline -- results --session <SESSION_ID>
```
*Output*:
```json
{"session_id":"5f0c2a9e","window":0,"missing_1":0,"missing_2":0,"complete":true,"s1_ch1_mean":720.0,"s1_ch1_min":708,"s1_ch1_max":726,"s1_ch2_mean":1200.0,"s1_ch2_min":1180,"s1_ch2_max":1210,"s1_ch3_mean":1560.0,"s1_ch3_min":1534,"s1_ch3_max":1573,"s2_ch1_mean":400000.0,"s2_ch1_min":399990,"s2_ch1_max":400010,"s2_ch2_mean":150000.0,"s2_ch2_min":149980,"s2_ch2_max":150020,"magnitude":427200.2,"heart_rate":60.0,"mode":"online"}
```

---

## Automated Ground-Truth Verification

Verify that an export strictly matches ground truth with zero silent loss, zero duplicates, and zero corruption:
```bash
npx tsx packages/mock-service/src/ground-truth-bin.ts device_export.ndjson --mode ramp --seed 7
```
*Output*:
```
PASS: Verified 124800 samples with 0 loss records. Zero unaccounted loss, zero corruption, zero duplicates.
```

---

## Running the Automated Test Suite

Run all 45 automated unit, integration, and failure injection tests:
```bash
npm test
```

### Test Suites Overview:
- `tests/shared-crc.test.ts`: Verifies exact CRC-32 against Section 5 assessment text.
- `tests/processing.test.ts`: Validates windowing, per-channel stats, magnitude, and exact 4-rule HR peak detector.
- `tests/mock-service.test.ts`: Verifies NDJSON TCP mock, ring buffer eviction, single-client locking, and ground truth tool.
- `tests/device-storage.test.ts`: Validates SQLite WAL durability, synchronous=FULL, atomic writes, and duplicate handling.
- `tests/collector.test.ts`: Validates sequential polling, CRC mismatch rejection, and mock restart recovery.
- `tests/cloud-api.test.ts`: Validates Fastify API, token auth, idempotent batch ingestion, online window processing (<5s), and streaming exports.
- `tests/sync-and-switching.test.ts`: Validates automatic mode switching, offline device processing, and backlog reconciliation.
- `tests/cli.test.ts`: Validates CLI status, export, and results formats.
- `tests/failure-injection.test.ts`: Validates end-to-end failure injection (process kill, network cut/recovery, 2-hour outage catchup).

---

## Deliverables & Documentation Index

All assessment deliverables are organized within the repository:

1. **[Requirements Traceability Matrix](docs/requirements-traceability.md)**: Every requirement, source section, implementation location, verification command, and test status.
2. **[Architecture and System Design Document](docs/architecture-and-design.md)**: Complete technical specification of device and cloud tiers.
3. **[Design Note (2 Pages)](docs/design-note.md)**: Formal 2-page brief covering architecture, guarantees, and power-cut data loss bound.
4. **[Failure Test Execution Evidence](docs/failure-test-evidence.md)**: Detailed test logs and results for all failure injection scenarios.
5. **[ARM64 Resource Report](docs/arm64-resource-report.md)**: Resource benchmark measurements on ARM64 (CPU, RSS memory, disk written, network traffic).
6. **[Free Cloud Deployment Guide](docs/cloud-deployment.md)**: Step-by-step instructions for deploying to free cloud tiers (Render, Fly.io, Supabase).
7. **[AI Tools Disclosure](docs/ai-disclosure.md)**: Full transparent disclosure of AI tools utilized during development.
