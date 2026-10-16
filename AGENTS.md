# MayaCardio — Active Development Rules and Directives

1. **Source of Truth**: Treat the original MayaCardio assessment (`MayaCardio_Software Systems Engg_Candidate_Assessment_Oct_2026.docx` / OCR document) as the primary source of truth.
2. **Language & Environment**: Use Node.js (LTS/compatible) and TypeScript in strict mode for all application code.
3. **No Omissions or Formula Alterations**: Never silently omit a requirement or change a specified formula.
4. **No Fabricated Data or Benchmarks**: Never invent test results, sample values, infrastructure availability, or benchmark measurements.
5. **Verified Test Execution**: Never claim a test passed unless it was actually executed successfully and confirmed in the test runner output.
6. **Data Integrity**: Never silently lose, duplicate, overwrite, or fabricate sensor samples.
7. **Durable Local-First**: Preserve durable local-first collection, explicit checkpoints, atomic writes, and idempotent cloud synchronization.
8. **Shared Deterministic Logic**: Keep cloud and device processing on the same shared deterministic implementation.
9. **Verification Discipline**: Run type checking, linting where configured, and relevant tests after code changes.
10. **Traceability Matrix**: Update `docs/requirements-traceability.md` whenever a requirement's implementation or verification status changes.
11. **Transparency**: Document blockers, environmental constraints, and unresolved edge cases explicitly.
12. **Rigorous Testing**: Never replace failing tests with weaker tests just to achieve a green build.
13. **Resource Constraints**: Keep all device components within Raspberry Pi-class limits (ARM64, at most 4 CPU cores, 2 GB RAM).
14. **Security & Secrets**: Never expose secrets, credentials, or tokens in source code or logs.
15. **Full Execution**: Do not finish by merely describing what should be done. Implement, execute, verify, and document the complete solution.
16. **Pre-Completion Audit**: Before declaring completion, audit the entire assessment against the actual code, documentation, and evidence.
