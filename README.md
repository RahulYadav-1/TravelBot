# WhatsApp Travel Assistant Bot

A production-ready WhatsApp bot that acts as a travel assistant, powered by Google's Gemini AI. Uses WhatsApp Web automation via `whatsapp-web.js`.

## Features

- Travel assistance via WhatsApp messages
- Location sharing support for nearby recommendations
- Per-user conversation memory (30-minute TTL)
- Rate limiting and message deduplication
- Concurrent request handling with queuing
- Persistent WhatsApp session across restarts
- Health endpoint for monitoring
- Graceful shutdown handling

## Prerequisites

- Node.js 20+
- A WhatsApp account (will be linked as a device)
- Google Gemini API key

## Local Development

### 1. Clone and Install

```bash
git clone <your-repo>
cd whatsapp-travel-bot
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and add your Gemini API key:

```
GEMINI_API_KEY=your_api_key_here
```

### 3. Create Data Directory

```bash
mkdir -p ./data
```

### 4. Run Locally

```bash
# Set data path for local development
DATA_PATH=./data npm start
```

### 5. Scan QR Code

When the bot starts, a QR code will appear in the terminal. Open WhatsApp on your phone:

1. Go to Settings > Linked Devices
2. Tap "Link a Device"
3. Scan the QR code in your terminal

The session will be saved to `./data/.wwebjs_auth` and persist between restarts.

## Railway Deployment

### 1. Create Railway Project

1. Go to [Railway](https://railway.app)
2. Create a new project from your GitHub repository
3. Railway will detect the Dockerfile automatically

### 2. Add Environment Variables

In your Railway project settings, add:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GEMINI_API_KEY` | Yes | - | Your Google Gemini API key |
| `GEMINI_MODEL` | No | `gemini-1.5-flash` | Gemini model to use |
| `AI_CONCURRENCY` | No | `3` | Max concurrent Gemini API calls |
| `USER_COOLDOWN_MS` | No | `2000` | Cooldown between replies (ms) |

### 3. Add Persistent Volume

**Critical**: You must add a persistent volume for WhatsApp session storage.

1. In Railway, go to your service
2. Click "Add Volume"
3. Set mount path: `/app/data`
4. Recommended size: 1GB

Without this volume, you'll need to re-scan the QR code after every deployment.

### 4. Deploy

1. Push to your repository or trigger a manual deploy
2. Open Railway logs to see the QR code
3. Scan with WhatsApp to link the device

### 5. Verify

Check the health endpoint:

```bash
curl https://your-app.railway.app/health
```

Expected response:

```json
{
  "status": "ok",
  "ready": true,
  "uptimeSeconds": 123,
  "timestamp": "2024-01-01T00:00:00.000Z",
  "stats": {
    "activeUsers": 5,
    "dedupeEntries": 42,
    "aiQueue": {
      "pending": 0,
      "size": 0,
      "concurrency": 3
    }
  }
}
```

## Architecture

```
src/
├── index.js           # Main entry point, WhatsApp client, Express server
├── ai/
│   └── gemini.js      # Gemini AI integration with rate limiting
└── util/
    ├── logger.js      # Structured JSON logging
    ├── ttlMap.js      # TTL-based Map for memory/cooldowns
    └── dedupe.js      # Message deduplication
```

## How It Works

1. **Message Reception**: Incoming messages are received via `whatsapp-web.js`
2. **Deduplication**: Messages are checked against a 10-minute TTL cache
3. **Rate Limiting**: Per-user cooldowns prevent rapid-fire abuse
4. **Queue Management**: Concurrent requests to the same user are serialized
5. **Context Building**: User memory (city, location, intent) enriches AI prompts
6. **AI Response**: Gemini generates a travel-focused response
7. **Length Check**: Responses over 1200 chars are summarized
8. **Reply**: Response is sent back via WhatsApp

## Message Types Supported

| Type | Handling |
|------|----------|
| Text | Full travel assistant functionality |
| Location | Acknowledges coordinates, asks for preference |
| Other | Polite message asking for text/location |

## Operational Notes

### Important Risks

This bot uses **unofficial WhatsApp Web automation**. Be aware:

- WhatsApp may update their web client, breaking functionality
- Excessive usage may trigger WhatsApp's anti-automation measures
- Your WhatsApp account could be banned if misused
- This is NOT the official WhatsApp Business API

### Best Practices

- Only respond to inbound messages (no broadcasting)
- Keep rate limits reasonable
- Don't store sensitive user data
- Monitor for WhatsApp client updates
- Keep response times reasonable (< 30 seconds)

## Troubleshooting

### QR Code Keeps Reappearing

**Cause**: Persistent volume not mounted or session corrupted.

**Fix**:
1. Verify volume is mounted at `/app/data`
2. Check Railway volume settings
3. Delete `/app/data/.wwebjs_auth` and re-scan

### Bot Gets Logged Out

**Cause**: WhatsApp session expired or was revoked.

**Fix**:
1. Check "Linked Devices" in WhatsApp - remove old sessions
2. Restart the service
3. Scan the new QR code

### "Ready" is False in Health Check

**Cause**: WhatsApp client not connected.

**Fix**:
1. Check logs for QR code
2. Scan the QR code
3. Verify no network issues
4. Check for WhatsApp client errors in logs

### Responses are Slow

**Cause**: Gemini API latency or queue backup.

**Fix**:
1. Increase `AI_CONCURRENCY` (max ~5)
2. Check Gemini API quota
3. Monitor queue stats in `/health`

### High Memory Usage

**Cause**: Too many cached sessions/deduplication entries.

**Fix**:
1. Memory clears automatically (TTL-based)
2. Restart service if critical
3. Monitor with `/health` endpoint

## Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GEMINI_API_KEY` | Yes | - | Google Gemini API key |
| `GEMINI_MODEL` | No | `gemini-1.5-flash` | Model to use |
| `AI_CONCURRENCY` | No | `3` | Max parallel Gemini calls |
| `USER_COOLDOWN_MS` | No | `2000` | Reply cooldown per user |
| `PORT` | No | `3000` | Health server port |
| `DATA_PATH` | No | `/app/data` | Session storage path |
| `LOG_LEVEL` | No | `info` | Logging level |

## License

MIT
