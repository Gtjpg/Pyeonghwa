# Calls between different networks

## What is going on

Audio and video go **directly between the two browsers**. That works when both
people are on the same Wi-Fi, and often even on different home networks. It
fails on many mobile-data connections, school and office networks, and anything
with a strict firewall.

The fix is a **TURN relay**: a small server on the internet that passes the call
through when a direct connection isn't possible. This project is set up for
**coturn**, the standard free relay.

Two things are needed for calls to work across networks:

1. **A TURN relay** (this guide, steps 1 to 6).
2. **Your site reachable on the internet over `https`**, because browsers only
   allow the camera and microphone on `https` pages (or `localhost`). See
   "Putting the site online" at the end.

### About "limitless"

- Nothing in the app limits the number of calls, how long they last, or the video
  quality.
- A relay you run yourself has no usage limit either. The only limits are your
  server's internet speed and your hosting plan's data allowance.
- Most calls connect directly and never touch the relay. Only the calls that
  can't connect directly use its bandwidth.
- Hosted TURN services (Twilio, Metered, Cloudflare, Xirsys and others) are
  easier but their free plans do have data limits. Running coturn yourself is
  the way to avoid limits.

---

## Step 1: Get a server and a domain name

- Any small Linux server (VPS) with a **public IP address** works. A relay uses
  very little CPU; its bandwidth is what matters.
- Point a domain name at it, for example an **A record**
  `turn.example.com -> 203.0.113.10`.

## Step 2: Install coturn

```bash
sudo apt update
sudo apt install coturn
```

## Step 3: Configure it

Copy `coturn/turnserver.conf` from this project to `/etc/turnserver.conf` on the
server and change the three marked settings:

- `realm` and `server-name`: your domain (`turn.example.com`).
- `static-auth-secret`: a long random secret. Make one with:

  ```bash
  openssl rand -hex 32
  ```

If your provider uses a private address behind a public one (AWS, Google Cloud,
Oracle and similar), also uncomment `external-ip=` and put your public address
there.

Then start it:

```bash
sudo systemctl enable --now coturn
sudo systemctl status coturn
```

## Step 4: Open the firewall

On the server **and** in your cloud provider's firewall / security group:

| Port | Protocol | What for |
| --- | --- | --- |
| 3478 | UDP and TCP | TURN |
| 5349 | TCP | TURN over TLS (`turns:`) |
| 49152 to 65535 | UDP | the relayed audio and video |

With `ufw`:

```bash
sudo ufw allow 3478
sudo ufw allow 5349/tcp
sudo ufw allow 49152:65535/udp
```

## Step 5 (recommended): Add a certificate for `turns:`

`turns:` is TURN inside TLS. It gets through stricter firewalls that block
plain TURN.

```bash
sudo apt install certbot
sudo certbot certonly --standalone -d turn.example.com
```

Uncomment the `cert=` and `pkey=` lines in `/etc/turnserver.conf`, make sure the
coturn user can read those files, and restart: `sudo systemctl restart coturn`.

## Step 6: Tell the backend about it

In `backend/.env` (there is a template in `backend/.env.example`):

```env
TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:5349?transport=tcp
TURN_SECRET=the-same-secret-as-static-auth-secret
```

Restart the backend. People now get a **temporary** relay password (valid for 24
hours, different for every person) each time they start a call, so no permanent
password is stored in the website.

Using a hosted TURN service instead of your own coturn? Use their fixed login:

```env
TURN_URLS=turn:their-server.example.net:443
TURN_USERNAME=your-username
TURN_CREDENTIAL=your-password
```

### Check that it works

1. Log in, open the browser's developer tools (F12), go to **Network**, and start
   a call. Click the `ice-servers` request and read its **Response**. It should
   contain a `turn:` entry with a `username` and a `credential`.
2. Paste those three values (URL, username, credential) into the free
   **Trickle ICE** test page
   (`webrtc.github.io/samples/src/content/peerconnection/trickle-ice/`) and
   press "Gather candidates". A line of type **relay** means your relay works.
3. In `frontend/.env` set `VITE_FORCE_RELAY=true`, restart `npm run dev`, and call
   from another network (for example your phone on mobile data). If the call
   connects, everything is working. Remove that line afterwards.

---

## Putting the site online

For two people on different networks to open your site, it needs a public
address with `https`. The app now reads these from settings, so no code changes
are needed.

**Backend** (`backend/.env`):

```env
PORT=3000
CLIENT_ORIGIN=https://chat.example.com
```

**Frontend** (`frontend/.env`, then run `npm run build` and host the `dist`
folder):

```env
VITE_API_URL=https://api.example.com
```

- Both addresses must be `https`.
- If a reverse proxy (nginx, Caddy, and so on) sits in front of the backend, it
  must allow **WebSocket** connections for `/socket.io/`, and uploads of up to
  5 MB.
- The backend stores photos in `backend/uploads/`. On hosts that wipe the disk
  on every deploy, use a persistent disk or the photos will disappear.

For a quick try before a proper deployment, a tunnelling tool such as Cloudflare
Tunnel or ngrok can give your two local ports (5173 and 3000) public `https`
addresses. Use those two addresses for `CLIENT_ORIGIN` and `VITE_API_URL`.

---

## Safety notes

- Never put `TURN_SECRET` in the frontend or commit it to git. It belongs only in
  `backend/.env` and in coturn's config.
- The config already stops the relay from being used to reach private or
  internal network addresses. Keep the `denied-peer-ip` lines.
- Keep the secret private; whoever has it can create relay logins.
