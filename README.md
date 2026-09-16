# Torrent Downloader (magnet link + .torrent file)

A simple self-hosted web app to download torrents by pasting a **magnet link** or
uploading a **.torrent file**. Downloaded content is saved into the `Download`
folder next to `server.js`. The UI also lists everything currently in `Download`
(including files that were already there) with a **Download** button for each
file, and a **Download .zip** button for each folder.

## Folder structure
```
torrent-site/
├── server.js         # Express + WebTorrent backend
├── package.json
├── public/
│   └── index.html     # Web UI
└── Download/           # Downloaded files land here
```

## Features
- Add torrents via magnet link or `.torrent` file upload
- Live progress bar per torrent
- Browse **all files already in the `Download` folder** (not just ones added through the app), shown as a folder tree
- **Download** any individual file straight from the browser
- **Download a whole folder as a `.zip`** with one click

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
- The **"Files in Download folder"** section (refreshes every 5 seconds, or click **Refresh**) shows everything on disk in `Download/`, whether it was added via the app or dropped in manually — each file has a **Download** link, and each folder has a **Download .zip** link.

## Notes / things to configure for production use
- There's no authentication — anyone who can reach the site can add/remove torrents and download everything in `Download/`. Add a login or put it behind a VPN/reverse proxy with auth if exposing it beyond your own network.
- Only download and distribute content you have the legal right to — copyright laws apply to torrenting the same as any other distribution method.
- For heavy use, consider disk-space checks/quotas and a limit on simultaneous torrents.

## Deploying on a fresh AWS EC2 (Ubuntu) instance — full command list

This assumes your GitHub repo is named `torrent` and contains this project at its root. Run these **in order**, straight after SSH-ing into a brand-new Ubuntu EC2 instance.

### 1. SSH into the instance
```bash
ssh -i /path/to/your-key.pem ubuntu@<your-ec2-public-ip>
```

### 2. Update the system and install Node.js + git
```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git
node -v
npm -v
```

### 3. Clone the repo
```bash
cd ~
git clone https://github.com/<your-username>/torrent.git
cd torrent
```
If your project files sit inside a subfolder in the repo (e.g. `torrent-site/`), `cd` into that folder instead — check with `ls -la` first.

### 4. Install dependencies
```bash
npm install
```

### 5. Confirm the `public/index.html` file is present
```bash
ls -la
ls -la public
```
You should see `server.js`, `package.json`, and `public/index.html`. If `index.html` is missing or misnamed (e.g. `index (1).html` sitting in the project root instead of inside `public/`), fix it with:
```bash
mkdir -p public
mv "index (1).html" public/index.html
```

### 6. Free up port 80 if needed
Ubuntu EC2 AMIs don't run anything on port 80 by default, but if you see `EADDRINUSE` later:
```bash
sudo lsof -i :80
sudo kill <PID>          # or: sudo systemctl stop nginx / apache2
```

### 7. Open port 80 in the EC2 Security Group
In the AWS Console: **EC2 → Instances → your instance → Security tab → click the security group → Edit inbound rules** → add:
- Type: **HTTP**, Port: **80**, Source: **0.0.0.0/0** (or restrict to your own IP for safety)

### 8. Run the server
Quick test run (stops when you close the terminal):
```bash
sudo node server.js
```
Expected output:
```
Torrent download site running at http://localhost:80
Files will be saved to: /home/ubuntu/torrent/Download
```

### 9. Find your public IP and open it in a browser
```bash
curl -s ifconfig.me
```
Visit `http://<that-ip>/` in your browser.

### 10. Keep it running permanently with pm2
```bash
sudo npm install -g pm2
sudo pm2 start server.js --name torrent-site
pm2 save
pm2 startup
```
`pm2 startup` prints a command — copy and run that exact command it gives you (it registers pm2 to start on reboot).

To check status / logs / restart later:
```bash
pm2 status
pm2 logs torrent-site
pm2 restart torrent-site
```

### Full copy-paste block (once you've confirmed repo layout and security group)
```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git
cd ~
git clone https://github.com/<your-username>/torrent.git
cd torrent
npm install
sudo npm install -g pm2
sudo pm2 start server.js --name torrent-site
pm2 save
pm2 startup
curl -s ifconfig.me
```
Then open `http://<printed-ip>/` in your browser.

### Security reminder
Running this on a public IP with port 80 open and no login means **anyone** who finds the address can add torrents and download everything sitting in your `Download` folder, using your server's bandwidth/disk. Restrict the security group to your own IP, or add authentication, unless this is meant to be fully public.
