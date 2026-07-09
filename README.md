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

## Always-on hosting (free)

To run 24/7 without your own computer, deploy to a free cloud VM:

- **Oracle Cloud (recommended)** — most generous free tier (ARM, up to 4 cores / 24 GB): [deploy/DEPLOY-ORACLE.md](deploy/DEPLOY-ORACLE.md)
- **Google Cloud** — free e2-micro: [deploy/DEPLOY-GCP.md](deploy/DEPLOY-GCP.md)
- **Any Ubuntu 24.04 box** (home server / mini PC / VM) — Cloudflare Tunnel + custom domain: [deploy/DEPLOY-UBUNTU.md](deploy/DEPLOY-UBUNTU.md)

## Adding family members (invite code)

The first account is created on first run. After that, new people can create
their own account **only if you set a shared invite code** — otherwise signup is
off (so a public URL can't be used by strangers).

1. Put a code in `.env`: `SIGNUP_CODE=some-family-word`
2. Restart the app.
3. Tell the person: open the URL → **Add person** → their name + a PIN they pick
   + the invite code → they're in (auto signed-in). No password sharing.

Leave `SIGNUP_CODE` unset to keep signup disabled.

## Human-like send timing (jitter)

By default a scheduled message fires at the exact set time. To make sends look
manual, set a jitter window in `.env`:

```
JITTER_MINUTES=3
```

Each send then goes out at a random time within **± that many minutes** of the
scheduled time (e.g. `3` → anywhere from 3 min early to 3 min late, different
each time). Unset or `0` = exact time, no jitter. For short repeat intervals the
jitter is automatically capped to under half the interval so messages can't
overlap or arrive out of order. Restart after changing it.

## Locked out? (too many wrong PINs)

After 5 wrong PINs an account locks for 30 minutes (brute-force protection, and
it survives restarts). To clear it immediately, on the server:

```
npm run unlock        # clear all accounts
npm run unlock 2      # clear just user id 2
```

## Autostart on your own computer (runs on login)

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
