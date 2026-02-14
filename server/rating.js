/**
 * Plackett-Luce rating model for 4-player Colour Wars.
 * K=10. Players who lose on the same turn are treated as a draw (tied for 2nd/3rd/4th).
 */
const K = 10;

function strength(rating) {
  return Math.pow(10, rating / 400);
}

/**
 * Expected score for player i under Plackett-Luce (Bradley-Terry pairwise):
 * E_i = sum_{j!=i} strength_i / (strength_i + strength_j)
 * Sum of all E_i = n(n-1)/2 = 6 for n=4.
 */
function expectedScore(ratings, i) {
  const n = ratings.length;
  const s = ratings.map(strength);
  let sum = 0;
  for (let j = 0; j < n; j++) {
    if (j === i) continue;
    sum += s[i] / (s[i] + s[j]);
  }
  return sum;
}

/**
 * Compute rating changes for a 4-player game.
 * placementOrder: [playerIndex0, playerIndex1, playerIndex2, playerIndex3]
 *   where index 0 = 1st place (winner), indices 1,2,3 = losers (draw if same turn).
 * tiedGroups: optional [[idx,idx],[idx]] - groups of player indices that tied. Default: [1,2,3] tied (all losers).
 * ratings: [r0, r1, r2, r3] for each player
 * Returns: [delta0, delta1, delta2, delta3]
 *
 * Scores: 1st=3, 2nd=2, 3rd=1, 4th=0 (sum=6)
 * For draws: players share the average of their placement scores.
 */
function computeRatingChanges(placementOrder, ratings, tiedGroups = null) {
  const n = 4;
  const scores = [3, 2, 1, 0];
  const actualScores = new Array(n).fill(0);

  if (!tiedGroups) {
    tiedGroups = [[placementOrder[0]], [placementOrder[1], placementOrder[2], placementOrder[3]]];
  }

  let rank = 0;
  for (const group of tiedGroups) {
    const groupScores = group.map((_, idx) => scores[Math.min(rank + idx, 3)]);
    const avgScore = groupScores.reduce((a, b) => a + b, 0) / group.length;
    rank += group.length;
    for (const playerIdx of group) {
      actualScores[playerIdx] = avgScore;
    }
  }

  const deltas = [];
  let sumDelta = 0;
  for (let i = 0; i < n; i++) {
    const E = expectedScore(ratings, i);
    const S = actualScores[i];
    const delta = Math.round(K * (S - E));
    deltas.push(delta);
    sumDelta += delta;
  }
  if (sumDelta !== 0) {
    const winnerIdx = placementOrder[0];
    deltas[winnerIdx] -= sumDelta;
  }
  return deltas;
}

/**
 * Get placement order from game result.
 * winner: player id (RED, GREEN, BLUE, YELLOW)
 * losers: all others - treated as draw (same turn elimination)
 * playerOrder: [RED, GREEN, BLUE, YELLOW] as indices 0,1,2,3
 */
function getPlacementOrder(winner, playerOrder) {
  const winnerIdx = playerOrder.indexOf(winner);
  const loserIndices = playerOrder.map((_, i) => i).filter((i) => i !== winnerIdx);
  return [winnerIdx, ...loserIndices];
}

module.exports = {
  K,
  computeRatingChanges,
  getPlacementOrder,
};
