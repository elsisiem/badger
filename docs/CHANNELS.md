# Chat apps: text Badger from Telegram, Slack or WhatsApp

Badger works the same in every chat app. Once a chat is linked to your account you can:

| Say | What happens |
|---|---|
| `Sam had a lesson today, $45` | Logs a charge on Sam's running balance (and confirms the new total) |
| `Lee paid` / `Lee paid 30` | Marks everything (or the oldest $30) paid. Badger stops reminding Lee once the balance is zero |
| `who owes me?` | Answers straight from the ledger |
| `status` | Your open cases |
| `Add Priya, priya@example.com to Piano students` | Adds a person |
| `APPROVE` / `SKIP` (or `approve 2`) | Answers the draft Badger is waiting on |

Badger also messages **you** when it needs a decision: a draft to approve, a reply that needs your answer, a "they say it's paid, confirm?". On Telegram those arrive with **Approve / Skip buttons**.

Each channel turns on only when its credentials are set on the server. With none set, the **Chat apps** page shows them as "not set up" and everything else keeps working.

## Linking a chat to your account

1. Sign in to Badger, open **Chat apps**, press **Connect** on the app you want.
2. You get a one-time code (valid 10 minutes). Send it to Badger from the chat: `/start CODE` on Telegram, or `link CODE` on Slack/WhatsApp.
3. Badger replies "Connected". Done. **Disconnect** removes the link.

Only a code generated while you are signed in can link a chat, so nobody can attach their chat to your account.

## Telegram (about 2 minutes)

1. In Telegram, message **@BotFather**, send `/newbot`, pick a name and a username. It gives you a token like `123456:ABC...`.
2. Set it on the server: `fly secrets set TELEGRAM_BOT_TOKEN=<token> -a badger-nags`
3. That's it. On boot Badger reads the bot's username and registers its own webhook (with a secret header, so only Telegram can call it).

## Slack (about 5 minutes)

1. Go to https://api.slack.com/apps, **Create New App**, **From a manifest**, and paste [`slack-app-manifest.json`](slack-app-manifest.json). Change the request URL if your server is not `badger-nags.fly.dev`.
2. **Install to Workspace.** Copy the **Bot User OAuth Token** (`xoxb-...`) and, from *Basic Information*, the **Signing Secret**.
3. `fly secrets set SLACK_BOT_TOKEN=xoxb-... SLACK_SIGNING_SECRET=... -a badger-nags`
4. In Slack, open a DM with **Badger** (Apps section) and use **Chat apps** in Badger to get a code.

Requests are verified with Slack's signature scheme (HMAC-SHA256 over `v0:timestamp:body`, five-minute replay window).

## WhatsApp (via Twilio, about 5 minutes)

1. In the Twilio console open **Messaging > Try it out > Send a WhatsApp message** and join the sandbox from your phone with the join phrase it shows.
2. In **Sandbox settings** set *When a message comes in* to `https://badger-nags.fly.dev/api/channels/whatsapp` (HTTP POST).
3. `fly secrets set TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=... TWILIO_WHATSAPP_FROM=whatsapp:+14155238886 -a badger-nags`
4. Use **Chat apps** in Badger to get a code and send `link CODE` to the sandbox number.

Requests are verified with Twilio's signature (HMAC-SHA1 over the URL and sorted form fields).

**WhatsApp limit:** WhatsApp only lets a business message you first inside 24 hours of your last message, unless you use pre-approved templates. In the sandbox that means Badger's approval prompts reach you while you've recently chatted. A production setup would register message templates with Meta.

## Privacy and safety notes

- Badger keeps only the last 10 messages of each chat so it can follow a conversation.
- Chat apps can log charges and mark payments. They **cannot** turn on auto-send for a roster; that standing approval is only available in the app, on purpose.
- Anything that contacts a third party (emails, forms) still follows the same approval rules as in the web app.
