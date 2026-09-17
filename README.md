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

## Fixing slow download speeds

Torrent speed depends on how many peers you can actually connect to. A few things commonly cause slow speeds:

1. **The peer port is blocked (most common cause on EC2).** By default WebTorrent picks a random port each run, and EC2's security group blocks everything except what you've explicitly opened (port 80 for the web UI). That means almost all incoming peer connections get rejected. This app now binds WebTorrent to a **fixed port** (`55000` by default, both TCP and UDP, used for DHT + peer connections) so you can open exactly that port. **Open it in your EC2 Security Group**:
   - Type: **Custom TCP**, Port: **55000**, Source: **0.0.0.0/0**
   - Type: **Custom UDP**, Port: **55000**, Source: **0.0.0.0/0**

   To use a different port, set `TORRENT_PORT` when starting the app (and open that port instead):
   ```bash
   TORRENT_PORT=55000 PORT=80 sudo -E node server.js
   ```
   With pm2:
   ```bash
   TORRENT_PORT=55000 pm2 start server.js --name torrent-site
   ```

2. **The torrent itself has few seeders.** No amount of configuration fixes a torrent with 1–2 slow seeders. Test with a well-seeded public torrent (e.g. an official Linux distro's magnet link) to check whether the app/server is the bottleneck or the specific torrent is.

3. **EC2 instance network bandwidth cap.** Small burstable instance types (e.g. `t2.micro`, `t3.micro`) have limited and sometimes "bursting" network bandwidth that throttles after a while. Check actual throughput with:
   ```bash
   pm2 logs torrent-site
   ```
   and watch the progress numbers in the UI. If speed is capped consistently around a fixed number regardless of the torrent, it's likely the instance type — consider a larger instance (e.g. `t3.medium` or a compute-optimized type) if you need faster/sustained throughput.

4. **Disk write speed.** The default EBS volume type (`gp2`) has baseline IOPS limits tied to volume size. For heavy simultaneous downloads, a `gp3` volume (or a larger `gp2` volume, since baseline IOPS scale with size) will write faster and avoid becoming the bottleneck.

## Getting seedbox-level speed (40+ Mbps and beyond)

A commercial seedbox is fast mainly because it's sitting on real, unthrottled datacenter bandwidth with lots of open ports — not because of anything magical in the software. To get comparable speed on your own EC2 box:

- **Pick an instance type with real network bandwidth, not a burstable one.** `t2`/`t3` instances are burstable — they throttle hard once the burst credits run out, which is exactly the "starts fast, then crawls" pattern people notice. Use a fixed-bandwidth type instead, e.g. `m5.large` (up to 10 Gbps) or `c5.large`/`c5n.large` (the `c5n` family has notably higher baseline network throughput and is a common seedbox-style pick). Bigger instance sizes within a family generally get a bigger slice of that network cap too.
- **Use a `gp3` EBS volume and raise its throughput.** `gp3` lets you provision IOPS and MiB/s independently of volume size (unlike `gp2`), so writes don't bottleneck the download:
  ```bash
  aws ec2 modify-volume --volume-id <your-volume-id> --volume-type gp3 --throughput 250 --iops 6000
  ```
- **Both TCP and UDP on the torrent port must be open**, in both the Security Group *and* the OS firewall if you've enabled `ufw`:
  ```bash
  sudo ufw allow 55000/tcp
  sudo ufw allow 55000/udp
  ```
- **Pick a region close to where most seeders are** — cross-continent hops add latency that limits how many pieces you can request in flight. `us-east-1` and `eu-west-1` tend to have the best general peering for public swarms.
- **This app now announces to a larger set of public trackers automatically** (added in `server.js`), so torrents should go from "peering" to actively downloading in seconds rather than minutes, and reach a fuller swarm (`maxConns: 500`) than most desktop clients default to.
- **Avoid running anything else network-heavy on the same instance** — encoding, other downloads, etc. all share the same network cap.

If you apply all of the above and speed is still capped well below what your instance type advertises, the bottleneck is very likely the specific torrent's seeder count and upload speed — no server configuration fixes that.

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

**Note:** if your repo has `index.html` sitting directly next to `server.js` (not inside a `public/` folder), move it before running the app, since `server.js` expects it at `public/index.html`:
```bash
mkdir -p public
mv index.html public/index.html
```

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

### 7. Open port 80 (web UI) and the torrent peer port in the EC2 Security Group
In the AWS Console: **EC2 → Instances → your instance → Security tab → click the security group → Edit inbound rules** → add:
- Type: **HTTP**, Port: **80**, Source: **0.0.0.0/0** (or restrict to your own IP for safety)
- Type: **Custom TCP**, Port: **55000**, Source: **0.0.0.0/0** (torrent peer connections — needed for good speed)
- Type: **Custom UDP**, Port: **55000**, Source: **0.0.0.0/0** (torrent DHT/peer discovery — needed for good speed)

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

### Full copy-paste block (matches your repo layout — index.html at root)
```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git
cd ~
git clone https://github.com/<your-username>/torrent.git
cd torrent
mkdir -p public
mv index.html public/index.html
npm install
sudo npm install -g pm2
sudo TORRENT_PORT=55000 pm2 start server.js --name torrent-site
pm2 save
pm2 startup
curl -s ifconfig.me
```
Then open `http://<printed-ip>/` in your browser, and make sure ports **80** (TCP), **55000** (TCP), and **55000** (UDP) are all open in your EC2 security group — see step 7 above for the torrent-speed reasoning.

### Security reminder
Running this on a public IP with port 80 open and no login means **anyone** who finds the address can add torrents and download everything sitting in your `Download` folder, using your server's bandwidth/disk. Restrict the security group to your own IP, or add authentication, unless this is meant to be fully public.
