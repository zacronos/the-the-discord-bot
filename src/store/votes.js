// Vote rows: one per (poll, user), replaced on re-vote. All functions take
// the open db handle as their first argument.

export const CHOICES = ['yes', 'no', 'hard_no', 'abstain'];
const CHOICE_SET = new Set(CHOICES);

export function castVote(db, pollId, userId, choice, now = Date.now()) {
  if (!CHOICE_SET.has(choice)) throw new Error(`Invalid vote choice: ${choice}`);
  db.prepare(
    `INSERT INTO votes (poll_id, user_id, choice, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(poll_id, user_id) DO UPDATE SET choice = excluded.choice, updated_at = excluded.updated_at`
  ).run(pollId, userId, choice, now);
}

export function getVote(db, pollId, userId) {
  return db.prepare('SELECT choice FROM votes WHERE poll_id = ? AND user_id = ?').get(pollId, userId)
    ?.choice;
}

export function countByChoice(db, pollId) {
  const counts = { yes: 0, no: 0, hard_no: 0, abstain: 0 };
  const rows = db
    .prepare('SELECT choice, COUNT(*) AS n FROM votes WHERE poll_id = ? GROUP BY choice')
    .all(pollId);
  for (const row of rows) counts[row.choice] = row.n;
  return counts;
}

export function countVoters(db, pollId) {
  return db.prepare('SELECT COUNT(*) AS n FROM votes WHERE poll_id = ?').get(pollId).n;
}

export function deleteVotes(db, pollId) {
  return db.prepare('DELETE FROM votes WHERE poll_id = ?').run(pollId).changes;
}

export function deleteVote(db, pollId, userId) {
  return db.prepare('DELETE FROM votes WHERE poll_id = ? AND user_id = ?').run(pollId, userId).changes;
}

export function listVoters(db, pollId) {
  return db
    .prepare('SELECT user_id FROM votes WHERE poll_id = ?')
    .all(pollId)
    .map((row) => row.user_id);
}

export function listVotersByChoice(db, pollId, choice) {
  return db
    .prepare('SELECT user_id FROM votes WHERE poll_id = ? AND choice = ?')
    .all(pollId, choice)
    .map((row) => row.user_id);
}
