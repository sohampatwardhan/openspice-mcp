# stepped_divider

A 1 V source into R1 (swept) and a fixed 1 kΩ R2. The deck carries a `.step R1
500 1500 500` device sweep, which LTspice runs natively but ngspice does not:
ngspice 44.2 rejects a bare `.step` with `unimplemented dot command '.step'`,
even under `ngbehavior=lt` (see docs/compatibility.md). The runner therefore
emulates it with a `.control` loop (`foreach`/`alter`/`write` + `set
appendwrite`) and assembles the concatenated rawfile sections into one result per
step (Requirement 6.3, 7.3).

The sweep visits R1 = 500, 1000, 1500 Ω, so the `.op` node `v(out) =
1000/(R1+1000)` is 0.6667, 0.5, 0.4 V across the three steps. The corpus runner
keys `result.raw` to the first step, so this case pins the first-step value
(`v(out)` = 2/3 V, ±5 mV). That the run completes at all is the proof the `.step`
emulation path works end to end against the real engine — a bare `.step` would
fail. Certainty: high (analytic divider; emulation verified against ngspice
44.2).
