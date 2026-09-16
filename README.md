# Torrent Downloader (magnet link + .torrent file)

A simple self-hosted web app to download torrents by pasting a **magnet link** or
uploading a **.torrent file**. Downloaded content is saved into the `Download`
folder next to `server.js`.

## Folder structure
```
torrent-site/
├── server.js         # Express + WebTorrent backend
├── package.json
├── public/
│   └── index.html     # Web UI
└── Download/           # Downloaded files land here
```

## Setup
```bash
cd torrent-site
npm install
```

## Run

Port 80 is a privileged port on Linux/macOS, so you need root, or a capability grant, to bind it directly:

```bash
sudo node server.js
```

Or run on a normal port and let a reverse proxy (nginx/Caddy) forward port 80 to it:
```bash
PORT=8080 node server.js
```

Then open `http://<your-server-ip>/` (or `:8080` if not using port 80 directly).

## How it works
- Paste a magnet link and click **Add Magnet**, or choose a `.torrent` file and click **Upload & Add**.
- Progress, download speed data, and completed file listings refresh automatically every 2 seconds.
- Files download straight into `Download/<torrent name>/...`.
- Click **Remove** to stop a torrent (downloaded files are kept on disk).

## Notes / things to configure for production use
- There's no authentication — anyone who can reach the site can add/remove torrents. Add a login or put it behind a VPN/reverse proxy with auth if exposing it beyond your own network.
- Only download and distribute content you have the legal right to — copyright laws apply to torrenting the same as any other distribution method.
- For heavy use, consider disk-space checks/quotas and a limit on simultaneous torrents.

## Deploying on an AWS EC2 (Ubuntu) instance

Steps that worked end-to-end on a fresh Ubuntu EC2 box, including fixes for issues we hit along the way:

### 1. Make sure you're in the right folder
If you cloned/uploaded into a folder that already contained a `torrent` subfolder, you may end up nested one level too deep (e.g. `/home/ubuntu/torrent/torrent` instead of `/home/ubuntu/torrent`). Confirm with:
```bash
ls -la
```
You should see `server.js`, `package.json`, and a `public/` folder directly — `cd` into the right level if not.

### 2. Install dependencies
```bash
npm install
```

### 3. Fix a missing/misplaced `public/index.html`
If the HTML file wasn't inside a `public/` folder (e.g. it got uploaded to the project root as `index (1).html` from a browser download), `express.static` won't find it and you'll get **"Cannot GET /"**. Fix it with:
```bash
mkdir -p public
mv "index (1).html" public/index.html
ls public   # should now show index.html
```
(Adjust the source filename if yours differs — the destination must be exactly `public/index.html`.)

### 4. Free up port 80 if it's already in use
If you see `Error: listen EADDRINUSE: address already in use :::80`, something else (often a stray earlier `node` process, or nginx/Apache) is already bound to port 80:
```bash
sudo lsof -i :80          # see what's using it
sudo kill <PID>            # stop it, or:
sudo systemctl stop nginx  # if it's a default web server
```
Alternatively, just run the app on a different port and skip the conflict entirely:
```bash
PORT=8080 node server.js
```

### 5. Run it
```bash
sudo node server.js
```
Expected output:
```
Torrent download site running at http://localhost:80
Files will be saved to: /home/ubuntu/torrent/torrent/Download
```

### 6. Open the EC2 Security Group for port 80
EC2 blocks all inbound traffic by default. In the AWS Console: **EC2 → your instance → Security tab → click the security group → Edit inbound rules** → add a rule for **HTTP, port 80, source 0.0.0.0/0** (or restrict to your own IP).

Find your instance's public IP with:
```bash
curl -s ifconfig.me
```
Then visit `http://<that-ip>/` in a browser.

### 7. Keep it running after you close SSH
By default the process dies when your SSH session ends. Use `pm2` to keep it alive and auto-restart on reboot:
```bash
sudo npm install -g pm2
sudo pm2 start server.js --name torrent-site
pm2 save
pm2 startup    # then run the command it prints
```
To apply changes later: `pm2 restart torrent-site`.

### Security reminder
Running this on a public IP with port 80 open and no login means **anyone** who finds the address can add torrents and use your server's bandwidth/disk. Restrict the security group to your own IP, or add authentication, unless this is meant to be fully public.
