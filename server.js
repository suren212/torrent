/**
 * Torrent Download Site
 * ----------------------
 * - Accepts a .torrent file upload OR a magnet link
 * - Downloads torrent content into ./Download
 * - Serves a web UI
 * - High-performance HTTP file downloads
 * - HTTP Range / resume support
 * - Safe path handling
 * - Optimized folder ZIP downloads
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const WebTorrent = require('webtorrent');

const PORT = process.env.PORT ? Number(process.env.PORT) : 80;
const TORRENT_PORT = process.env.TORRENT_PORT
  ? Number(process.env.TORRENT_PORT)
  : 55000;

const DOWNLOAD_DIR = path.resolve(__dirname, 'Download');
const TMP_UPLOAD_DIR = path.resolve(__dirname, 'tmp_uploads');

/*
 * HTTP download tuning
 *
 * 1 MB stream buffer is useful for large files while avoiding
 * loading the complete file into RAM.
 */
const STREAM_HIGH_WATER_MARK = 1024 * 1024;

/*
 * Ensure directories exist.
 */
[DOWNLOAD_DIR, TMP_UPLOAD_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

const app = express();

app.disable('x-powered-by');

app.use(express.json({ limit: '1mb' }));

/*
 * ---------------------------------------------------------
 * WEBTORRENT CLIENT
 * ---------------------------------------------------------
 */

const client = new WebTorrent({
  torrentPort: TORRENT_PORT,
  dhtPort: TORRENT_PORT + 1,

  /*
   * Allow many peer connections.
   */
  maxConns: 500,

  /*
   * Unlimited torrent upload/download throttling.
   */
  uploadLimit: -1,
  downloadLimit: -1,
});

client.on('error', (err) => {
  console.error(
    '[WebTorrent client error]',
    err && err.message ? err.message : err
  );
});

/*
 * Torrent upload storage.
 */
const upload = multer({
  dest: TMP_UPLOAD_DIR,
});

/*
 * ---------------------------------------------------------
 * WEB UI
 * ---------------------------------------------------------
 */

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

/*
 * ---------------------------------------------------------
 * TORRENT REGISTRY
 * ---------------------------------------------------------
 */

const torrents = {};

function registerTorrent(torrent) {
  const id = torrent.infoHash;

  torrents[id] = {
    id,
    name: torrent.name || 'Fetching metadata...',
    progress: 0,
    downloaded: 0,
    total: torrent.length || 0,
    done: false,
    files: [],
    addedAt: Date.now(),
  };

  const update = () => {
    if (!torrents[id]) return;

    torrents[id].name = torrent.name || 'Fetching metadata...';
    torrents[id].progress = Math.round((torrent.progress || 0) * 100);
    torrents[id].downloaded = torrent.downloaded || 0;
    torrents[id].total = torrent.length || 0;
  };

  torrent.on('metadata', update);
  torrent.on('download', update);

  torrent.on('done', () => {
    update();

    torrents[id].done = true;

    torrents[id].files = torrent.files.map((file) => ({
      name: file.name,
      length: file.length,
      path: path.relative(DOWNLOAD_DIR, file.path),
    }));

    console.log(`[DONE] ${torrent.name}`);
  });

  torrent.on('error', (err) => {
    console.error(
      `[ERROR] ${torrent.name || id}:`,
      err.message
    );

    if (torrents[id]) {
      torrents[id].error = err.message;
    }
  });

  update();
}

/*
 * ---------------------------------------------------------
 * TRACKERS
 * ---------------------------------------------------------
 */

const EXTRA_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://open.stealth.si:80/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.tiny-vps.com:6969/announce',
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.btorrent.xyz',
];

/*
 * ---------------------------------------------------------
 * HELPERS
 * ---------------------------------------------------------
 */

function alreadyAdded(infoHash) {
  return client.torrents.some(
    (torrent) => torrent.infoHash === infoHash
  );
}

