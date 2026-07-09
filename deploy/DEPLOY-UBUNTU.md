# Deploy on Ubuntu 24.04 (any VM / home server)

Run the scheduler 24/7 on any Ubuntu 24.04 box — a home server, a mini PC, or
a cloud VM. The app runs under systemd; a public HTTPS URL comes from a
**Cloudflare Tunnel** (free, stable custom domain, works on every network — no
open ports, no port forwarding).

> On a cloud free tier instead? See [DEPLOY-ORACLE.md](DEPLOY-ORACLE.md)
> (recommended, most generous) or [DEPLOY-GCP.md](DEPLOY-GCP.md). Those use
> Tailscale Funnel. This guide uses Cloudflare Tunnel, which resolves reliably
> on **every** DNS resolver (Tailscale's `*.ts.net` can fail on IPv4-only
> networks whose resolver returns no A record).

Total time: ~20–30 minutes, once.

---

## 1. Install Node 20 + build tools

Ubuntu 24.04 (noble) ships Node **18** in its own repos — too old
(`better-sqlite3` and Baileys need Node 20+). Install Node 20 from NodeSource:

```bash
# Remove the distro node if it's already installed
sudo apt-get remove -y nodejs libnode-dev 2>/dev/null || true

# Add NodeSource 20 and install
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git build-essential python3   # build-essential + python3 for better-sqlite3

node -v    # must show v20.x
```

If `node -v` still shows v18: the NodeSource repo wasn't picked. Check
`apt-cache policy nodejs` — the Candidate must come from `deb.nodesource.com`.
Re-run the `curl … setup_20.x` line and watch for errors.

---

## 2. Get the app

```bash
cd ~                       # or wherever you keep services, e.g. /data/homelab
git clone https://github.com/udbhav-44/WhatsappMe.git
cd WhatsappMe
npm install --omit=dev

# Generate a session secret into .env
node -e "require('fs').writeFileSync('.env','SESSION_SECRET='+require('crypto').randomBytes(48).toString('hex')+'\n')"
```

> `npm install` prints `EBADENGINE` warnings if any stray Node <20 is around,
> and some `deprecated` transitive-dep warnings — both harmless. Do **not** run
> `npm audit fix` (it can break the native `better-sqlite3` build).

Sanity check (Ctrl+C after the "running" line):

```bash
node src/server.js
```

---

## 3. Run it as a service (boot start + auto-restart)

The systemd unit hardcodes `/home/USERNAME/WhatsappMe`. If you cloned elsewhere
(e.g. `/data/homelab/WhatsappMe`), fix `WorkingDirectory` too — the second
`sed` below does that; drop it if you cloned into your home directory.

```bash
sudo cp deploy/whatsapp-scheduler.service /etc/systemd/system/
sudo sed -i "s/USERNAME/$USER/g" /etc/systemd/system/whatsapp-scheduler.service
# only if the repo is NOT at /home/$USER/WhatsappMe — point it at the real path:
sudo sed -i "s#/home/$USER/WhatsappMe#$(pwd)#" /etc/systemd/system/whatsapp-scheduler.service

sudo systemctl daemon-reload
sudo systemctl enable --now whatsapp-scheduler
systemctl status whatsapp-scheduler --no-pager
```

Later:

```bash
sudo systemctl restart whatsapp-scheduler
journalctl -u whatsapp-scheduler -f
```

At this point the app is reachable **on the LAN** at `http://<server-ip>:3000`.
If `ufw` is active, open the port for your LAN only (public access comes from
the tunnel, not this port):

```bash
sudo ufw status                                        # is it active?
sudo ufw allow from 192.168.0.0/16 to any port 3000 proto tcp   # adjust to your subnet
```

---

## 4. Public HTTPS with Cloudflare Tunnel (free, stable, any network)

You need a domain whose **nameservers are on Cloudflare** (any registrar that
lets you set custom nameservers — e.g. Namecheap — works). Point the domain at
Cloudflare first: dash.cloudflare.com → **Add a site** → Free plan → copy the 2
nameservers it shows → set them as **Custom DNS** at your registrar → wait until
the zone shows **Active**.

Install cloudflared:

```bash
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install -y cloudflared
cloudflared --version
```

Authenticate, create the tunnel, route your domain to it:

```bash
cloudflared tunnel login              # opens a browser link — pick your domain, Authorize
cloudflared tunnel create ping        # note the tunnel UUID it prints

# route your apex + www to the tunnel (replace example.com)
cloudflared tunnel route dns ping example.com
cloudflared tunnel route dns ping www.example.com
```

Write the tunnel config (replace UUID, username, and hostnames):

```bash
cat > ~/.cloudflared/config.yml <<'EOF'
tunnel: <TUNNEL-UUID>
credentials-file: /home/<USER>/.cloudflared/<TUNNEL-UUID>.json

ingress:
  - hostname: example.com
    service: http://127.0.0.1:3000
  - hostname: www.example.com
    service: http://127.0.0.1:3000
  - service: http_status:404
EOF

cloudflared tunnel ingress validate   # should print OK
```

Install it as a boot service:

```bash
sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/config.yml ~/.cloudflared/<TUNNEL-UUID>.json /etc/cloudflared/
sudo sed -i "s#/home/<USER>/.cloudflared/#/etc/cloudflared/#" /etc/cloudflared/config.yml
sudo cloudflared service install
sudo systemctl enable --now cloudflared
systemctl status cloudflared --no-pager
```

Your site is now live at `https://example.com` on **any** network (Cloudflare
returns consistent A + AAAA on every resolver). No inbound firewall ports are
needed — the tunnel is outbound-only.

> Family-only instead of public: skip the tunnel and reach the app over the LAN
> at `http://<server-ip>:3000`, or put it behind Tailscale.

---

## 5. First run

1. Open your URL → create the first account (name + 4-digit PIN).
2. Dashboard shows **Not connected** → tap → scan QR (WhatsApp → Settings →
   Linked Devices → Link a Device).
3. Accept **Import contacts** after it connects.
4. Create a scheduled message. The server keeps it running 24/7.

---

## Updating later

```bash
cd ~/WhatsappMe        # or your clone path
git pull
npm install --omit=dev
sudo systemctl restart whatsapp-scheduler
```

## Notes

- **Persistence:** `sessions/` (WhatsApp login) and `data/db.sqlite` survive
  restarts/reboots. Never `git clean -fdx` (deletes them).
- **Timezone:** the scheduler fires in Asia/Kolkata regardless of the server's
  clock.
- **Backups** (optional): `cp -r ~/WhatsappMe/data ~/backup-$(date +%F)`.
