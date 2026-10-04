// Pure-logic tests: give the config module harmless values so importing it never needs real services.
process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
process.env.SESSION_SECRET ||= "test-session-secret-test-session-secret";
process.env.ANTHROPIC_API_KEY ||= "test";
process.env.AGENTMAIL_API_KEY ||= "test";
process.env.PUBLIC_URL ||= "https://badger.test";
