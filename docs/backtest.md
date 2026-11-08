# Back-test: priority scorecard at t0 = 2026-10-08

**Cohort**: every loan in 1-30 DPD at the t0 snapshot (n = 136); outcome = rolled to 31+ DPD by the end snapshot 2026-11-07 (actual roll rate 22.8%).
**Inputs at t0 only**: DPD and outstanding from the t0 snapshot, promises and contact events strictly before t0, static loan attributes. The t0 overdue amount is not in the snapshot — that feature imputed the portfolio mean for 136 of 136 loans (limited data), stated plainly.
**Model**: the committed scorecard (model scorecard-v1-priors) with the committed standardisation params (fitted at the end date — portfolio means/SDs, not outcome-derived). The weights are the SPEC's expert priors and were **not** tuned against this result.
**Split**: time-based (t0 history vs the fixed +30-day outcome window). No random split.

| scorer | AUC | Gini | KS | Brier |
| --- | --- | --- | --- | --- |
| Scorecard | 0.613 (95% bootstrap CI 0.504–0.720) | 0.226 | 0.222 | 0.179 |
| Baseline: DPD descending | 0.436 | -0.129 | 0.161 | n/a (rank score, not a probability) |
| Baseline: outstanding descending | 0.433 | -0.135 | 0.169 | n/a (rank score, not a probability) |

**The honest value-add is the delta over the DPD baseline: ΔAUC = 0.178.**

The data is synthetic, so this proves the pipeline works, not real-world accuracy.

## Decile table — scorecard

| decile | n | mean predicted | actual roll rate | lift | cumulative rolls captured |
| --- | --- | --- | --- | --- | --- |
| 1 | 13 | 30.6% | 38.5% | 1.69x | 16.1% |
| 2 | 14 | 20.4% | 28.6% | 1.25x | 29.0% |
| 3 | 13 | 16.9% | 15.4% | 0.67x | 35.5% |
| 4 | 14 | 14.3% | 21.4% | 0.94x | 45.2% |
| 5 | 14 | 12.2% | 35.7% | 1.57x | 61.3% |
| 6 | 13 | 9.8% | 30.8% | 1.35x | 74.2% |
| 7 | 14 | 8.1% | 14.3% | 0.63x | 80.6% |
| 8 | 13 | 6.9% | 15.4% | 0.67x | 87.1% |
| 9 | 14 | 5.4% | 21.4% | 0.94x | 96.8% |
| 10 | 14 | 3.5% | 7.1% | 0.31x | 100.0% |

## Decile table — DPD baseline

| decile | n | mean DPD in decile | actual roll rate | lift | cumulative rolls captured |
| --- | --- | --- | --- | --- | --- |
| 1 | 13 | 28.6 | 15.4% | 0.67x | 6.5% |
| 2 | 14 | 25.6 | 14.3% | 0.63x | 12.9% |
| 3 | 13 | 22.8 | 23.1% | 1.01x | 22.6% |
| 4 | 14 | 19.5 | 14.3% | 0.63x | 29.0% |
| 5 | 14 | 16.7 | 21.4% | 0.94x | 38.7% |
| 6 | 13 | 14.8 | 30.8% | 1.35x | 51.6% |
| 7 | 14 | 12.4 | 28.6% | 1.25x | 64.5% |
| 8 | 13 | 8.6 | 38.5% | 1.69x | 80.6% |
| 9 | 14 | 5.2 | 28.6% | 1.25x | 93.5% |
| 10 | 14 | 1.9 | 14.3% | 0.63x | 100.0% |

## Calibration (scorecard, by predicted decile)

Mean predicted vs actual roll rate per decile — the first table's "mean predicted" and "actual roll rate" columns are the calibration view; a calibrated model has the two columns close on every row.

## Where the score was wrong

### Top 10 high-score loans that cured (the model over-rated them)

| loan | score | predicted | DPD at t0 | outstanding |
| --- | --- | --- | --- | --- |
| LN-11159 | 35 | 34.8% | 26 | 74270000 |
| LN-11231 | 34 | 34.3% | 16 | 58082500 |
| LN-11201 | 33 | 33.4% | 30 | 68375900 |
| LN-11245 | 24 | 24.5% | 25 | 93320700 |
| LN-11216 | 24 | 24.1% | 29 | 79486100 |
| LN-11135 | 24 | 24.0% | 25 | 106663800 |
| LN-11095 | 22 | 22.5% | 11 | 65071400 |
| LN-11207 | 22 | 22.4% | 19 | 80274600 |
| LN-11161 | 22 | 22.2% | 16 | 72133500 |
| LN-11187 | 22 | 21.8% | 21 | 207570600 |

### Top 10 low-score loans that rolled (the model under-rated them)

| loan | score | predicted | DPD at t0 | outstanding |
| --- | --- | --- | --- | --- |
| LN-11200 | 4 | 4.4% | 8 | 50344600 |
| LN-11179 | 5 | 4.8% | 22 | 43604000 |
| LN-11128 | 5 | 5.1% | 5 | 36105300 |
| LN-11147 | 6 | 5.8% | 14 | 43791000 |
| LN-11250 | 7 | 6.8% | 13 | 22084400 |
| LN-11113 | 7 | 7.2% | 10 | 15802100 |
| LN-11254 | 8 | 7.7% | 23 | 86120500 |
| LN-11153 | 9 | 8.8% | 18 | 60451600 |
| LN-11109 | 9 | 9.3% | 20 | 17419000 |
| LN-11127 | 9 | 9.4% | 6 | 55447300 |
