# unsupported_adevice

An LTspice `A` special-function device (a Schmitt trigger). ngspice has no
equivalent, so the compatibility layer rejects it with
`UNSUPPORTED_LTSPICE_FEATURE` naming the construct and line rather than running a
silently different circuit (Requirement 15.3). No golden netlist or run: the
rejection in `prepareCompat` is the whole check. Certainty: high.
