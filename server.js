/**
 * Torrent Download Site
 * ----------------------
 * - Accepts a .torrent file upload OR a magnet link
 * - Downloads the content into ./Download (next to this server + index.html)
 * - Serves a simple web UI on PORT (default 80)
 *
 * Run:
 *   npm install
 *   sudo node server.js      # port 80 needs root/admin on Linux
 *   # or
 *   PORT=8080 node server.js # use a non-privileged port instead
 */

const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const WebTorrent = require('webtorrent');

const PORT = process.env.PORT || 80;
const DOWNLOAD_DIR = path.join(__dirname, 'Download');
const PUBLIC_DIR = path.join(__dirname, 'public');
const TMP_UPLOAD_DIR = path.join(__dirname, 'tmp_uploads');

// Ensure required folders exist
[DOWNLOAD_DIR, TMP_UPLOAD_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const app = express();
const client = new WebTorrent();
const upload = multer({ dest: TMP_UPLOAD_DIR });

app.use(express.json());
app.use(express.static(PUBLIC_DIR)); // serves index.html etc.

// In-memory registry of active/completed torrents for the UI to poll
const torrents = {}; // infoHash -> { name, progress, downloaded, total, done, files, addedAt }

function registerTorrent(torrent) {
  const id = torrent.infoHash;
  torrents[id] = {
    id,
    name: torrent.name,
    progress: 0,
    downloaded: 0,
    total: torrent.length || 0,
    done: false,
    files: [],
    addedAt: Date.now(),
  };

  const update = () => {
    if (!torrents[id]) return;
    torrents[id].name = torrent.name;
    torrents[id].progress = Math.round(torrent.progress * 100);
    torrents[id].downloaded = torrent.downloaded;
    torrents[id].total = torrent.length;
  };

  torrent.on('metadata', update);
  torrent.on('download', update);

  torrent.on('done', () => {
    update();
    torrents[id].done = true;
    torrents[id].files = torrent.files.map((f) => ({
      name: f.name,
      length: f.length,
      path: path.relative(DOWNLOAD_DIR, f.path),
    }));
    console.log(`[DONE] ${torrent.name}`);
  });

  torrent.on('error', (err) => {
    console.error(`[ERROR] ${torrent.name || id}:`, err.message);
    if (torrents[id]) torrents[id].error = err.message;
  });

  update();
}

function alreadyAdded(infoHash) {
  return client.torrents.some((t) => t.infoHash === infoHash);
}

// --- API: add via magnet link ---
app.post('/api/add-magnet', (req, res) => {
  const { magnet } = req.body || {};
  if (!magnet || !/^magnet:\?/i.test(magnet.trim())) {
    return res.status(400).json({ error: 'A valid magnet link is required.' });
  }

  try {
    const torrent = client.add(magnet.trim(), { path: DOWNLOAD_DIR });
    registerTorrent(torrent);
    res.json({ ok: true, infoHash: torrent.infoHash });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- API: add via .torrent file upload ---
app.post('/api/add-file', upload.single('torrentFile'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'A .torrent file is required.' });
  }

  const filePath = req.file.path;

  try {
    const torrent = client.add(fs.readFileSync(filePath), { path: DOWNLOAD_DIR }, (t) => {
      // cleanup temp upload once parsed
      fs.unlink(filePath, () => {});
    });
    registerTorrent(torrent);
    res.json({ ok: true, infoHash: torrent.infoHash });
  } catch (err) {
    fs.unlink(filePath, () => {});
    res.status(500).json({ error: err.message });
  }
});

// --- API: list current torrents / progress ---
app.get('/api/torrents', (req, res) => {
  res.json(Object.values(torrents).sort((a, b) => b.addedAt - a.addedAt));
});

// --- API: remove a torrent (keeps downloaded files by default) ---
app.delete('/api/torrents/:infoHash', (req, res) => {
  const { infoHash } = req.params;
  const torrent = client.torrents.find((t) => t.infoHash === infoHash);
  if (!torrent) return res.status(404).json({ error: 'Not found' });

  torrent.destroy({ destroyStore: false }, () => {
    delete torrents[infoHash];
    res.json({ ok: true });
  });
});

app.listen(PORT, () => {
  console.log(`Torrent download site running at http://localhost:${PORT}`);
  console.log(`Files will be saved to: ${DOWNLOAD_DIR}`);
});
