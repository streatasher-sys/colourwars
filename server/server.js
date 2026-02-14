require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");
const auth = require("./auth");
const db = require("./db");
const rating = require("./rating");

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

function recordEliminations4(room) {
  const counts = countOrbsByPlayer4(room.board);
  const alreadyEliminated = new Set((room.eliminationOrder || []).flat());
  const newlyEliminated = PLAYERS_4.filter((p) => counts[p] === 0 && !alreadyEliminated.has(p));
  if (newlyEliminated.length > 0) {
    if (!room.eliminationOrder) room.eliminationOrder = [];
    room.eliminationOrder.push(newlyEliminated);
  }
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

// --- 4-player AI (simple heuristic) ---
function getAIMove4(board, player) {
  const moves = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (board[r][c].owner === player) moves.push([r, c]);
    }
  }
  if (moves.length === 0) return null;
  const opponents = PLAYERS_4.filter((p) => p !== player);
  let best = moves[0];
  let bestScore = -1;
  for (const [r, c] of moves) {
    let s = board[r][c].count * 4 + (board[r][c].count === 3 ? 8 : 0);
    for (const opp of opponents) {
      if (r > 0 && board[r - 1][c].owner === opp) s += 6;
      if (r < ROWS - 1 && board[r + 1][c].owner === opp) s += 6;
      if (c > 0 && board[r][c - 1].owner === opp) s += 6;
      if (c < COLS - 1 && board[r][c + 1].owner === opp) s += 6;
    }
    if (s > bestScore) { bestScore = s; best = [r, c]; }
  }
  return best;
}

function getGameState4(room) {
  return {
    board: JSON.parse(JSON.stringify(room.board)),
    currentPlayerIndex: room.currentPlayerIndex ?? 0,
    winner: room.winner || 0,
    playerTimeRemaining: room.playerTimeRemaining ? { ...room.playerTimeRemaining } : null,
    playerIsAI: room.playerIsAI ? { ...room.playerIsAI } : null,
    playerNames: room.playerNames ? { ...room.playerNames } : {},
    turnStartTime: room.turnStartTime ?? Date.now(),
    playersReady: room.playersReady || false,
    mode: "4player",
  };
}

function scheduleTurnTimeout4(io, roomCode, room) {
  if (room.turnTimeoutId) clearTimeout(room.turnTimeoutId);
  const cp = PLAYERS_4[room.currentPlayerIndex];
  const slot = room.currentPlayerIndex + 1;
  const timeRemaining = (room.playerTimeRemaining && room.playerTimeRemaining[cp]) ?? TURN_TIME_SEC;
  const isAI = room.playerIsAI && room.playerIsAI[cp];
  if (room.winner || timeRemaining <= 0) return;
  if (isAI) {
    room.turnTimeoutId = setTimeout(() => runAITurn4(io, roomCode, room), 400);
  } else {
    room.turnTimeoutId = setTimeout(() => onTimeExpired4(io, roomCode, room), timeRemaining * 1000);
  }
}

function onTimeExpired4(io, roomCode, room) {
  if (!room || room.winner) return;
  room.turnTimeoutId = null;
  const cp = PLAYERS_4[room.currentPlayerIndex];
  if (!room.playerIsAI) room.playerIsAI = {};
  room.playerIsAI[cp] = true;
  if (room.playerTimeRemaining) room.playerTimeRemaining[cp] = 0;
  io.to(roomCode).emit("playerTimedOut", { player: cp });
  runAITurn4(io, roomCode, room);
}

function runAITurn4(io, roomCode, room) {
  if (!room || room.winner) return;
  room.turnTimeoutId = null;
  const cp = PLAYERS_4[room.currentPlayerIndex];
  const isAI = room.playerIsAI && room.playerIsAI[cp];
  if (!isAI) return;
  const move = getAIMove4(room.board, cp);
  if (!move) {
    room.currentPlayerIndex = nextPlayerIndex4(room);
    room.turnStartTime = Date.now();
    scheduleTurnTimeout4(io, roomCode, room);
    io.to(roomCode).emit("gameState", getGameState4(room));
    return;
  }
  const [row, col] = move;
  makeMove(room.board, row, col, cp);
  const winner = resolve(room.board, cp, () => gameOver4(room.board)) || gameOver4(room.board);
  recordEliminations4(room);
  if (winner !== 0) {
    room.winner = winner;
    if (room.turnTimeoutId) clearTimeout(room.turnTimeoutId);
    room.turnTimeoutId = null;
  } else {
    room.currentPlayerIndex = nextPlayerIndex4(room);
    room.turnStartTime = Date.now();
    scheduleTurnTimeout4(io, roomCode, room);
  }
  io.to(roomCode).emit("gameState", getGameState4(room));
  if (winner !== 0) {
    apply4PlayerRatingUpdates(io, roomCode, room);
    setTimeout(() => rooms.delete(roomCode), 5000);
  }
}

