/**
 * Colour Wars — shared client library for browser.
 * Use from any HTML page: <script src="/client/client.js"></script>
 * Then: ColourWars.createBoard(7, 7), ColourWars.makeMove(...), etc.
 */
(function (global) {
  "use strict";

  function criticalMass() {
    return 4;
  }

  function neighbors(rows, cols, row, col) {
    const result = [];
    if (row > 0) result.push([row - 1, col]);
    if (row < rows - 1) result.push([row + 1, col]);
    if (col > 0) result.push([row, col - 1]);
    if (col < cols - 1) result.push([row, col + 1]);
    return result;
  }

  function createBoard(rows, cols, startingCells) {
    const board = Array(rows)
      .fill(null)
      .map(() =>
        Array(cols)
          .fill(null)
          .map(() => ({ count: 0, owner: 0 }))
      );
    if (startingCells) {
      startingCells.forEach(({ row, col, owner }) => {
        board[row][col] = { count: 1, owner };
      });
    }
    return board;
  }

  function makeMove(board, rows, cols, row, col, player) {
    if (row < 0 || row >= rows || col < 0 || col >= cols) return false;
    if (board[row][col].owner !== player) return false;
    board[row][col].count += 1;
    board[row][col].owner = player;
    return true;
  }

  function isUnstable(board, row, col) {
    return board[row][col].count >= criticalMass();
  }

  function explode(board, rows, cols, row, col, player) {
    const count = board[row][col].count;
    const orbsPerNeighbor = count - 3;
    board[row][col].count = 0;
    board[row][col].owner = 0;
    for (const [r, c] of neighbors(rows, cols, row, col)) {
      board[r][c].count += orbsPerNeighbor;
      board[r][c].owner = player;
    }
  }

  function resolve(board, rows, cols, player) {
    let changed = true;
    while (changed) {
      changed = false;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (isUnstable(board, r, c)) {
            explode(board, rows, cols, r, c, player);
            changed = true;
          }
        }
      }
    }
  }

  function resolveOneStep(board, rows, cols, player) {
    let changed = false;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (isUnstable(board, r, c)) {
          explode(board, rows, cols, r, c, player);
          changed = true;
        }
      }
    }
    return changed;
  }

  function resolveAnimated(board, rows, cols, player, drawBoard, onDone, delayMs) {
    delayMs = delayMs || 380;
    if (!resolveOneStep(board, rows, cols, player)) {
      onDone();
      return;
    }
    if (typeof drawBoard === "function") drawBoard();
    setTimeout(
      () => resolveAnimated(board, rows, cols, player, drawBoard, onDone, delayMs),
      delayMs
    );
  }

  function countOrbsByPlayer(board, rows, cols, playerIds) {
    const counts = {};
    playerIds.forEach((id) => (counts[id] = 0));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const owner = board[r][c].owner;
        if (owner !== 0) counts[owner] = (counts[owner] || 0) + board[r][c].count;
      }
    }
    return counts;
  }

  function gameOverTwoPlayer(board, rows, cols, redId, greenId, redHasPlayed, greenHasPlayed) {
    let redOrbs = 0,
      greenOrbs = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (board[r][c].owner === redId) redOrbs += board[r][c].count;
        if (board[r][c].owner === greenId) greenOrbs += board[r][c].count;
      }
    }
    if (redOrbs > 0 && greenOrbs === 0 && greenHasPlayed) return redId;
    if (greenOrbs > 0 && redOrbs === 0 && redHasPlayed) return greenId;
    return 0;
  }

  function gameOverMultiPlayer(board, rows, cols, playerIds) {
    const counts = countOrbsByPlayer(board, rows, cols, playerIds);
    const survivors = playerIds.filter((p) => counts[p] > 0);
    return survivors.length === 1 ? survivors[0] : 0;
  }

  const ColourWars = {
    criticalMass,
    neighbors,
    createBoard,
    makeMove,
    isUnstable,
    explode,
    resolve,
    resolveOneStep,
    resolveAnimated,
    countOrbsByPlayer,
    gameOverTwoPlayer,
    gameOverMultiPlayer,
    constants: {
      RED: 1,
      GREEN: -1,
      GREEN_4P: 2,
      BLUE: 3,
      YELLOW: 4,
      DEFAULT_ROWS: 7,
      DEFAULT_COLS: 7,
      CELL_SIZE: 50,
      EXPLOSION_DELAY_MS: 380,
    },
  };

  global.ColourWars = ColourWars;
})(typeof window !== "undefined" ? window : this);
