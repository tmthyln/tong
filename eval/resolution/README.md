

## Noise

Model calls vary from run to run even at temperature 0. `run … --reps=N` (and
`sweep --reps=N`) runs N replicates of a cell with separate cache keys (`__rK`
run files) and prints mean ± sd; `table` and the report's rows carry
`replicates` on the base run. Coreference `forms` on douluo with glm-5.3-flash:
F1 0.783 ± 0.051 over 3 runs, so differences smaller than about 0.1 between
single runs are not evidence.
