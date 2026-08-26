# Railway Setup (Phase 1)

Use the same Railway project/environment as EventFlow, but create separate bot data services.

## Services

- `supplier-bot-control` — this repo, build `npm run build`, start `npm run start:control`, public domain enabled, health path `/health`.
- `supplier-bot-worker` — this repo, build `npm run build`, start `npm run start:worker`, no public domain.
- dedicated Redis for the Supplier Bot.
- dedicated MongoDB for the Supplier Bot.

Use Railway private reference variables for Mongo/Redis. For Redis/ioredis the code sets `family: 0` to support Railway's dual-stack private networking.

The Control Centre needs `CONTROL_ADMIN_KEY` and a different `CONTROL_SESSION_SECRET`. Provider/API secrets belong in Railway variables, never GitHub.

Phase 1 does not configure EventFlow ingestion variables.
