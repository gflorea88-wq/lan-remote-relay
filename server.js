const { WebSocketServer } = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3900;

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('LAN Remote Relay');
});

const wss = new WebSocketServer({ server });

// Rooms: roomCode -> { streamer: ws, viewer: ws }
const rooms = new Map();

wss.on('connection', (ws) => {
  let role = null;
  let room = null;

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      // Join a room as streamer or viewer
      if (msg.type === 'join') {
        role = msg.role; // 'streamer' or 'viewer'
        room = msg.room;

        if (!rooms.has(room)) {
          rooms.set(room, { streamer: null, viewer: null });
        }
        const r = rooms.get(room);
        r[role] = ws;

        console.log(`[relay] ${role} joined room "${room}"`);

        // Notify the other side if both are connected
        if (r.streamer && r.viewer) {
          r.streamer.send(JSON.stringify({ type: 'peer-joined', role: 'viewer' }));
          r.viewer.send(JSON.stringify({ type: 'peer-joined', role: 'streamer' }));
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