/*
 * Recursively build Download directory tree.
 */
function buildTree(dirAbsPath) {
  const entries = fs.readdirSync(dirAbsPath, {
    withFileTypes: true,
  });

  const nodes = [];

  for (const entry of entries) {
    const absPath = path.join(dirAbsPath, entry.name);
    const relPath = path.relative(DOWNLOAD_DIR, absPath);

    if (entry.isDirectory()) {
      const children = buildTree(absPath);

      const size = children.reduce(
        (sum, child) => sum + child.size,
        0
      );

      nodes.push({
        type: 'folder',
        name: entry.name,
        relPath,
        size,
        children,
      });
    } else if (entry.isFile()) {
      const stat = fs.statSync(absPath);

      nodes.push({
        type: 'file',
        name: entry.name,
        relPath,
        size: stat.size,
      });
    }
  }

  nodes.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'folder' ? -1 : 1;
    }

    return a.name.localeCompare(b.name);
  });

  return nodes;
}

/*
 * Resolve a user supplied path safely inside Download.
 */
function resolveSafePath(relPath) {
  if (typeof relPath !== 'string') {
    return null;
  }

  const target = path.resolve(
    DOWNLOAD_DIR,
    relPath
  );

  if (
    target !== DOWNLOAD_DIR &&
    !target.startsWith(DOWNLOAD_DIR + path.sep)
  ) {
    return null;
  }

  return target;
}

/*
 * Protect against symlink escaping the Download directory.
 */
function isInsideDownloadRealPath(target) {
  try {
    const realDownload = fs.realpathSync(DOWNLOAD_DIR);
    const realTarget = fs.realpathSync(target);

    return (
      realTarget === realDownload ||
      realTarget.startsWith(realDownload + path.sep)
    );
  } catch {
    return false;
  }
}

/*
 * Basic MIME type detection without another npm dependency.
 */
function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  const mimeTypes = {
    '.txt': 'text/plain; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.xml': 'application/xml',
    '.csv': 'text/csv; charset=utf-8',

    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',

    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',

    '.mp4': 'video/mp4',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
    '.avi': 'video/x-msvideo',
    '.mov': 'video/quicktime',

    '.pdf': 'application/pdf',

    '.zip': 'application/zip',
    '.rar': 'application/vnd.rar',
    '.7z': 'application/x-7z-compressed',

    '.torrent': 'application/x-bittorrent',

    '.iso': 'application/octet-stream',
    '.exe': 'application/octet-stream',
    '.bin': 'application/octet-stream',
  };

  return mimeTypes[ext] || 'application/octet-stream';
}

/*
 * Safely create a Content-Disposition header.
 */
