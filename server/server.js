const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, "..");
const ROWS = 7;
const COLS = 7;
const RED = 1;
const GREEN = -1;
const BLUE = 3;
const YELLOW = 4;
const PLAYERS_4 = [RED, GREEN, BLUE, YELLOW];

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

const MAX_ORBS = 8;

function isUnstable(board, row, col) {
  return board[row][col].count >= 4;
}

function explode(board, row, col, player) {
  const count = board[row][col].count;
  const orbsPerNeighbor = count - 3;
  board[row][col].count = 0;
  board[row][col].owner = 0;
  for (const [r, c] of neighbors(row, col)) {
    board[r][c].count = Math.min(MAX_ORBS, board[r][c].count + orbsPerNeighbor);
    board[r][c].owner = player;
  }
}

function resolve(board, player, getWinner) {
  let changed = true;
  while (changed) {
    changed = false;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (isUnstable(board, r, c)) {
          explode(board, r, c, player);
          changed = true;
          if (getWinner) {
            const w = getWinner();
            if (w !== 0) return w;
          }
        }
      }
    }
  }
  return 0;
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

// --- 2-player AI (simple heuristic) ---
const TURN_TIME_SEC = 300; // 5 minutes
function getValidMoves2(board, player) {
  const moves = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (board[r][c].owner === player) moves.push([r, c]);
    }
  }
  return moves;
}
function getAIMove2(board, player) {
  const moves = getValidMoves2(board, player);
  if (moves.length === 0) return null;
  const opponent = player === RED ? GREEN : RED;
  let best = moves[0];
  let bestScore = -1;
  for (const [r, c] of moves) {
    let s = board[r][c].count * 4 + (board[r][c].count === 3 ? 8 : 0);
    if (r > 0 && board[r - 1][c].owner === opponent) s += 6;
    if (r < ROWS - 1 && board[r + 1][c].owner === opponent) s += 6;
    if (c > 0 && board[r][c - 1].owner === opponent) s += 6;
    if (c < COLS - 1 && board[r][c + 1].owner === opponent) s += 6;
    if (s > bestScore) { bestScore = s; best = [r, c]; }
  }
  return best;
}

// --- 4-player game logic ---
function createBoard4() {
  const board = Array(ROWS).fill(null).map(() =>
    Array(COLS).fill(null).map(() => ({ count: 0, owner: 0 }))
  );
  board[1][1] = { count: 1, owner: RED };
  board[1][5] = { count: 1, owner: GREEN };
  board[5][1] = { count: 1, owner: BLUE };
  board[5][5] = { count: 1, owner: YELLOW };
  return board;
}

function countOrbsByPlayer4(board) {
  const counts = { [RED]: 0, [GREEN]: 0, [BLUE]: 0, [YELLOW]: 0 };
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const owner = board[r][c].owner;
      if (owner !== 0) counts[owner] = (counts[owner] || 0) + board[r][c].count;
    }
  }
  return counts;
}

function gameOver4(board) {
  const counts = countOrbsByPlayer4(board);
  const survivors = PLAYERS_4.filter((p) => counts[p] > 0);
  return survivors.length === 1 ? survivors[0] : 0;
}

function nextPlayerIndex4(room) {
  const counts = countOrbsByPlayer4(room.board);
  for (let i = 1; i <= 4; i++) {
    const idx = (room.currentPlayerIndex + i) % 4;
    if (counts[PLAYERS_4[idx]] > 0) return idx;
  }
  return (room.currentPlayerIndex + 1) % 4;
}

function getPlayerId4(room, socketId) {
  for (let i = 1; i <= 4; i++) {
    if (room.players[i] === socketId) return PLAYERS_4[i - 1];
  }
  return null;
}

// --- Rooms ---
const rooms = new Map(); // roomCode -> { mode, board, currentPlayer|currentPlayerIndex, players, ... }
function randomCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

// --- Matchmaking queue (2-player) ---
const matchmakingQueue = [];
function removeFromQueue(socketId) {
  const i = matchmakingQueue.indexOf(socketId);
  if (i !== -1) matchmakingQueue.splice(i, 1);
}

