# Review verification evaluation

The cases in `cases.json` are small, handwritten reproductions of failure modes
observed in historical reviews, with PR links and reviewed SHAs for provenance.
They are **not exact PR snapshots** or a representative production benchmark.
The real repository files and full private PR discussions are not bundled.
The synthetic null-dereference positive control checks that rejecting false alarms
does not turn the verifier into an unconditional rejector.

Run `npm run eval` for deterministic filtering only. Findings that require model
judgment are explicitly labeled as such; this command does not claim an accuracy score.

For live verification replay, set `EVAL_API_KEY`, `EVAL_API_BASE` and `EVAL_MODEL`
in your environment and run:

```sh
npm run eval:live
```

This sends the minimized fixtures to the configured provider and incurs API usage.
The runner reports expected/actual verdicts, severity and failures; it exits nonzero
on a mismatched verdict, severity inflation, invalid evidence or API failure.
Run the same case file against each model/version and retain the JSON output.
Do not treat acceptance of a developer suggestion as proof that its original claim
or severity was correct.

Before production rollout, separately replay representative full PR snapshots and
measure: actionable-finding precision, unsupported high-severity rate, duplicate
comments, incomplete coverage, time before merge, and token usage. Recall requires
an independently labeled set of real defects. No live improvement claim follows
from passing unit tests or these seven diagnostic examples alone.