function getAttachmentHeader(filename) {
  const safeFilename = path
    .basename(filename)
    .replace(/[\r\n"]/g, '_');

  const encodedFilename = encodeURIComponent(
    safeFilename
  );

  return `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`;
}

/*
 * ---------------------------------------------------------
 * HIGH PERFORMANCE FILE STREAMING
 * ---------------------------------------------------------
 *
 * Supports:
 *
 * GET /api/download/file.iso
 *
 * HTTP Range:
 *
 * Range: bytes=0-1048575
 *
 * Response:
 *
 * 206 Partial Content
 *
 * This allows browser downloads to resume and enables
 * efficient large-file transfers.
 */

function streamFile(req, res, target) {
  let stat;

  try {
    stat = fs.statSync(target);
  } catch (err) {
    return res.status(404).json({
      error: 'File not found.',
    });
  }

  if (!stat.isFile()) {
    return res.status(400).json({
      error: 'Target is not a file.',
    });
  }

  const fileSize = stat.size;
  const filename = path.basename(target);

  const contentType = getContentType(target);

  /*
   * Always tell browsers that byte ranges are supported.
   */
  res.setHeader(
    'Accept-Ranges',
    'bytes'
  );

  res.setHeader(
    'Content-Type',
    contentType
  );

  res.setHeader(
    'Content-Disposition',
    getAttachmentHeader(filename)
  );

  /*
   * Files inside a torrent Download folder are generally
   * immutable after completion, but we use a conservative
   * cache policy.
   */
  res.setHeader(
    'Cache-Control',
    'private, max-age=0, must-revalidate'
  );

  /*
   * No range requested.
   */
  if (!req.headers.range) {
    res.statusCode = 200;

    res.setHeader(
      'Content-Length',
      fileSize
    );

    /*
     * Flush headers before the potentially large stream.
     */
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    const stream = fs.createReadStream(target, {
      highWaterMark: STREAM_HIGH_WATER_MARK,
    });

    /*
     * If browser disconnects, stop reading the disk.
     */
    const cleanup = () => {
      if (!stream.destroyed) {
        stream.destroy();
      }
    };

    req.on('aborted', cleanup);
    res.on('close', cleanup);

    stream.on('error', (err) => {
      console.error(
        `[DOWNLOAD ERROR] ${filename}:`,
        err.message
      );

      if (!res.headersSent) {
        res.status(500).end();
      } else {
        res.destroy(err);
      }
    });

    stream.pipe(res);

    return;
  }

  /*
   * -------------------------------------------------------
   * RANGE REQUEST
   * -------------------------------------------------------
   */

  const rangeHeader = req.headers.range;

  /*
   * We intentionally support one byte range.
   * Browsers normally request a single range for downloads.
   */
  const match = /^bytes=(\d*)-(\d*)$/.exec(
    rangeHeader.trim()
  );

  if (!match) {
    res.status(416);

    res.setHeader(
      'Content-Range',
      `bytes */${fileSize}`
    );

    return res.end();
  }

  let start;
  let end;

  const startString = match[1];
  const endString = match[2];

  /*
   * Example:
   *
   * bytes=1000-2000
   */
  if (startString !== '') {
    start = Number(startString);

    if (!Number.isSafeInteger(start)) {
      res.status(416);

      res.setHeader(
        'Content-Range',
        `bytes */${fileSize}`
      );

      return res.end();
    }

    /*
     * bytes=1000-
     */
    if (endString === '') {
      end = fileSize - 1;
    } else {
      end = Number(endString);

      if (!Number.isSafeInteger(end)) {
        res.status(416);

        res.setHeader(
          'Content-Range',
          `bytes */${fileSize}`
        );

        return res.end();
      }
    }
  } else {
    /*
     * Suffix range:
     *
     * bytes=-500000
     *
     * Means last 500000 bytes.
     */
    const suffixLength = Number(endString);

    if (
      !Number.isSafeInteger(suffixLength) ||
      suffixLength <= 0
    ) {
      res.status(416);

      res.setHeader(
        'Content-Range',
        `bytes */${fileSize}`
      );

      return res.end();
    }

    start = Math.max(
      fileSize - suffixLength,
      0
    );

    end = fileSize - 1;
  }

  /*
   * Normalize end.
   */
  end = Math.min(
    end,
    fileSize - 1
  );

  /*
   * Invalid range.
   */
  if (
    fileSize === 0 ||
    start < 0 ||
    start >= fileSize ||
    start > end
  ) {
    res.status(416);

    res.setHeader(
      'Content-Range',
      `bytes */${fileSize}`
    );

    return res.end();
  }

  const contentLength =
    end - start + 1;

  res.statusCode = 206;

  res.setHeader(
    'Content-Range',
    `bytes ${start}-${end}/${fileSize}`
  );

  res.setHeader(
    'Content-Length',
    contentLength
  );

  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  const stream = fs.createReadStream(target, {
    start,
    end,
    highWaterMark: STREAM_HIGH_WATER_MARK,
  });

  const cleanup = () => {
    if (!stream.destroyed) {
      stream.destroy();
    }
  };

  req.on('aborted', cleanup);
  res.on('close', cleanup);

  stream.on('error', (err) => {
    console.error(
      `[RANGE DOWNLOAD ERROR] ${filename}:`,
      err.message
    );

    if (!res.headersSent) {
      res.status(500).end();
    } else {
      res.destroy(err);
    }
  });

  stream.pipe(res);
}

/*
 * ---------------------------------------------------------
 * API: ADD MAGNET
 * ---------------------------------------------------------
 */

app.post('/api/add-magnet', (req, res) => {
  const { magnet } = req.body || {};

  if (
    !magnet ||
    !/^magnet:\?/i.test(magnet.trim())
  ) {
    return res.status(400).json({
      error: 'A valid magnet link is required.',
    });
  }

  try {
    const magnetLink = magnet.trim();

    const torrent = client.add(
      magnetLink,
      {
        path: DOWNLOAD_DIR,
        maxWebConns: 8,
        announce: EXTRA_TRACKERS,
      }
    );

    registerTorrent(torrent);

    res.json({
      ok: true,
      infoHash: torrent.infoHash,
    });
  } catch (err) {
    console.error('[MAGNET ERROR]', err);

    res.status(500).json({
      error: err.message,
    });
  }
});

/*
 * ---------------------------------------------------------
 * API: ADD TORRENT FILE
 * ---------------------------------------------------------
 */

app.post(
  '/api/add-file',
  upload.single('torrentFile'),
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        error: 'A .torrent file is required.',
      });
    }

    const filePath = req.file.path;

    try {
      const torrent = client.add(
        fs.readFileSync(filePath),
        {
          path: DOWNLOAD_DIR,
          maxWebConns: 8,
          announce: EXTRA_TRACKERS,
        },
        () => {
          fs.unlink(filePath, () => {});
        }
      );

      registerTorrent(torrent);

      res.json({
        ok: true,
        infoHash: torrent.infoHash,
      });
    } catch (err) {
      fs.unlink(filePath, () => {});

      console.error(
        '[TORRENT FILE ERROR]',
        err
      );

      res.status(500).json({
        error: err.message,
      });
    }
  }
);

