# resistor_divider

A 1 V source into two equal 1 kΩ resistors. The midpoint `out` sits at exactly
half the source, so the `.op` solution has `v(out)` = 0.5 V. Exercises the parse
stage and the `.op` run under `ngbehavior=lt`, checking the node voltage from the
rawfile. (ngspice does not support `.meas op`, so a `.meas` case uses `.tran`.)

Reference value: analytic (an ideal divider), not an LTspice capture, so the
tolerance is tight (±5 mV) and certainty is high.
