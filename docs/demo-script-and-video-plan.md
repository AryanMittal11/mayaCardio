# MayaCardio — Demo Script and Video Recording Plan (§4, §5 #5)

A concise, step-by-step recording plan for a **5-minute video demonstration** validating the three required fault injection scenarios on a Raspberry Pi 4 environment:
1. **Network Cut & Automatic Restoration**
2. **Process Termination (SIGKILL)**
3. **Sudden Power Cut & Reboot Recovery**

---

## Video Timeline Summary (Total Duration: 4 minutes 45 seconds)

| Timestamp | Phase | Visual / Action | Key Narration Points |
|---|---|---|---|
| **00:00 – 00:45** | System Architecture & Live Startup | Start mock, launch cloud API, start bedside pipeline daemon. Run `pipeline status`. | Introduce bedside scenario, continuous 400 Hz collection, zero-loss guarantee, WAL durability. |
| **00:45 – 02:00** | **Test 1: Network Cut & Recovery** | Disconnect ethernet / Wi-Fi (`ip link set eth0 down` or pause cloud). Observe CLI status transition. | Show mode changing to `OFFLINE` within 5s (limit <=10s). Local storage accumulates samples. Offline processor runs. Restore network. Mode moves to `RECOVERING` then `ONLINE`. Run `pipeline status` showing backlog = 0. |
| **02:00 – 03:15** | **Test 2: Process Crash (`kill -9`)** | Run `killall -9 node` while streaming. Check status. Restart daemon. | Show process killed mid-collection. No database corruption. SQLite WAL auto-recovers. Checkpoints resume with zero gap. |
| **03:15 – 04:15** | **Test 3: Sudden Power Cut** | Pull physical power cable from Raspberry Pi while streaming. Reconnect power and boot. | Explain SQLite `synchronous=FULL` flushing every committed transaction to non-volatile flash. Run `check_ground_truth` showing 0 silent loss. |
| **04:15 – 04:45** | Verification & Wrap-up | Run `pipeline export` and verify results match ground truth. Conclude. | Highlight compliance with all 8 completion criteria. |

---

## Detailed Step-by-Step Operator Commands

### Step 1: Baseline Launch
Terminal 1 (Mock):
```bash
npm run mock:signal
```

Terminal 2 (Cloud Backend):
```bash
npm run cloud
```

Terminal 3 (Bedside Device):
```bash
npm run device
```

Terminal 4 (CLI Inspector):
```bash
npx tsx packages/cli/src/bin.ts status
```
*Expected Output*:
`{"mode":"online","samples_saved":3200,"samples_in_cloud":3200,"backlog":0}`

---

### Step 2: Fault 1 — Network Cut
1. In Terminal 2, stop cloud API (`Ctrl+C`) or disable interface:
   ```bash
   sudo ip link set eth0 down
   ```
2. In Terminal 4, inspect status after 3 seconds:
   ```bash
   npx tsx packages/cli/src/bin.ts status
   ```
   *Expected Output*:
   `{"mode":"offline","samples_saved":8400,"samples_in_cloud":3200,"backlog":5200}`
3. Restore network:
   ```bash
   sudo ip link set eth0 up  # (or restart cloud in Terminal 2)
   ```
4. Watch status within 10 seconds:
   `{"mode":"recovering", ...}` -> `{"mode":"online","samples_saved":12400,"samples_in_cloud":12400,"backlog":0}`

---

### Step 3: Fault 2 — Process Kill (`kill -9`)
1. While streaming live, forcibly terminate the bedside daemon:
   ```bash
   kill -9 $(pgrep -f "device-daemon")
   ```
2. Restart the daemon:
   ```bash
   npm run device
   ```
3. Verify WAL recovery:
   ```bash
   npx tsx packages/cli/src/bin.ts status
   ```
   Database opens cleanly, checkpoints are intact, and streaming resumes immediately.

---

### Step 4: Fault 3 — Physical Power Pull
1. Unplug the 5V power supply from the Raspberry Pi 4.
2. Wait 5 seconds. Reconnect power supply and allow OS to boot.
3. SSH into board and run the ground truth checker:
   ```bash
   npx tsx packages/cli/src/bin.ts export --session <SESSION_ID> --from device > export.ndjson
   npx tsx packages/mock-service/src/ground-truth-bin.ts export.ndjson --mode signal
   ```
4. Output confirms:
   `PASS: Verified samples with zero unaccounted loss, zero corruption, zero duplicates.`
