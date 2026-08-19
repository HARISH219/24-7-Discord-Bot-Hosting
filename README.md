# Lovers Cafe Bot 💬

A Discord bot that displays your server's chat messages on a beautiful website in real-time.

## Features

- 📨 Real-time message relay from Discord to web
- 👤 Shows user avatars and usernames
- 🖼️ Displays images and attachments
- 🎨 Beautiful, responsive design
- ⚡ Lightweight and fast

## Setup Instructions

### 1. Install Dependencies

```bash
npm install
```

### 2. Create Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application" and give it a name
3. Go to "Bot" section and click "Add Bot"
4. Under "Privileged Gateway Intents", enable:
   - Message Content Intent
   - Server Members Intent (optional)
5. Click "Reset Token" and copy your bot token

### 3. Invite Bot to Your Server

1. Go to "OAuth2" → "URL Generator"
2. Select scopes: `bot`
3. Select bot permissions: `Read Messages/View Channels`, `Read Message History`
4. Copy the generated URL and open it in your browser
5. Select your server and authorize

### 4. Get Channel ID

1. Enable Developer Mode in Discord (Settings → Advanced → Developer Mode)
2. Right-click on the channel you want to monitor
3. Click "Copy Channel ID"

### 5. Configure Environment Variables

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

2. Edit `.env` and add your values:
   ```
   DISCORD_TOKEN=your_bot_token_here
   CHANNEL_ID=your_channel_id_here
   PORT=3000
   ```

### 6. Run the Bot

```bash
npm start
```

The bot will start and the website will be available at `http://localhost:3000`

## Free Hosting Options

### Option 1: Railway.app (Recommended)
- ✅ Free tier with 500 hours/month
- ✅ Automatic deployments from GitHub
- ✅ Custom domains
- [Deploy to Railway](https://railway.app)

### Option 2: Render.com
- ✅ Free tier available
- ✅ Auto-deploy from GitHub
- [Deploy to Render](https://render.com)

### Option 3: Fly.io
- ✅ Free tier with 3 apps
- ✅ Good performance
- [Deploy to Fly.io](https://fly.io)

### Option 4: Glitch.com
- ✅ Simple setup
- ✅ Live coding environment
- [Deploy to Glitch](https://glitch.com)

## Deployment Steps (Railway Example)

1. Push your code to GitHub
2. Sign up on [Railway.app](https://railway.app)
3. Create a new project → "Deploy from GitHub repo"
4. Select your repository
5. Add environment variables in Railway dashboard:
   - `DISCORD_TOKEN`
   - `CHANNEL_ID`
   - `PORT` (Railway provides this automatically)
6. Deploy!

Railway will give you a public URL like `https://your-app.up.railway.app`

## API Endpoints

- `GET /api/messages` - Get recent messages (last 50)
- `GET /api/health` - Bot health check

## Customization

### Change Website Title
Edit `public/index.html` line 6

### Change Color Scheme
Edit `public/style.css` - modify the gradient colors

### Change Message Limit
Edit `index.js` line 9 - modify `MAX_MESSAGES` constant

## Troubleshooting

**Bot not receiving messages?**
- Check if Message Content Intent is enabled in Discord Developer Portal
- Verify the channel ID is correct
- Make sure the bot has permission to read messages in that channel

**Website not loading?**
- Check if the port is already in use
- Make sure you ran `npm install`
- Check console for error messages

## License

MIT License - feel free to modify and use for your projects!
