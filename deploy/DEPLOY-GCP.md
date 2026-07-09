# Deploy on Google Cloud (free e2-micro VM)

Always-on, persistent disk, free forever. The app runs under systemd and is
reached from any phone over HTTPS via Tailscale Funnel (free, stable URL, no
domain required).

Total time: ~30 minutes. You do this once.

---

## 1. Create the free VM

1. Go to <https://console.cloud.google.com> → sign in → create a project.
2. Billing: add a card. The e2-micro in a free-tier region is **not charged**;
   the card is only for identity/verification and to cover anything outside
   Always Free (nothing here goes outside it).
3. **Compute Engine → VM instances → Create instance**. Set exactly:
   - **Region**: `us-central1` (or `us-west1` / `us-east1` — only these are free)
   - **Machine type**: `e2-micro`
   - **Boot disk**: Ubuntu 22.04 LTS, **Standard persistent disk, 30 GB**
     (free-tier limit — do not exceed)
   - Leave firewall boxes unchecked (Tailscale needs no open ports)
4. Create. When it's running, click **SSH** to open a browser terminal.

> Free-tier limits: 1 e2-micro/month in a free region + 30 GB standard disk.
> Stay within these and the bill stays ₹0.

---

## 2. Install Node + build tools + the app

Run these in the SSH terminal:

```bash
# Node 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git build-essential python3   # build-essential needed for better-sqlite3

# Clone the app
cd ~
git clone https://github.com/udbhav-44/WhatsappMe.git
cd WhatsappMe
npm install --omit=dev

# Generate a session secret into .env
node -e "require('fs').writeFileSync('.env','SESSION_SECRET='+require('crypto').randomBytes(48).toString('hex')+'\n')"
```

Quick sanity check (Ctrl+C after you see the running line):

```bash
node src/server.js
```

---

## 3. Run it as a service (starts on boot, restarts on crash)

```bash
# Install the unit, substituting your username automatically
sudo cp deploy/whatsapp-scheduler.service /etc/systemd/system/
sudo sed -i "s/USERNAME/$USER/g" /etc/systemd/system/whatsapp-scheduler.service

sudo systemctl daemon-reload
sudo systemctl enable --now whatsapp-scheduler

# Verify
systemctl status whatsapp-scheduler --no-pager
```

Useful later:
```bash
sudo systemctl restart whatsapp-scheduler   # after code updates
journalctl -u whatsapp-scheduler -f          # live logs (WA connect, sends)
```

---

## 4. Public HTTPS URL with Tailscale Funnel (free, stable, no domain)

```bash
# Install Tailscale
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up            # opens a login link — sign in (Google/GitHub)

# Expose the app publicly over HTTPS
sudo tailscale funnel --bg 3000
tailscale funnel status      # prints your permanent URL
```

You get a fixed URL like `https://<vm-name>.<your-tailnet>.ts.net`. It does not
change across restarts. Open it on any phone/browser, bookmark it, share with
your father. HTTPS is automatic.

> Prefer a family-only (not public) setup? Skip `funnel` and use
> `sudo tailscale serve --bg 3000` instead — then only devices signed into your
> Tailscale account can reach it (install the Tailscale app on father's phone).

---

## 5. First run

1. Open the URL → create the first account (name + 4-digit PIN).
2. The dashboard shows **Not connected** → tap it → scan the QR with WhatsApp
   (WhatsApp → Settings → Linked Devices → Link a Device).
3. On connect, accept **Import contacts**.
4. Create a scheduled message. Done — the VM keeps it running 24/7.

---

## Updating later

```bash
cd ~/WhatsappMe
git pull
npm install --omit=dev
sudo systemctl restart whatsapp-scheduler
```

## Notes

- **Persistence**: `sessions/` (WhatsApp login) and `data/db.sqlite` live on the
  VM's persistent disk — they survive restarts and reboots. Never run
  `git clean -fdx` (it deletes them; they are gitignored).
- **Backups** (optional): `cp -r ~/WhatsappMe/data ~/backup-$(date +%F)`.
- **Timezone**: scheduler fires in Asia/Kolkata (hardcoded in the app); the VM's
  own clock/timezone does not matter.