// --- Matchmaking queue (4-player) ---
const matchmakingQueue4 = [];
function removeFromQueue4(socketId) {
  const i = matchmakingQueue4.indexOf(socketId);
  if (i !== -1) matchmakingQueue4.splice(i, 1);
}
function matchFourPlayers(io) {
  if (matchmakingQueue4.length < 4) return;
  const ids = matchmakingQueue4.splice(0, 4);
  let code = randomCode();
  while (rooms.has(code)) code = randomCode();
  const board = createBoard4();
  const room = {
    mode: "4player",
    board,
    currentPlayerIndex: 0,
    players: { 1: ids[0], 2: ids[1], 3: ids[2], 4: ids[3] },
  };
  rooms.set(code, room);
  for (let i = 0; i < 4; i++) {
    const sock = io.sockets.sockets.get(ids[i]);
    if (sock) {
      sock.join(code);
      sock.emit("matched", { code, player: PLAYERS_4[i], mode: "4player" });
      sock.emit("gameState", {
        board: JSON.parse(JSON.stringify(room.board)),
        currentPlayerIndex: 0,
        winner: 0,
        mode: "4player",
      });
    }
  }
  io.to(code).emit("playerJoined", { count: 4, player: null });
}
function getGameState2(room) {
  return {
    board: JSON.parse(JSON.stringify(room.board)),
    currentPlayer: room.currentPlayer,
    winner: room.winner || 0,
    redTimeRemaining: room.redTimeRemaining,
    greenTimeRemaining: room.greenTimeRemaining,
    turnStartTime: room.turnStartTime,
    redIsAI: room.redIsAI || false,
    greenIsAI: room.greenIsAI || false,
    playersReady: !!room.players.green,
  };
}

function emitGameState2(io, roomCode, room) {
  io.to(roomCode).emit("gameState", getGameState2(room));
}

function scheduleTurnTimeout(io, roomCode, room) {
  if (room.turnTimeoutId) clearTimeout(room.turnTimeoutId);
  const cp = room.currentPlayer;
  const timeRemaining = cp === RED ? room.redTimeRemaining : room.greenTimeRemaining;
  const isAI = (cp === RED && room.redIsAI) || (cp === GREEN && room.greenIsAI);
  if (room.winner || timeRemaining <= 0) return;
  if (isAI) {
    room.turnTimeoutId = setTimeout(() => runAITurn(io, roomCode, room), 400);
  } else {
    room.turnTimeoutId = setTimeout(() => onTimeExpired(io, roomCode, room), timeRemaining * 1000);
  }
}

function onTimeExpired(io, roomCode, room) {
  if (!room || room.winner) return;
  room.turnTimeoutId = null;
  const cp = room.currentPlayer;
  if (cp === RED) {
    room.redIsAI = true;
    room.redTimeRemaining = 0;
  } else {
    room.greenIsAI = true;
    room.greenTimeRemaining = 0;
  }
  io.to(roomCode).emit("playerTimedOut", { player: cp });
  runAITurn(io, roomCode, room);
}

function runAITurn(io, roomCode, room) {
  if (!room || room.winner) return;
  room.turnTimeoutId = null;
  const cp = room.currentPlayer;
  const isAI = (cp === RED && room.redIsAI) || (cp === GREEN && room.greenIsAI);
  if (!isAI) return;
  const move = getAIMove2(room.board, cp);
  if (!move) {
    room.currentPlayer = cp === RED ? GREEN : RED;
    room.turnStartTime = Date.now();
    emitGameState2(io, roomCode, room);
    scheduleTurnTimeout(io, roomCode, room);
    return;
  }
  const [row, col] = move;
  makeMove(room.board, row, col, cp);
  if (cp === RED) room.redHasPlayed = true;
  else room.greenHasPlayed = true;
  const winner = resolve(room.board, cp, () => gameOver(room.board, room.redHasPlayed, room.greenHasPlayed))
    || gameOver(room.board, room.redHasPlayed, room.greenHasPlayed);
  if (winner) {
    room.winner = winner;
    if (room.turnTimeoutId) clearTimeout(room.turnTimeoutId);
    room.turnTimeoutId = null;
  } else {
    room.currentPlayer = cp === RED ? GREEN : RED;
    room.turnStartTime = Date.now();
    scheduleTurnTimeout(io, roomCode, room);
  }
  emitGameState2(io, roomCode, room);
  if (winner) setTimeout(() => rooms.delete(roomCode), 5000);
}

