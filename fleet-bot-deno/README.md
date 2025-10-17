# Fleet Reports Bot (Deno Deploy + Telegram)

Free, minimal bot for DM-based fleet reports that mirrors to a group. Includes hourly DM reminders.

## Features
- DM wizard with buttons: `New report`, `Update report`, `Close report`, `Snooze report`.
- Mirrors all actions to a target group.
- Stores state and reports in Deno KV.
- Hourly reminders via Deno Deploy Cron (or manual `/cron?key=CRON_KEY` endpoint).

## Env Vars
- `BOT_TOKEN` — Telegram bot token.
- `GROUP_CHAT_ID` — target group chat ID (e.g., -1001234567890). Use `/setgroup` once in the group to save automatically if omitted.
- `CRON_KEY` — any string. Protects the `/cron` endpoint. Example: `abc123`.

Optional:
- `DEFAULT_REPORTED_BY` — default name used in new reports. Example: `Dan Miller`.

## Deploy
1. Create a new GitHub repo. Upload these files.
2. In Deno Deploy: New Project → Link GitHub → select repo.
3. Set Environment Variables in Deno Deploy:
   - `BOT_TOKEN`
   - `CRON_KEY`
   - optionally `GROUP_CHAT_ID`, `DEFAULT_REPORTED_BY`
4. Configure Cron in Deno Deploy:
   - Add schedule: `0 * * * *` (every hour).
5. Set Telegram webhook:
   - Find your public URL in Deno Deploy, e.g., `https://<your-app>.deno.dev/webhook`.
   - Call once:
     ```bash
     curl -s -X POST https://api.telegram.org/bot$BOT_TOKEN/setWebhook -d "url=https://<your-app>.deno.dev/webhook"
     ```
6. Add the bot to your fleet group and grant it permission to post messages.
7. In the group, send `/setgroup` once to save the chat id if you did not set `GROUP_CHAT_ID`.

## Local dev
```bash
deno run -A main.ts
```

Expose a public URL (e.g., with `cloudflared tunnel`), then set webhook to that URL.

## Notes
- Telegram requires a user to send at least one DM to your bot before the bot can DM them reminders.
- Data model is intentionally simple in KV for free tier.