function getPlayerId4(room, socketId) {
  for (let i = 1; i <= 4; i++) {
    if (room.players[i] === socketId) return PLAYERS_4[i - 1];
  }
  return null;
}

async function getUsernameForUserId(userId) {
  if (!userId) return "Guest";
  try {
    const user = await db.findUserById(userId);
    return user ? user.username : "Guest";
  } catch (e) {
    return "Guest";
  }
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
async function matchFourPlayers(io) {
  if (matchmakingQueue4.length < 4) return;
  const ids = matchmakingQueue4.splice(0, 4);
  let code = randomCode();
  while (rooms.has(code)) code = randomCode();
  const board = createBoard4();
  const socks = ids.map((id) => io.sockets.sockets.get(id));
  const names = await Promise.all(socks.map((s) => getUsernameForUserId(s?.userId)));
  const room = {
    mode: "4player",
    board,
    currentPlayerIndex: 0,
    players: { 1: ids[0], 2: ids[1], 3: ids[2], 4: ids[3] },
    playerUserIds: {
      1: socks[0]?.userId || null,
      2: socks[1]?.userId || null,
      3: socks[2]?.userId || null,
      4: socks[3]?.userId || null,
    },
    playerNames: {
      [RED]: names[0],
      [GREEN]: names[1],
      [BLUE]: names[2],
      [YELLOW]: names[3],
    },
    eliminationOrder: [],
    playerTimeRemaining: { [RED]: TURN_TIME_SEC, [GREEN]: TURN_TIME_SEC, [BLUE]: TURN_TIME_SEC, [YELLOW]: TURN_TIME_SEC },
    playerIsAI: {},
    turnStartTime: Date.now(),
    turnTimeoutId: null,
    playersReady: true,
  };
  rooms.set(code, room);
  for (let i = 0; i < 4; i++) {
    const sock = socks[i];
    if (sock) {
      sock.join(code);
      sock.emit("matched", { code, player: PLAYERS_4[i], mode: "4player" });
      sock.emit("gameState", getGameState4(room));
    }
  }
  scheduleTurnTimeout4(io, code, room);
  io.to(code).emit("playerJoined", { count: 4, player: null });
}
function getGameState2(room) {
  return {
    board: JSON.parse(JSON.stringify(room.board)),
    currentPlayer: room.currentPlayer,
    winner: room.winner || 0,
    redTimeRemaining: room.redTimeRemaining,
    greenTimeRemaining: room.greenTimeRemaining,
    playerNames: room.playerNames ? { ...room.playerNames } : {},
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

async function matchTwoPlayers(io) {
  if (matchmakingQueue.length < 2) return;
  const id1 = matchmakingQueue.shift();
  const id2 = matchmakingQueue.shift();
  let code = randomCode();
  while (rooms.has(code)) code = randomCode();
  const board = createBoard();
  const sock1 = io.sockets.sockets.get(id1);
  const sock2 = io.sockets.sockets.get(id2);
  const [redName, greenName] = await Promise.all([
    getUsernameForUserId(sock1?.userId),
    getUsernameForUserId(sock2?.userId),
  ]);
  const room = {
    mode: "2player",
    board,
    currentPlayer: RED,
    redHasPlayed: true,
    greenHasPlayed: true,
    players: { red: id1, green: id2 },
    playerNames: { [RED]: redName, [GREEN]: greenName },
    redTimeRemaining: TURN_TIME_SEC,
    greenTimeRemaining: TURN_TIME_SEC,
    turnStartTime: Date.now(),
    turnTimeoutId: null,
    redIsAI: false,
    greenIsAI: false,
  };
  rooms.set(code, room);
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

function apply4PlayerRatingUpdates(io, roomCode, room) {
  const playerUserIds = room.playerUserIds || {};
  const slotUserIds = [1, 2, 3, 4].map((slot) => playerUserIds[slot] || null);
  const loggedInIds = slotUserIds.filter(Boolean);
  if (loggedInIds.length === 0) {
    io.to(roomCode).emit("ratingResults", { winner: room.winner, results: [] });
    return;
  }
  const winner = room.winner;
  const winnerIdx = PLAYERS_4.indexOf(winner);
  const eliminationOrder = room.eliminationOrder || [];
  const reversed = eliminationOrder.slice().reverse();
  const tiedGroups = [[winnerIdx], ...reversed.map((g) => g.map((pid) => PLAYERS_4.indexOf(pid)))];
  const placementOrder = [winnerIdx, ...reversed.flat().map((pid) => PLAYERS_4.indexOf(pid))];
  const playerNames = room.playerNames || {};
  db.getRatingsForUserIds(loggedInIds)
    .then((fetchedRatings) => {
      const byUserId = {};
      loggedInIds.forEach((uid, i) => { byUserId[uid] = fetchedRatings[i]; });
      const avgRating = Math.round(
        fetchedRatings.reduce((a, b) => a + b, 0) / fetchedRatings.length
      );
      const ratings = slotUserIds.map((uid) => (uid ? byUserId[uid] : avgRating));
      const deltas = rating.computeRatingChanges(placementOrder, ratings, tiedGroups);
      const results = placementOrder.map((idx) => {
        const oldRating = ratings[idx];
        const delta = deltas[idx];
        const newRating = Math.max(0, oldRating + delta);
        return {
          playerId: PLAYERS_4[idx],
          username: playerNames[PLAYERS_4[idx]] || "Guest",
          oldRating,
          newRating,
          delta,
        };
      });
      const updates = slotUserIds
        .map((uid, i) => (uid ? db.updateUserRating(uid, deltas[i]) : null))
        .filter(Boolean);
      return Promise.all(updates).then(() => {
        io.to(roomCode).emit("ratingResults", { winner, results });
      });
    })
    .catch((err) => {
      console.error("Rating update failed:", err);
      io.to(roomCode).emit("ratingResults", { winner: room.winner, results: [] });
    });
}

// --- Express + Socket.io ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(ROOT));

app.use("/api/auth", auth.router);

app.get("/", (req, res) => {
  res.sendFile(path.join(ROOT, "index.html"));
});

io.on("connection", (socket) => {
  socket.on("auth", (token) => {
    if (!token) return;
    try {
      const decoded = jwt.verify(token, auth.JWT_SECRET);
      socket.userId = decoded.userId;
    } catch (e) {
      socket.userId = null;
    }
  });

  socket.on("createRoom", async () => {
    let code = randomCode();
    while (rooms.has(code)) code = randomCode();

    const board = createBoard();
    const redName = await getUsernameForUserId(socket.userId);
    const room = {
      mode: "2player",
      board,
      currentPlayer: RED,
      redHasPlayed: true,
      greenHasPlayed: true,
      players: { red: socket.id, green: null },
      playerNames: { [RED]: redName, [GREEN]: "—" },
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

  socket.on("findMatch", async () => {
    if (matchmakingQueue.includes(socket.id)) return;
    matchmakingQueue.push(socket.id);
    socket.emit("matchmakingStatus", { searching: true, position: matchmakingQueue.length });
    if (matchmakingQueue.length >= 2) await matchTwoPlayers(io);
  });

  socket.on("cancelMatchmaking", () => {
    removeFromQueue(socket.id);
    socket.emit("matchmakingStatus", { searching: false });
  });

  socket.on("findMatch4", async () => {
    if (matchmakingQueue4.includes(socket.id)) return;
    matchmakingQueue4.push(socket.id);
    socket.emit("matchmakingStatus", { searching: true, position: matchmakingQueue4.length, mode: "4player" });
    if (matchmakingQueue4.length >= 4) await matchFourPlayers(io);
  });

  socket.on("cancelMatchmaking4", () => {
    removeFromQueue4(socket.id);
    socket.emit("matchmakingStatus", { searching: false, mode: "4player" });
  });

  socket.on("joinRoom", async (code) => {
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
    if (!room.playerNames) room.playerNames = {};
    room.playerNames[GREEN] = await getUsernameForUserId(socket.userId);
    room.turnStartTime = Date.now();
    socket.join(roomCode);
    socket.emit("joinedRoom", { code: roomCode, player: GREEN });
    io.to(roomCode).emit("gameState", getGameState2(room));
    io.to(roomCode).emit("playerJoined");
    scheduleTurnTimeout(io, roomCode, room);
  });

  socket.on("createRoom4", async () => {
    let code = randomCode();
    while (rooms.has(code)) code = randomCode();

    const board = createBoard4();
    const redName = await getUsernameForUserId(socket.userId);
    const room = {
      mode: "4player",
      board,
      currentPlayerIndex: 0,
      players: { 1: socket.id, 2: null, 3: null, 4: null },
      playerUserIds: { 1: socket.userId || null, 2: null, 3: null, 4: null },
      playerNames: { [RED]: redName, [GREEN]: "—", [BLUE]: "—", [YELLOW]: "—" },
      eliminationOrder: [],
      playerTimeRemaining: { [RED]: TURN_TIME_SEC, [GREEN]: TURN_TIME_SEC, [BLUE]: TURN_TIME_SEC, [YELLOW]: TURN_TIME_SEC },
      playerIsAI: {},
      turnStartTime: Date.now(),
      turnTimeoutId: null,
      playersReady: false,
    };
    rooms.set(code, room);

    socket.join(code);
    socket.emit("roomCreated", { code, player: RED, mode: "4player" });
    socket.emit("gameState", getGameState4(room));
  });

  socket.on("joinRoom4", async (code) => {
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
      socket.emit("gameState", getGameState4(room));
      return;
    }

    const firstFree = [2, 3, 4].find((i) => !room.players[i]);
    if (!firstFree) {
      socket.emit("joinError", "Room is full (4/4 players)");
      return;
    }

    const playerId = PLAYERS_4[firstFree - 1];
    room.players[firstFree] = socket.id;
    if (!room.playerUserIds) room.playerUserIds = { 1: null, 2: null, 3: null, 4: null };
    room.playerUserIds[firstFree] = socket.userId || null;
    if (!room.playerNames) room.playerNames = {};
    room.playerNames[playerId] = await getUsernameForUserId(socket.userId);
    const count = [1, 2, 3, 4].filter((i) => room.players[i]).length;
    room.playersReady = count >= 4;
    if (!room.playerTimeRemaining) {
      room.playerTimeRemaining = { [RED]: TURN_TIME_SEC, [GREEN]: TURN_TIME_SEC, [BLUE]: TURN_TIME_SEC, [YELLOW]: TURN_TIME_SEC };
    }
    if (!room.playerIsAI) room.playerIsAI = {};
    if (count === 4) {
      room.turnStartTime = Date.now();
      scheduleTurnTimeout4(io, roomCode, room);
    } else if (!room.turnStartTime) {
      room.turnStartTime = Date.now();
    }

    socket.join(roomCode);
    socket.emit("joinedRoom", { code: roomCode, player: playerId, mode: "4player" });
    socket.emit("gameState", getGameState4(room));

    io.to(roomCode).emit("playerJoined", { count, player: playerId });
  });

  socket.on("move", ({ code, row, col }) => {
    const roomCode = String(code).toUpperCase().trim();
    const room = rooms.get(roomCode);
    if (!room || !room.board) return;

    if (room.mode === "4player") {
      const player = getPlayerId4(room, socket.id);
      if (player === null) return;
      if (!room.playersReady) return;
      if (PLAYERS_4[room.currentPlayerIndex] !== player) return;
      if (room.playerIsAI && room.playerIsAI[player]) return;

      if (room.turnTimeoutId) {
        clearTimeout(room.turnTimeoutId);
        room.turnTimeoutId = null;
      }
      const now = Date.now();
      const elapsed = (now - room.turnStartTime) / 1000;
      if (!room.playerTimeRemaining) room.playerTimeRemaining = { [RED]: TURN_TIME_SEC, [GREEN]: TURN_TIME_SEC, [BLUE]: TURN_TIME_SEC, [YELLOW]: TURN_TIME_SEC };
      const timeRemaining = Math.max(0, (room.playerTimeRemaining[player] ?? TURN_TIME_SEC) - elapsed);
      room.playerTimeRemaining[player] = timeRemaining;

      if (timeRemaining <= 0) {
        if (!room.playerIsAI) room.playerIsAI = {};
        room.playerIsAI[player] = true;
        io.to(roomCode).emit("playerTimedOut", { player });
        runAITurn4(io, roomCode, room);
        return;
      }

      if (!makeMove(room.board, row, col, player)) return;

      const winner = resolve(room.board, player, () => gameOver4(room.board)) || gameOver4(room.board);
      recordEliminations4(room);

      if (winner !== 0) {
        room.winner = winner;
        if (room.turnTimeoutId) clearTimeout(room.turnTimeoutId);
        room.turnTimeoutId = null;
      } else {
        room.currentPlayerIndex = nextPlayerIndex4(room);
        room.turnStartTime = Date.now();
        scheduleTurnTimeout4(io, roomCode, room);
      }

      io.to(roomCode).emit("gameState", getGameState4(room));

      if (winner !== 0) {
        apply4PlayerRatingUpdates(io, roomCode, room);
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

async function start() {
  if (process.env.DATABASE_URL) {
    try {
      await db.initDb();
      console.log("Database initialized (PostgreSQL)");
    } catch (err) {
      console.error("Database init failed:", err.message);
      console.warn("Account system may not work. Set DATABASE_URL in .env");
    }
  } else {
    console.warn("DATABASE_URL not set - account system disabled. Copy .env.example to .env");
  }
  server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log("Open in browser to play Colour Wars!");
    console.log("Auth API: POST /api/auth/register, POST /api/auth/login, GET /api/auth/me");
  });
}
start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
