# WhatsApp Scheduler

Send scheduled WhatsApp messages to family and friends.

## Quick Start

1. Install: `npm install`
2. Start: `npm start`
3. Open: http://localhost:3000
4. Scan QR code on the Dashboard with your WhatsApp

## Access from a phone (Cloudflare Tunnel)

Let your father open the app from his phone, anywhere, over HTTPS.

1. Install cloudflared (one time):
   - macOS: `brew install cloudflared`
   - Windows: `winget install --id Cloudflare.cloudflared`
2. Run:
   ```
   npm run share
   ```
3. It prints a public URL like `https://something.trycloudflare.com`.
   Open it on the phone and bookmark it.

The computer running `npm run share` must stay on. `npm run share` also
auto-generates a secure `SESSION_SECRET` in `.env` on first run.

### Permanent URL (optional)

The free `trycloudflare.com` URL changes every restart. For a URL that never
changes, create a named tunnel with a Cloudflare account + domain:
https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/

## Autostart (runs on login)

```
npm run setup-autostart
```

## Usage

1. **Contacts**: Add phone numbers of people to send to
2. **Templates**: Write your messages (use {{name}}, {{date}}, {{day}}, {{time}})
3. **Schedules**: Set who gets what message and when
4. **History**: See all sent messages

## Requirements

- Node.js 20+
- macOS or Windows
