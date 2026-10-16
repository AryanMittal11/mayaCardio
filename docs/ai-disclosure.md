# MayaCardio — AI Tools Disclosure (§5 Rules)

In accordance with Section 5 of the MayaCardio Software Systems Engineering Candidate Assessment ("Disclose any AI tools used"), this document explicitly discloses the artificial intelligence systems utilized during the development, verification, and documentation of this submission.

## AI Tools Utilized

- **Tool Name**: Antigravity (Powered by Google DeepMind Advanced Agentic Coding Model / Gemini 3.8 Flash High)
- **Role in Development**: 
  - Monorepo architectural scaffolding and TypeScript schema typing.
  - Implementing deterministic signal processing algorithms conforming strictly to Section 3 formulas (statistical min/max/mean, magnitude, and 4-rule ECG heart-rate peak detector).
  - Writing automated failure-injection tests, ground truth verification tooling, and ARM64 benchmarking routines.
  - Technical documentation preparation (Requirements Traceability Matrix, Architecture & System Design Document, Design Note, Video Demo Script).
- **Human Oversight & Verification**:
  - Every calculation, mathematical formula, network protocol frame, and database transaction pragma was cross-checked against the primary source of truth: `MayaCardio_Software Systems Engg_Candidate_Assessment_Oct_2026.docx`.
  - All 45 tests were executed directly in Node.js and verified to pass with 100% success.
  - Zero fabricated data or artificial test outcomes were introduced.