/*
 * ---------------------------------------------------------
 * API: LIST TORRENTS
 * ---------------------------------------------------------
 */

app.get('/api/torrents', (req, res) => {
  res.json(
    Object.values(torrents).sort(
      (a, b) => b.addedAt - a.addedAt
    )
  );
});

/*
 * ---------------------------------------------------------
 * API: REMOVE TORRENT
 * ---------------------------------------------------------
 */

app.delete(
  '/api/torrents/:infoHash',
  (req, res) => {
    const { infoHash } = req.params;

    const torrent = client.torrents.find(
      (t) => t.infoHash === infoHash
    );

    if (!torrent) {
      return res.status(404).json({
        error: 'Not found',
      });
    }

    torrent.destroy(
      {
        destroyStore: false,
      },
      () => {
        delete torrents[infoHash];

        res.json({
          ok: true,
        });
      }
    );
  }
);

/*
 * ---------------------------------------------------------
 * API: LIST DOWNLOAD FILES
 * ---------------------------------------------------------
 */

app.get('/api/files', (req, res) => {
  try {
    const tree = buildTree(
      DOWNLOAD_DIR
    );

    res.json(tree);
  } catch (err) {
    console.error(
      '[FILES ERROR]',
      err
    );

    res.status(500).json({
      error: err.message,
    });
  }
});

/*
 * ---------------------------------------------------------
 * API: DOWNLOAD
 * ---------------------------------------------------------
 */

