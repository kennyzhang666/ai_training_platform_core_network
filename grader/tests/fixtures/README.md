# Golden grader fixtures

These fixtures describe the five local acceptance shapes from Sprint 1–2:

- `reference/`: the published reference implementation (full Verify matrix);
- `defect-basic/`: a deliberately incomplete implementation (partial Verify);
- `magic-number/`: a valid implementation with an auditable C1 finding;
- `missing-entry/`: a contract/entry failure that must remain `PARTIAL`;
- `timeout/`: a non-terminating implementation that must be stopped by the
  Verify timeout.

The reference and hidden-test assets stay under the challenge directory so
the same files are used by CLI, API, and CI tests. This folder only contains
the intentionally small defect variants and the manifest used by the golden
tests.
