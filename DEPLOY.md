# Deploying the bot for free, 24/7 (Render)

The bot needs to run all the time (voice XP is counted minute-by-minute), so it
can't live on your PC for a real event. Render's free tier runs it and gives you
a public URL for the leaderboard UI.

## 1. Put the code on GitHub

Create a new **private** repo at https://github.com/new (e.g. `lovers-cafe-bot`).
Then, in this folder:

```bash
git remote add origin https://github.com/<your-username>/lovers-cafe-bot.git
git push -u origin main
```

(Your `.env` is git-ignored, so your bot token is NOT uploaded — good.)

## 2. Create the Render service

1. Sign up at https://render.com (free, no credit card).
2. **New → Web Service → Build and deploy from a Git repo** → pick your repo.
3. Render reads `render.yaml` automatically. If asked, set:
   - Build command: `npm install`
   - Start command: `npm start`
   - Plan: **Free**
4. Add **Environment Variables** (from your local `.env`):
   - `DISCORD_TOKEN` — your bot token
   - `CHANNEL_ID` — the channel to relay (optional)
   - `XP_RESET_USER_IDS` — e.g. `359747431036092417`
   - `XP_ROLE_ID` — only if you want XP limited to one role
5. **Create Web Service.** After it builds, you get a URL like
   `https://lovers-cafe-bot.onrender.com` → that's your **leaderboard page**.

## 3. Keep it awake (important on the free plan)

Render's free web services sleep after ~15 min idle. Keep it up with a free pinger:

1. Sign up at https://uptimerobot.com (free).
2. **Add New Monitor → HTTP(s)**.
3. URL: `https://<your-app>.onrender.com/api/health`
4. Interval: **5 minutes**. Save.

## ⚠️ XP persistence (read this for a real event)

Render's free disk is **ephemeral** — `xp-data.json` is wiped on every redeploy
and can reset when the instance restarts. For a short one-day event that's often
fine (don't redeploy mid-event). For a multi-day event, add a free database so XP
survives restarts — ask and this can be switched to **Upstash Redis** (free, just
a URL + token) without changing how the bot behaves.