app.get(
  '/api/download/:relPath(*)',
  (req, res) => {
    const target = resolveSafePath(
      req.params.relPath
    );

    if (!target) {
      return res.status(400).json({
        error: 'Invalid path.',
      });
    }

    if (!fs.existsSync(target)) {
      return res.status(404).json({
        error: 'File not found.',
      });
    }

    /*
     * Prevent symlink-based path escape.
     */
    if (!isInsideDownloadRealPath(target)) {
      return res.status(403).json({
        error: 'Access denied.',
      });
    }

    let stat;

    try {
      stat = fs.statSync(target);
    } catch {
      return res.status(404).json({
        error: 'File not found.',
      });
    }

    /*
     * -----------------------------------------------------
     * DIRECTORY
     * -----------------------------------------------------
     */

    if (stat.isDirectory()) {
      const zipName =
        path.basename(target) + '.zip';

      res.statusCode = 200;

      res.setHeader(
        'Content-Type',
        'application/zip'
      );

      res.setHeader(
        'Content-Disposition',
        getAttachmentHeader(zipName)
      );

      /*
       * IMPORTANT:
       *
       * Compression level 9 can consume a lot of CPU.
       *
       * Torrent files are frequently already compressed
       * (MP4, MKV, ZIP, RAR, 7z, etc.).
       *
       * Therefore level 0 is considerably faster.
       */
      const archive = archiver(
        'zip',
        {
          zlib: {
            level: 0,
          },
        }
      );

      archive.on(
        'warning',
        (err) => {
          console.warn(
            '[ZIP WARNING]',
            err.message
          );
        }
      );

      archive.on(
        'error',
        (err) => {
          console.error(
            '[ZIP ERROR]',
            err.message
          );

          if (!res.headersSent) {
            res.status(500).end();
          } else {
            res.destroy(err);
          }
        }
      );

      res.on(
        'close',
        () => {
          if (!archive.destroyed) {
            archive.abort();
          }
        }
      );

      archive.pipe(res);

      archive.directory(
        target,
        false
      );

      archive.finalize();

      return;
    }

    /*
     * -----------------------------------------------------
     * REGULAR FILE
     * -----------------------------------------------------
     */

    streamFile(
      req,
      res,
      target
    );
  }
);

/*
 * ---------------------------------------------------------
 * SERVER
 * ---------------------------------------------------------
 */

const server = http.createServer(
  app
);

/*
 * Increase HTTP timeout values for large files.
 *
 * We do not impose a small request timeout because a large
 * torrent file may take a long time to transfer.
 */
server.requestTimeout = 0;
server.headersTimeout = 120000;
server.keepAliveTimeout = 65000;

server.listen(
  PORT,
  () => {
    console.log('');
    console.log(
      '======================================'
    );
    console.log(
      ' Torrent Download Site'
    );
    console.log(
      '======================================'
    );

    console.log(
      `Web server: http://0.0.0.0:${PORT}`
    );

    console.log(
      `Torrent TCP/UDP port: ${TORRENT_PORT}`
    );

    console.log(
      `DHT UDP port: ${TORRENT_PORT + 1}`
    );

    console.log(
      `Download directory: ${DOWNLOAD_DIR}`
    );

    console.log(
      'HTTP large-file streaming: ENABLED'
    );

    console.log(
      'HTTP Range support: ENABLED'
    );

    console.log(
      'ZIP compression: DISABLED for speed'
    );

    console.log(
      '======================================'
    );
    console.log('');
  }
);

/*
 * ---------------------------------------------------------
 * GRACEFUL SHUTDOWN
 * ---------------------------------------------------------
 */

function shutdown(signal) {
  console.log(
    `\n[${signal}] Shutting down...`
  );

  server.close(() => {
    client.destroy(() => {
      console.log(
        'Shutdown complete.'
      );

      process.exit(0);
    });
  });

  /*
   * Do not wait forever for open connections.
   */
  setTimeout(() => {
    process.exit(0);
  }, 10000).unref();
}

process.on(
  'SIGINT',
  () => shutdown('SIGINT')
);

process.on(
  'SIGTERM',
  () => shutdown('SIGTERM')
);
