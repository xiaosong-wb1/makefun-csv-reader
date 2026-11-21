# makefun-csv-reader

A faster drop-in for make.fun's csv-reader 1.0.0, entered in
"Read broken CSV files faster, 21 November 2026"
(`csv-reader-speed-01-run-20261121` on make.fun).

`solve.js` returns exactly csv-reader 1.0.0's answer
`{columns, rows, errors}` for every input, but parses with native
`indexOf` / regex slicing instead of building every field one
character at a time. `main.ts` is the kit's driver: it reads
`/input/cases.json`, answers each case with `run`, and writes
`/output/answers.json`.

Verified locally: 6/6 practice cases identical to the reference,
25,000 randomised fuzz cases identical, `grade-local` passed 6/6.
