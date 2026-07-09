# Deploy on Oracle Cloud (free ARM VM — recommended)

Oracle's Always Free tier is the most generous: up to **4 ARM cores + 24 GB RAM**,
free forever, with persistent disk. The app runs under systemd and is reached
from any phone over HTTPS via Tailscale Funnel (free, stable URL, no domain).

Total time: ~30–40 minutes, once.

---

## 1. Create the account + VM

1. Sign up at <https://www.oracle.com/cloud/free/>. You pick a **home region**
   during signup — this is permanent, so choose one near you. A card is required
   for verification; Always Free resources are never charged.
2. In the console: **Menu → Compute → Instances → Create instance**.
3. Set:
   - **Image**: Ubuntu 22.04 (make sure it's the **aarch64/ARM** build)
   - **Shape**: change to **Ampere → VM.Standard.A1.Flex**, then set
     **2 OCPU / 6 GB RAM** (well inside the free 4 OCPU / 24 GB limit)
   - **Boot volume**: default (~47 GB) is fine and free
   - **Networking**: keep the default VCN; leave "assign public IPv4" on
4. **SSH keys**: on your Mac, generate a key if you don't have one, then paste
   the **public** key into the "Add SSH keys" box:
   ```bash
   ssh-keygen -t ed25519 -C "oracle-wa"      # press Enter through prompts
   cat ~/.ssh/id_ed25519.pub                  # copy this whole line into the console
   ```
5. Create. Note the instance's **Public IP address** once it's running.

> **"Out of capacity" on ARM?** Ampere free capacity is sometimes exhausted in a
> region. Retry after a while, try a different Availability Domain in the create
> dialog, or (fallback) use shape **VM.Standard.E2.1.Micro** (AMD, 1 GB RAM) —
> smaller but still runs this app.

Connect from your Mac terminal:
```bash
ssh ubuntu@YOUR_PUBLIC_IP
```

---

## 2. Install Node + build tools + the app

In the SSH session:

```bash
# Node 20 LTS (arm64 build installs automatically)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git build-essential python3   # build-essential for better-sqlite3

cd ~
git clone https://github.com/udbhav-44/WhatsappMe.git
cd WhatsappMe
npm install --omit=dev

# Generate a session secret into .env
node -e "require('fs').writeFileSync('.env','SESSION_SECRET='+require('crypto').randomBytes(48).toString('hex')+'\n')"
```

Sanity check (Ctrl+C after the "running" line appears):
```bash
node src/server.js
```

---

## 3. Run it as a service (boot start + auto-restart)

The systemd unit is the same one used for GCP:

```bash
sudo cp deploy/whatsapp-scheduler.service /etc/systemd/system/
sudo sed -i "s/USERNAME/$USER/g" /etc/systemd/system/whatsapp-scheduler.service

sudo systemctl daemon-reload
sudo systemctl enable --now whatsapp-scheduler
systemctl status whatsapp-scheduler --no-pager
```

Later:
```bash
sudo systemctl restart whatsapp-scheduler
journalctl -u whatsapp-scheduler -f
```

---

## 4. Public HTTPS URL with Tailscale Funnel (free, stable, no domain)

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up                 # open the login link, sign in
sudo tailscale funnel --bg 3000
tailscale funnel status           # prints your permanent https URL
```

You get a fixed `https://<vm-name>.<your-tailnet>.ts.net`. It survives restarts.
Open on any phone, bookmark, share with your father. HTTPS is automatic, and
**no Oracle firewall ports need opening** (Tailscale is outbound-only).

> Family-only instead of public: use `sudo tailscale serve --bg 3000` — then only
> devices signed into your Tailscale account (install the app on father's phone)
> can reach it.

> If you ever want a raw open port instead of Tailscale, you must open it in
> **both** places on Oracle: the VCN Security List (ingress rule) **and** the
> instance's own iptables (`sudo iptables -I INPUT -p tcp --dport 3000 -j ACCEPT`
> then persist). Tailscale avoids all of this.

---

## 5. First run

1. Open the URL → create the first account (name + 4-digit PIN).
2. Dashboard shows **Not connected** → tap → scan QR (WhatsApp → Settings →
   Linked Devices → Link a Device).
3. Accept **Import contacts** after it connects.
4. Create a scheduled message. The VM keeps it running 24/7.

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
  boot volume — survive restarts/reboots. Never `git clean -fdx` (deletes them).
- **Keep it Always Free**: one A1.Flex within 4 OCPU / 24 GB, or the E2.1.Micro.
  Don't add paid block storage beyond the free 200 GB total.
- **Backups** (optional): `cp -r ~/WhatsappMe/data ~/backup-$(date +%F)`.
- **Timezone**: scheduler fires in Asia/Kolkata regardless of the VM's clock.
