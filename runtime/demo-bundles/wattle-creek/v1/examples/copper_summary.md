# Copper by sample type

This precomputed example summarizes reported integer Cu values in `assays/surface_samples.csv`. It is an editable example, not an agent run.

| Sample type | Count | Minimum Cu (ppm) | Median Cu (ppm) | Maximum Cu (ppm) |
| --- | ---: | ---: | ---: | ---: |
| Soil | 169 | 35 | 51 | 302 |
| Rock chip | 27 | 35 | 58 | 226 |

Group by the exact `sample_type` text. Read `cu_ppm` as reported integer ppm; sort numerically. For an even count, the median is the arithmetic mean of the two middle values. No substitution or rounding is applied to the median.

Source SHA-256: `593f9b725ba2d7efdb2cbdf9d598111ce1bc7707c8a0f0392226dc35aaf8a3b3`.
Output table: `examples/copper_by_sample_type.csv`.
