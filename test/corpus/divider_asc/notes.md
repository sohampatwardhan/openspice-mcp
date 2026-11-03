# divider_asc

An LTspice `.asc` schematic of a resistor divider (V1 = 1 V, R1 = R2 = 1 kΩ) with
an on-sheet `!.op` directive. Exercises the `.asc`-to-netlist converter: wire and
flag connectivity resolves to the golden netlist, the on-sheet directive becomes
`.op`, and the `.op` run gives `v(out)` = 0.5 V. Certainty: high (analytic value;
converter connectivity covered by the unit tests too).
