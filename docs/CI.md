# Continuous Integration

GitHub Actions runs on Node 22 and executes lint, typecheck, unit tests and the production TypeScript build for pull requests and `main` pushes.

Railway deployment should later be configured to wait for successful GitHub CI before deploying production services.