function matchTwoPlayers(io) {
  if (matchmakingQueue.length < 2) return;
  const id1 = matchmakingQueue.shift();
  const id2 = matchmakingQueue.shift();
  let code = randomCode();
  while (rooms.has(code)) code = randomCode();
  const board = createBoard();
  const room = {
    mode: "2player",
    board,
    currentPlayer: RED,
    redHasPlayed: true,
    greenHasPlayed: true,
    players: { red: id1, green: id2 },
    redTimeRemaining: TURN_TIME_SEC,
    greenTimeRemaining: TURN_TIME_SEC,
    turnStartTime: Date.now(),
    turnTimeoutId: null,
    redIsAI: false,
    greenIsAI: false,
  };
  rooms.set(code, room);
  const sock1 = io.sockets.sockets.get(id1);
  const sock2 = io.sockets.sockets.get(id2);
  if (sock1) {
    sock1.join(code);
    sock1.emit("matched", { code, player: RED });
  }
  if (sock2) {
    sock2.join(code);
    sock2.emit("matched", { code, player: GREEN });
  }
  emitGameState2(io, code, room);
  scheduleTurnTimeout(io, code, room);
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
    <li><a href="/Four%20player%20vs%20AI.html">Four Player vs AI</a></li>
    <li><strong><a href="/Online%20Multiplayer.html">Online Multiplayer (2 players)</a></strong></li>
    <li><strong><a href="/Online%20Multiplayer%204%20Player.html">Online Multiplayer (4 players)</a></strong></li>
  </ul>
</body>
</html>`);
});

io.on("connection", (socket) => {
  socket.on("createRoom", () => {
    let code = randomCode();
    while (rooms.has(code)) code = randomCode();

    const board = createBoard();
    const room = {
      mode: "2player",
      board,
      currentPlayer: RED,
      redHasPlayed: true,
      greenHasPlayed: true,
      players: { red: socket.id, green: null },
      redTimeRemaining: TURN_TIME_SEC,
      greenTimeRemaining: TURN_TIME_SEC,
      turnStartTime: Date.now(),
      turnTimeoutId: null,
      redIsAI: false,
      greenIsAI: false,
    };
    rooms.set(code, room);

    socket.join(code);
    socket.emit("roomCreated", { code, player: RED });
    emitGameState2(io, code, room);
  });

  socket.on("findMatch", () => {
    if (matchmakingQueue.includes(socket.id)) return;
    matchmakingQueue.push(socket.id);
    socket.emit("matchmakingStatus", { searching: true, position: matchmakingQueue.length });
    if (matchmakingQueue.length >= 2) matchTwoPlayers(io);
  });

  socket.on("cancelMatchmaking", () => {
    removeFromQueue(socket.id);
    socket.emit("matchmakingStatus", { searching: false });
  });

  socket.on("findMatch4", () => {
    if (matchmakingQueue4.includes(socket.id)) return;
    matchmakingQueue4.push(socket.id);
    socket.emit("matchmakingStatus", { searching: true, position: matchmakingQueue4.length, mode: "4player" });
    if (matchmakingQueue4.length >= 4) matchFourPlayers(io);
  });

  socket.on("cancelMatchmaking4", () => {
    removeFromQueue4(socket.id);
    socket.emit("matchmakingStatus", { searching: false, mode: "4player" });
  });

  socket.on("joinRoom", (code) => {
    const roomCode = String(code).toUpperCase().trim();
    const room = rooms.get(roomCode);

    if (!room || room.mode !== "2player") {
      socket.emit("joinError", "Room not found");
      return;
    }
    if (room.players.red === socket.id) {
      socket.emit("joinError", "You created this room. Share the code with a friend to join.");
      return;
    }
    if (room.players.green === socket.id) {
      socket.emit("joinedRoom", { code: roomCode, player: GREEN });
      socket.emit("gameState", getGameState2(room));
      return;
    }
    if (room.players.green) {
      socket.emit("joinError", "Room is full");
      return;
    }

    room.players.green = socket.id;
    room.turnStartTime = Date.now();
    socket.join(roomCode);
    socket.emit("joinedRoom", { code: roomCode, player: GREEN });
    io.to(roomCode).emit("gameState", getGameState2(room));
    io.to(roomCode).emit("playerJoined");
    scheduleTurnTimeout(io, roomCode, room);
  });

  socket.on("createRoom4", () => {
    let code = randomCode();
    while (rooms.has(code)) code = randomCode();

    const board = createBoard4();
    rooms.set(code, {
      mode: "4player",
      board,
      currentPlayerIndex: 0,
      players: { 1: socket.id, 2: null, 3: null, 4: null },
    });

    socket.join(code);
    socket.emit("roomCreated", { code, player: RED, mode: "4player" });
    socket.emit("gameState", {
      board: JSON.parse(JSON.stringify(board)),
      currentPlayerIndex: 0,
      winner: 0,
      mode: "4player",
    });
  });

  socket.on("joinRoom4", (code) => {
    const roomCode = String(code).toUpperCase().trim();
    const room = rooms.get(roomCode);

    if (!room || room.mode !== "4player") {
      socket.emit("joinError", "Room not found");
      return;
    }
    const slot = [null, 1, 2, 3, 4].find((i) => i !== null && room.players[i] === socket.id);
    if (slot !== undefined && slot !== null) {
      const playerId = PLAYERS_4[slot - 1];
      socket.emit("joinedRoom", { code: roomCode, player: playerId, mode: "4player" });
      socket.emit("gameState", {
        board: JSON.parse(JSON.stringify(room.board)),
        currentPlayerIndex: room.currentPlayerIndex,
        winner: room.winner || 0,
        mode: "4player",
      });
      return;
    }

    const firstFree = [2, 3, 4].find((i) => !room.players[i]);
    if (!firstFree) {
      socket.emit("joinError", "Room is full (4/4 players)");
      return;
    }

    const playerId = PLAYERS_4[firstFree - 1];
    room.players[firstFree] = socket.id;
    socket.join(roomCode);
    socket.emit("joinedRoom", { code: roomCode, player: playerId, mode: "4player" });
    socket.emit("gameState", {
      board: JSON.parse(JSON.stringify(room.board)),
      currentPlayerIndex: room.currentPlayerIndex,
      winner: 0,
      mode: "4player",
    });

    const count = [1, 2, 3, 4].filter((i) => room.players[i]).length;
    io.to(roomCode).emit("playerJoined", { count, player: playerId });
  });

  socket.on("move", ({ code, row, col }) => {
    const roomCode = String(code).toUpperCase().trim();
    const room = rooms.get(roomCode);
    if (!room || !room.board) return;

    if (room.mode === "4player") {
      const player = getPlayerId4(room, socket.id);
      if (player === null) return;
      if (PLAYERS_4[room.currentPlayerIndex] !== player) return;

      if (!makeMove(room.board, row, col, player)) return;

      const winner = resolve(room.board, player, () => gameOver4(room.board)) || gameOver4(room.board);

      if (winner !== 0) {
        room.winner = winner;
      } else {
        room.currentPlayerIndex = nextPlayerIndex4(room);
      }

      const state = {
        board: JSON.parse(JSON.stringify(room.board)),
        currentPlayerIndex: room.currentPlayerIndex,
        winner: winner || 0,
        mode: "4player",
      };
      io.to(roomCode).emit("gameState", state);

      if (winner !== 0) {
        setTimeout(() => rooms.delete(roomCode), 5000);
      }
      return;
    }

    const player = room.players.red === socket.id ? RED : room.players.green === socket.id ? GREEN : null;
    if (player === null) return;
    if (room.currentPlayer !== player) return;
    if ((player === RED && room.redIsAI) || (player === GREEN && room.greenIsAI)) return;

    if (room.turnTimeoutId) {
      clearTimeout(room.turnTimeoutId);
      room.turnTimeoutId = null;
    }
    const now = Date.now();
    const elapsed = (now - room.turnStartTime) / 1000;
    const timeRemaining = player === RED ? room.redTimeRemaining - elapsed : room.greenTimeRemaining - elapsed;
    if (player === RED) room.redTimeRemaining = Math.max(0, timeRemaining);
    else room.greenTimeRemaining = Math.max(0, timeRemaining);

    if (timeRemaining <= 0) {
      if (player === RED) room.redIsAI = true;
      else room.greenIsAI = true;
      io.to(roomCode).emit("playerTimedOut", { player });
      runAITurn(io, roomCode, room);
      return;
    }

    if (!makeMove(room.board, row, col, player)) return;

    if (player === RED) room.redHasPlayed = true;
    else room.greenHasPlayed = true;

    const winner = resolve(room.board, player, () => gameOver(room.board, room.redHasPlayed, room.greenHasPlayed))
      || gameOver(room.board, room.redHasPlayed, room.greenHasPlayed);

    if (winner !== 0) {
      room.winner = winner;
      if (room.turnTimeoutId) clearTimeout(room.turnTimeoutId);
      room.turnTimeoutId = null;
    } else {
      room.currentPlayer = player === RED ? GREEN : RED;
      room.turnStartTime = Date.now();
      scheduleTurnTimeout(io, roomCode, room);
    }

    emitGameState2(io, roomCode, room);

    if (winner !== 0) {
      setTimeout(() => rooms.delete(roomCode), 5000);
    }
  });

  socket.on("disconnect", () => {
    removeFromQueue(socket.id);
    removeFromQueue4(socket.id);
    for (const [code, room] of rooms) {
      if (room.mode === "4player") {
        const player = getPlayerId4(room, socket.id);
        if (player !== null) {
          io.to(code).emit("playerLeft", { player });
          rooms.delete(code);
          break;
        }
      } else if (room.players.red === socket.id || room.players.green === socket.id) {
        if (room.turnTimeoutId) clearTimeout(room.turnTimeoutId);
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
