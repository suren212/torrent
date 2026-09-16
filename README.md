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
