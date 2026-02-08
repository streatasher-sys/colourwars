const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const PORT = 3000;
const ROOT = path.join(__dirname, "..");
const ROWS = 7;
const COLS = 7;
const RED = 1;
const GREEN = -1;

// --- Game logic (server-side) ---
function neighbors(row, col) {
  const result = [];
  if (row > 0) result.push([row - 1, col]);
  if (row < ROWS - 1) result.push([row + 1, col]);
  if (col > 0) result.push([row, col - 1]);
  if (col < COLS - 1) result.push([row, col + 1]);
  return result;
}

function createBoard() {
  const board = Array(ROWS).fill(null).map(() =>
    Array(COLS).fill(null).map(() => ({ count: 0, owner: 0 }))
  );
  board[1][1] = { count: 1, owner: RED };
  board[5][5] = { count: 1, owner: GREEN };
  return board;
}

function isUnstable(board, row, col) {
  return board[row][col].count >= 4;
}

function explode(board, row, col, player) {
  const count = board[row][col].count;
  const orbsPerNeighbor = count - 3;
  board[row][col].count = 0;
  board[row][col].owner = 0;
  for (const [r, c] of neighbors(row, col)) {
    board[r][c].count += orbsPerNeighbor;
    board[r][c].owner = player;
  }
}

function resolve(board, player) {
  let changed = true;
  while (changed) {
    changed = false;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (isUnstable(board, r, c)) {
          explode(board, r, c, player);
          changed = true;
        }
      }
    }
  }
}

function makeMove(board, row, col, player) {
  if (row < 0 || row >= ROWS || col < 0 || col >= COLS) return false;
  if (board[row][col].owner !== player) return false;
  board[row][col].count += 1;
  board[row][col].owner = player;
  return true;
}

function gameOver(board, redHasPlayed, greenHasPlayed) {
  let redOrbs = 0, greenOrbs = 0;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (board[r][c].owner === RED) redOrbs += board[r][c].count;
      if (board[r][c].owner === GREEN) greenOrbs += board[r][c].count;
    }
  }
  if (redOrbs > 0 && greenOrbs === 0 && greenHasPlayed) return RED;
  if (greenOrbs > 0 && redOrbs === 0 && redHasPlayed) return GREEN;
  return 0;
}

// --- Rooms ---
const rooms = new Map(); // roomCode -> { board, currentPlayer, redHasPlayed, greenHasPlayed, players: { red: socketId, green: socketId } }
function randomCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

// --- Express + Socket.io ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(ROOT));

app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head><title>Colour Wars</title></head>
<body style="font-family: sans-serif; max-width: 400px; margin: 50px auto; padding: 20px;">
  <h1>Colour Wars</h1>
  <ul>
    <li><a href="/Single%20player%20colour%20wars.html">Single Player</a></li>
    <li><a href="/Single%20player%20colour%20wars%20-%20Hard%20AI.html">Single Player (Hard AI)</a></li>
    <li><a href="/Two%20player%20colour%20wars.html">Two Player (Local)</a></li>
    <li><a href="/Four%20player%20colour%20wars.html">Four Player</a></li>
    <li><strong><a href="/Online%20Multiplayer.html">Online Multiplayer</a></strong></li>
  </ul>
</body>
</html>`);
});

io.on("connection", (socket) => {
  socket.on("createRoom", () => {
    let code = randomCode();
    while (rooms.has(code)) code = randomCode();

    const board = createBoard();
    rooms.set(code, {
      board,
      currentPlayer: RED,
      redHasPlayed: true,
      greenHasPlayed: true,
      players: { red: socket.id, green: null },
    });

    socket.join(code);
    socket.emit("roomCreated", { code, player: RED });
    socket.emit("gameState", {
      board: JSON.parse(JSON.stringify(board)),
      currentPlayer: RED,
      winner: 0,
    });
  });

  socket.on("joinRoom", (code) => {
    const roomCode = String(code).toUpperCase().trim();
    const room = rooms.get(roomCode);

    if (!room) {
      socket.emit("joinError", "Room not found");
      return;
    }
    if (room.players.red === socket.id) {
      socket.emit("joinError", "You created this room. Share the code with a friend to join.");
      return;
    }
    if (room.players.green === socket.id) {
      socket.emit("joinedRoom", { code: roomCode, player: GREEN });
      socket.emit("gameState", {
        board: JSON.parse(JSON.stringify(room.board)),
        currentPlayer: room.currentPlayer,
        winner: room.winner || 0,
      });
      return;
    }
    if (room.players.green) {
      socket.emit("joinError", "Room is full");
      return;
    }

    room.players.green = socket.id;
    socket.join(roomCode);
    socket.emit("joinedRoom", { code: roomCode, player: GREEN });
    socket.emit("gameState", {
      board: JSON.parse(JSON.stringify(room.board)),
      currentPlayer: room.currentPlayer,
      winner: 0,
    });

    io.to(roomCode).emit("playerJoined");
  });

  socket.on("move", ({ code, row, col }) => {
    const roomCode = String(code).toUpperCase().trim();
    const room = rooms.get(roomCode);
    if (!room || !room.board) return;

    const player = room.players.red === socket.id ? RED : room.players.green === socket.id ? GREEN : null;
    if (player === null) return;
    if (room.currentPlayer !== player) return;

    if (!makeMove(room.board, row, col, player)) return;

    if (player === RED) room.redHasPlayed = true;
    else room.greenHasPlayed = true;

    resolve(room.board, player);
    const winner = gameOver(room.board, room.redHasPlayed, room.greenHasPlayed);

    if (winner !== 0) {
      room.winner = winner;
    } else {
      room.currentPlayer = -room.currentPlayer;
    }

    const state = {
      board: JSON.parse(JSON.stringify(room.board)),
      currentPlayer: room.currentPlayer,
      winner: winner || 0,
    };
    io.to(roomCode).emit("gameState", state);

    if (winner !== 0) {
      setTimeout(() => rooms.delete(roomCode), 5000);
    }
  });

  socket.on("disconnect", () => {
    for (const [code, room] of rooms) {
      if (room.players.red === socket.id || room.players.green === socket.id) {
        io.to(code).emit("opponentLeft");
        rooms.delete(code);
        break;
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log("Open in browser to play Colour Wars!");
});
