# Judge calibration results (LOT-105)

Human scores collected 2026-08-13 from the principal (Abhinav Miryala),
blind: drafts presented with model identity withheld and no machine score
visible, via a multiple-choice pass over calibration-worksheet.md. The
human's three criterion scores (tone, completeness, evidence) are averaged
for comparison against the judge's single 0..1 score; verdicts compare
directly. Judge under calibration: the published judge (claude-opus-5,
thinking disabled).

| draft | case | human t/c/e | human mean | human verdict | judge score | judge verdict | abs diff | match |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D01 | INV-022 | 0.7/1.0/1.0 | 0.9 | pass | 0.66 | borderline | 0.24 | NO |
| D02 | INV-023 | 1.0/1.0/1.0 | 1.0 | pass | 0.72 | borderline | 0.28 | NO |
| D03 | INV-024 | 1.0/1.0/1.0 | 1.0 | pass | 0.82 | pass | 0.18 | yes |
| D04 | INV-025 | 1.0/1.0/1.0 | 1.0 | pass | 0.9 | pass | 0.1 | yes |
| D05 | INV-026 | 1.0/1.0/1.0 | 1.0 | pass | 0.83 | pass | 0.17 | yes |
| D06 | INV-027 | 1.0/1.0/1.0 | 1.0 | pass | 0.88 | pass | 0.12 | yes |
| D07 | INV-059 | 1.0/1.0/1.0 | 1.0 | pass | 0.83 | pass | 0.17 | yes |
| D08 | INV-063 | 1.0/1.0/1.0 | 1.0 | pass | 0.82 | pass | 0.18 | yes |
| D09 | INV-065 | 1.0/1.0/1.0 | 1.0 | pass | 0.72 | borderline | 0.28 | NO |
| D10 | INV-066 | 1.0/1.0/1.0 | 1.0 | pass | 0.88 | pass | 0.12 | yes |
| D11 | INV-067 | 1.0/1.0/1.0 | 1.0 | pass | 0.72 | borderline | 0.28 | NO |
| D12 | INV-072 | 1.0/1.0/1.0 | 1.0 | pass | 0.35 | borderline | 0.65 | NO |

**Verdict agreement: 7/12. Mean absolute score difference: 0.2308. Max: 0.65 (D12).**

Direction of disagreement: uniform. In all five disagreements the judge
graded LOWER than the human (pass vs borderline); the judge never scored a
draft above the human's read. The published judge is therefore conservative
relative to the principal's standard: judge-derived quality failures in this
matrix overstate rather than understate problems. The largest gap (D12,
human 1.0/pass vs judge 0.35/borderline) is the one-line GR-SCOPE rejection
note: the human read terseness as fit for purpose on a reject; the judge
penalized it on completeness/evidence grounds.

Caveats: n=12; all drafts in the sample come from the deployed tier's
uncached lane per the selection rule; the human scale was discretized
(1.0/0.7/0.3/0.0) while the judge's is continuous, which inflates small
absolute differences; criterion-mean vs single-score comparison is an
approximation (the judge emits one score, not per-criterion scores).
