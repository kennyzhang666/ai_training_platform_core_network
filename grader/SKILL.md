# Drill grader skill

This package is the deterministic local grader used by the platform. The
public commands are `check`, `verify`, `measure`, `extract`, `snapshot`, and
`run`.

The `run --full-local` path evaluates hidden tests and static code evidence.
It intentionally leaves `spec` and `collab` unevaluated for human or model
review; those dimensions must not be inferred from keywords in a transcript.
Rubric profiles live in `profiles/` and are versioned with the grader.

Every result contains a canonical snapshot hash. The hash is calculated from
sorted POSIX paths, file content SHA-256 values, and executable bits. Do not
replace it with a client-provided digest.
