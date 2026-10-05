// Pure-logic tests: give the config module harmless values so importing it never needs real services.
process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
process.env.SESSION_SECRET ||= "test-session-secret-test-session-secret";
process.env.ANTHROPIC_API_KEY ||= "test";
process.env.AGENTMAIL_API_KEY ||= "test";
process.env.PUBLIC_URL ||= "https://badger.test";
process.env.SLACK_SIGNING_SECRET ||= "slack-test-secret";
process.env.SLACK_BOT_TOKEN ||= "xoxb-test";
process.env.TWILIO_AUTH_TOKEN ||= "twilio-test-token";
process.env.TWILIO_ACCOUNT_SID ||= "ACtest";
process.env.TWILIO_WHATSAPP_FROM ||= "whatsapp:+14155238886";
process.env.TELEGRAM_BOT_TOKEN ||= "123:test";
process.env.TELEGRAM_WEBHOOK_SECRET ||= "tg-secret-for-tests";
