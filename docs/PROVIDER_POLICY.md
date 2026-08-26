# Discovery Provider Policy

Discovery providers are pluggable and capability-gated. A provider adapter must declare whether its terms/configuration permit persistent result storage and other relevant uses before those capabilities can be enabled in production.

Brave Search is supported as a discovery adapter, but persistent production use remains gated unless the configured plan/permission permits retention. Provider search responses are not treated as the canonical supplier profile source; the supplier's own public website is researched independently after discovery.
