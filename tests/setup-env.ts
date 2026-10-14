process.env.NODE_ENV = 'test';
process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:27017';
process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
process.env.CONTROL_ADMIN_KEY = 'test-control-admin-key-0000000000';
process.env.CONTROL_SESSION_SECRET = 'test-control-session-secret-0000000000000000';
process.env.OPENAI_API_KEY ??= '';

// Keep the suite hermetic: integration credentials leaking in from the host
// environment must not flip "integration not configured" tests.
delete process.env.EVENTFLOW_INTERNAL_BASE_URL;
delete process.env.EVENTFLOW_BOT_HMAC_SECRET;
delete process.env.EVENTFLOW_OPS_BOT_HMAC_SECRET;
