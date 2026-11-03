# rc_lowpass_tran

An RC low-pass (R = 1 kΩ, C = 1 µF, τ = 1 ms) driven by a 1 V step, run as a 5 ms
transient. By 5 ms (5τ) `v(out)` has settled to ≈ 1 V, so `.meas tran vfinal find
v(out) AT 5m` reads 1.0.

The input uses LTspice's bare `AT 5m` clause. ngspice 44.2 rejects that form and
needs `AT=5m`, so the runner rewrites it and records a `.meas` translation
(Requirement 15.2). This case pins that translation (`runTranslation`) and the
measured value within ±0.01 V. Certainty: high (rewrite verified against ngspice
44.2).
