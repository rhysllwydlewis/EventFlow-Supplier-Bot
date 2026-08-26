# Phase 3 safety invariants

Phase 3 is a validation phase, not a publication phase. The production validator must not create supplier listings, send claim notices, send marketing/outreach or enable search-engine indexing.

The validator refuses to advance unless mode is Shadow and all outward-facing switches are off. It counts a fresh run window and automatically drains acquisition when the 100-candidate lower-bound sample is reached.

These controls are deliberately independent of Railway environment variables so runtime operators can pause, drain or emergency-stop the bot without redeploying.
