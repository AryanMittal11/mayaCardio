# MayaCardio Implementation Progress & Execution Tracker

## Current Phase: PHASE 1 — Inspection, Architecture & Planning

### Milestones Overview
- [x] Workspace inspected and verified clean.
- [x] Original assessment document (`MayaCardio_Software Systems Engg_Candidate_Assessment_Oct_2026.docx`) reviewed across all 5 pages.
- [x] `AGENTS.md` active development rules created and verified in workspace root.
- [x] `docs/requirements-traceability.md` created with all 22 requirement groups mapped.
- [ ] `docs/architecture-and-design.md` detailing architecture, storage guarantees, and recovery model.
- [ ] Phase 2: Monorepo skeleton, TypeScript config, schema migrations, and test harness.
- [ ] Phase 3: Sensor collector, CRC-32 verification, WAL SQLite durable storage, loss tracking.
- [ ] Phase 4: Shared deterministic signal-processing engine (statistics, magnitude, exact HR peak detector).
- [ ] Phase 5: Fastify Cloud API, PostgreSQL idempotent storage, chunked batch sync.
- [ ] Phase 6: Tri-state state machine (ONLINE, OFFLINE, RECOVERING), backpressure, catch-up reconciliation.
- [ ] Phase 7: Unified CLI (`pipeline status`, `pipeline export`, `pipeline results`).
- [ ] Phase 8: Comprehensive failure-injection and ground-truth validation suite.
- [ ] Phase 9: ARM64 resource benchmarking, deliverables audit, design note, and demo script.

### Known Environment & Tooling Notes
1. Target architecture is ARM64 Linux (Raspberry Pi 4 / 2GB RAM / 4 cores), development running on Windows Node.js v24.11.1. All code will be cross-platform Node.js TypeScript with explicit Linux ARM64 validation scripts and container definitions.
2. The mock binary (`biosignal-mock`) and ground truth tool (`check_ground_truth`) download links were omitted in the assessment specification (`Download: __ (ARM64 and x86-64)`). To guarantee rigorous, unblocked verification without inventing non-existent external URLs, we provide a 100% specification-faithful TypeScript reference implementation of `biosignal-mock` and `check_ground_truth` matching every parameter (`--mode signal`, `--mode ramp`, `--seed`, `--duration`, `--port`, single client TCP, NDJSON framing, CRC-32 checksums, 10-second ring buffer, and fault injection hooks).
