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

// Rooms: roomCode -> { peers: Map<role, ws>, meta: {} }
// Legacy rooms (streamer/viewer) use the same structure
const rooms = new Map();

function getRoom(roomCode) {
  if (!rooms.has(roomCode)) {
    rooms.set(roomCode, { peers: new Map(), meta: {} });
  }
  return rooms.get(roomCode);
}

function isRoomEmpty(r) {
  return r.peers.size === 0;
}

wss.on('connection', (ws) => {
  let role = null;
  let room = null;

  ws.on('message', (raw, isBinary) => {
    // Binary messages = forward to all other peers in the room
    if (isBinary) {
      if (room && rooms.has(room)) {
        const r = rooms.get(room);
        for (const [peerRole, peerWs] of r.peers) {
          if (peerRole !== role && peerWs.readyState === 1) {
            peerWs.send(raw, { binary: true });
          }
        }
      }
      return;
    }

    try {
      const msg = JSON.parse(raw.toString());

      // Join a room with any role
      if (msg.type === 'join') {
        role = msg.role;
        room = msg.room;

        const r = getRoom(room);
        r.peers.set(role, ws);

        // Save connection info in room meta
        if (msg.localIPs) {
          r.meta[role + 'Info'] = { localIPs: msg.localIPs, streamPort: msg.streamPort };
        }

        console.log(`[relay] ${role} joined room "${room}"${msg.localIPs ? ' IPs: ' + msg.localIPs.join(',') : ''}`);

        // Notify all other peers about the new joiner
        for (const [peerRole, peerWs] of r.peers) {
          if (peerRole !== role && peerWs.readyState === 1) {
            peerWs.send(JSON.stringify({ type: 'peer-joined', role, ...(r.meta[role + 'Info'] || {}) }));
          }
        }

        // Notify the new joiner about all existing peers
        for (const [peerRole, peerWs] of r.peers) {
          if (peerRole !== role && peerWs.readyState === 1) {
            ws.send(JSON.stringify({ type: 'peer-joined', role: peerRole, ...(r.meta[peerRole + 'Info'] || {}) }));
          }
        }
        return;
      }

      // Forward all other messages to all other peers in the room
      if (room && rooms.has(room)) {
        const r = rooms.get(room);
        for (const [peerRole, peerWs] of r.peers) {
          if (peerRole !== role && peerWs.readyState === 1) {
            peerWs.send(raw.toString());
          }
        }
      }
    } catch (e) {
      // ignore bad messages
    }
  });

  ws.on('close', () => {
    if (room && rooms.has(room)) {
      const r = rooms.get(room);
      if (r.peers.get(role) === ws) {
        r.peers.delete(role);
        // Notify all remaining peers
        for (const [peerRole, peerWs] of r.peers) {
          if (peerWs.readyState === 1) {
            peerWs.send(JSON.stringify({ type: 'peer-left', role }));
          }
        }
      }
      // Clean up empty rooms
      if (isRoomEmpty(r)) {
        rooms.delete(room);
      }
    }
    console.log(`[relay] ${role || 'unknown'} disconnected from room "${room || '?'}"`);
  });
});

server.listen(PORT, () => {
  console.log(`[relay] Running on port ${PORT}`);
});
