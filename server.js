const { WebSocketServer } = require('ws');
const http = require('http');
const crypto = require('crypto');
const url = require('url');

const PORT = process.env.PORT || 3900;

// In-memory store for app bundles: { streamer: { manifest, files }, viewer: { manifest, files } }
const bundles = {};

// In-memory log buffer (last 500 entries per app)
const logs = { streamer: [], viewer: [] };
const MAX_LOGS = 500;

// ========================
// HTTP server
// ========================
const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const parts = parsed.pathname.split('/').filter(Boolean);

  // CORS for all endpoints
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Root
  if (parts.length === 0) {
    res.writeHead(200);
    res.end('LAN Remote Relay');
    return;
  }

  // POST /update/publish/:app — upload full bundle
  // Body: JSON { files: { "path": { content: base64, hash: sha256 } } }
  if (req.method === 'POST' && parts[0] === 'update' && parts[1] === 'publish' && parts[2]) {
    const appName = parts[2]; // 'streamer' or 'viewer'
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const manifest = {};
        const files = {};
        for (const [filePath, info] of Object.entries(data.files)) {
          manifest[filePath] = info.hash;
          files[filePath] = Buffer.from(info.content, 'base64');
        }
        bundles[appName] = { manifest, files, version: data.version || Date.now().toString(), updatedAt: new Date().toISOString() };
        console.log(`[update] Published ${appName} v${bundles[appName].version} — ${Object.keys(files).length} files`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, files: Object.keys(files).length, version: bundles[appName].version }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // GET /update/manifest/:app — returns { version, files: { path: hash } }
  if (req.method === 'GET' && parts[0] === 'update' && parts[1] === 'manifest' && parts[2]) {
    const appName = parts[2];
    if (!bundles[appName]) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'no bundle published' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version: bundles[appName].version, files: bundles[appName].manifest }));
    return;
  }

  // GET /update/file/:app/:path... — returns raw file content
  if (req.method === 'GET' && parts[0] === 'update' && parts[1] === 'file' && parts[2]) {
    const appName = parts[2];
    const filePath = parts.slice(3).join('/');
    if (!bundles[appName] || !bundles[appName].files[filePath]) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(bundles[appName].files[filePath]);
    return;
  }

  // POST /logs — receive logs from apps
  // Body: JSON { app: 'streamer'|'viewer', entries: [{ ts, level, msg }] }
  if (req.method === 'POST' && parts[0] === 'logs') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const appName = data.app || 'unknown';
        if (!logs[appName]) logs[appName] = [];
        const entries = data.entries || [{ ts: new Date().toISOString(), level: 'info', msg: data.msg || body }];
        for (const entry of entries) {
          logs[appName].push({ ...entry, receivedAt: new Date().toISOString() });
          console.log(`[log:${appName}] ${entry.level || 'info'}: ${entry.msg}`);
        }
        // Trim old entries
        while (logs[appName].length > MAX_LOGS) logs[appName].shift();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // GET /logs/:app — view logs
  if (req.method === 'GET' && parts[0] === 'logs') {
    const appName = parts[1] || 'all';
    if (appName === 'all') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(logs));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(logs[appName] || []));
    }
    return;
  }

  // GET /update/status — check what's published
  if (req.method === 'GET' && parts[0] === 'update' && parts[1] === 'status') {
    const status = {};
    for (const [app, bundle] of Object.entries(bundles)) {
      status[app] = { version: bundle.version, files: Object.keys(bundle.manifest).length, updatedAt: bundle.updatedAt };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

// ========================
// WebSocket relay
// ========================
const wss = new WebSocketServer({ server });

// Rooms: roomCode -> { streamer: ws, viewer: ws }
const rooms = new Map();

wss.on('connection', (ws) => {
  let role = null;
  let room = null;

  ws.on('message', (raw, isBinary) => {
    // Binary messages = video chunks, forward directly
    if (isBinary) {
      if (room && rooms.has(room)) {
        const r = rooms.get(room);
        const target = role === 'streamer' ? r.viewer : r.streamer;
        if (target && target.readyState === 1) {
          target.send(raw, { binary: true });
        }
      }
      return;
    }

    try {
      const msg = JSON.parse(raw.toString());

      // Join a room as streamer or viewer
      if (msg.type === 'join') {
        role = msg.role; // 'streamer' or 'viewer'
        room = msg.room;

        if (!rooms.has(room)) {
          rooms.set(room, { streamer: null, viewer: null, streamerInfo: null });
        }
        const r = rooms.get(room);
        r[role] = ws;

        // Save streamer's connection info for viewers
        if (role === 'streamer' && msg.localIPs) {
          r.streamerInfo = { localIPs: msg.localIPs, streamPort: msg.streamPort };
        }

        console.log(`[relay] ${role} joined room "${room}"${msg.localIPs ? ' IPs: ' + msg.localIPs.join(',') : ''}`);

        // Notify the other side if both are connected
        if (r.streamer && r.viewer) {
          r.streamer.send(JSON.stringify({ type: 'peer-joined', role: 'viewer' }));
          // Send streamer's LAN info to viewer so it can connect directly
          r.viewer.send(JSON.stringify({
            type: 'peer-joined', role: 'streamer',
            ...(r.streamerInfo || {})
          }));
        }
        return;
      }

      // Forward all other messages to the other peer
      if (room && rooms.has(room)) {
        const r = rooms.get(room);
        const target = role === 'streamer' ? r.viewer : r.streamer;
        if (target && target.readyState === 1) {
          target.send(raw.toString());
        }
      }
    } catch (e) {
      // ignore bad messages
    }
  });

  ws.on('close', () => {
    if (room && rooms.has(room)) {
      const r = rooms.get(room);
      if (r[role] === ws) {
        r[role] = null;
        // Notify other peer
        const other = role === 'streamer' ? r.viewer : r.streamer;
        if (other && other.readyState === 1) {
          other.send(JSON.stringify({ type: 'peer-left', role }));
        }
      }
      // Clean up empty rooms
      if (!r.streamer && !r.viewer) {
        rooms.delete(room);
      }
    }
    console.log(`[relay] ${role || 'unknown'} disconnected from room "${room || '?'}"`);
  });
});

server.listen(PORT, () => {
  console.log(`[relay] Running on port ${PORT}`);
});
