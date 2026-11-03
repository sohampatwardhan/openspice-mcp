# dropped_options

An RC low-pass carrying LTspice-specific `.options plotwinsize` and `numdgt`,
which ngspice ignores or names differently. The compatibility layer drops them
with a recorded `.options` translation (Requirement 15.2) rather than failing,
and the transient still settles to `v(out)` ≈ 1 V by 5 ms. Pins the translation
and the settled node value. Certainty: medium (per the design compat table).
