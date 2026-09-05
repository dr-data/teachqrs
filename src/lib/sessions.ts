import { lastId, many, one, run, type QuestionRow, type SessionRow, type SetRow } from "./db";
import { getParticipant, IdentityError } from "./identity";

export class SessionError extends Error {}

const JOIN_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

async function visibleQuestions(db: D1Database, setId: number): Promise<QuestionRow[]> {
  return many<QuestionRow>(
    db,
    "SELECT * FROM questions WHERE set_id = ? AND visible = 1 ORDER BY position, id",
    setId,
  );
}

async function generateJoinCode(db: D1Database): Promise<string> {
  for (let i = 0; i < 40; i++) {
    let code = "";
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    for (const b of bytes) code += JOIN_ALPHABET[b % JOIN_ALPHABET.length];
    const exists = await one<{ n: number }>(db, "SELECT 1 AS n FROM sessions WHERE join_code = ?", code);
    if (!exists) return code;
  }
  throw new SessionError("Could not allocate a join code.");
}

export async function requireSession(db: D1Database, sessionId: number): Promise<SessionRow> {
  const row = await one<SessionRow>(db, "SELECT * FROM sessions WHERE id = ?", sessionId);
  if (!row) throw new SessionError("Session not found.");
  return row;
}

async function requireLive(db: D1Database, sessionId: number): Promise<SessionRow> {
  const session = await requireSession(db, sessionId);
  if (session.status !== "live") throw new SessionError("Session is not live.");
  return session;
}

async function requireQuestionInSet(db: D1Database, setId: number, questionId: number): Promise<QuestionRow> {
  const row = await one<QuestionRow>(
    db,
    "SELECT * FROM questions WHERE id = ? AND set_id = ?",
    questionId,
    setId,
  );
  if (!row) throw new SessionError("Question is not in this set.");
  return row;
}

export async function createSession(
  db: D1Database,
  setId: number,
  name: string,
  subclassIds: number[],
  mode?: string,
): Promise<SessionRow> {
  const qset = await one<SetRow>(db, "SELECT * FROM question_sets WHERE id = ?", setId);
  if (!qset) throw new SessionError("Question set not found.");
  const questions = await visibleQuestions(db, setId);
  if (!questions.length) throw new SessionError("Cannot start a session with no visible questions.");
  if (!subclassIds.length) throw new SessionError("Choose at least one subclass.");
  for (const sid of subclassIds) {
    const row = await one<{ id: number }>(db, "SELECT id FROM subclasses WHERE id = ?", sid);
    if (!row) throw new SessionError(`Subclass ${sid} not found.`);
  }
  const chosenMode = mode || qset.mode;
  if (chosenMode !== "survey" && chosenMode !== "interactive") {
    throw new SessionError("Mode must be survey or interactive.");
  }
  const code = await generateJoinCode(db);
  const inserted = await run(
    db,
    `INSERT INTO sessions (set_id, name, join_code, status, current_question_id, collecting, reveal_results, current_round, mode)
     VALUES (?, ?, ?, 'draft', NULL, 0, 0, 1, ?)`,
    setId,
    name.trim() || qset.title,
    code,
    chosenMode,
  );
  const sessionId = lastId(inserted);
  await db.batch(
    subclassIds.map((sid) =>
      db.prepare("INSERT INTO session_subclasses (session_id, subclass_id) VALUES (?, ?)").bind(sessionId, sid),
    ),
  );
  return requireSession(db, sessionId);
}

export async function startSession(db: D1Database, sessionId: number): Promise<SessionRow> {
  const session = await requireSession(db, sessionId);
  const questions = await visibleQuestions(db, session.set_id);
  if (!questions.length) throw new SessionError("Cannot start a session with no visible questions.");
  await run(
    db,
    `UPDATE sessions
     SET status = 'live', current_question_id = ?, collecting = 1, reveal_results = 0, current_round = 1, started_at = datetime('now')
     WHERE id = ?`,
    questions[0].id,
    sessionId,
  );
  return requireSession(db, sessionId);
}

export async function closeSession(db: D1Database, sessionId: number): Promise<SessionRow> {
  await requireSession(db, sessionId);
  await run(
    db,
    "UPDATE sessions SET status = 'closed', collecting = 0, reveal_results = 1, closed_at = datetime('now') WHERE id = ?",
    sessionId,
  );
  return requireSession(db, sessionId);
}

export async function openQuestion(db: D1Database, sessionId: number, questionId?: number | null): Promise<SessionRow> {
  const session = await requireLive(db, sessionId);
  const qid = questionId ?? session.current_question_id;
  if (qid == null) throw new SessionError("No question selected.");
  await requireQuestionInSet(db, session.set_id, qid);
  await run(
    db,
    "UPDATE sessions SET current_question_id = ?, collecting = 1, reveal_results = 0 WHERE id = ?",
    qid,
    sessionId,
  );
  return requireSession(db, sessionId);
}

export async function closeQuestion(db: D1Database, sessionId: number): Promise<SessionRow> {
  await requireLive(db, sessionId);
  await run(db, "UPDATE sessions SET collecting = 0, reveal_results = 1 WHERE id = ?", sessionId);
  return requireSession(db, sessionId);
}

export async function reopenForDiscussion(db: D1Database, sessionId: number): Promise<SessionRow> {
  await requireLive(db, sessionId);
  await run(
    db,
    "UPDATE sessions SET collecting = 1, reveal_results = 0, current_round = current_round + 1 WHERE id = ?",
    sessionId,
  );
  return requireSession(db, sessionId);
}

export async function nextQuestion(db: D1Database, sessionId: number, step = 1): Promise<SessionRow> {
  const session = await requireLive(db, sessionId);
  const questions = await visibleQuestions(db, session.set_id);
  const ids = questions.map((q) => q.id);
  if (!ids.length) throw new SessionError("No visible questions.");
  let idx = ids.indexOf(session.current_question_id ?? -1);
  if (idx < 0) idx = 0;
  idx = Math.min(Math.max(idx + step, 0), ids.length - 1);
  await run(
    db,
    "UPDATE sessions SET current_question_id = ?, collecting = 1, reveal_results = 0, current_round = 1 WHERE id = ?",
    ids[idx],
    sessionId,
  );
  return requireSession(db, sessionId);
}

export async function resetSessionResponses(db: D1Database, sessionId: number): Promise<void> {
  await run(db, "DELETE FROM responses WHERE session_id = ?", sessionId);
  await run(db, "DELETE FROM participants WHERE session_id = ?", sessionId);
  await run(
    db,
    "UPDATE sessions SET current_round = 1, collecting = 0, reveal_results = 0 WHERE id = ?",
    sessionId,
  );
}

function score(question: QuestionRow, value: string): number | null {
  const correct = question.correct;
  if (!correct) return null;
  if (question.type === "mcq") return value.trim().toUpperCase().slice(0, 1) === correct ? 1 : 0;
  if (question.type === "true_false") {
    let normalized = value.trim().toLowerCase();
    if (["t", "true", "yes"].includes(normalized)) normalized = "true";
    else if (["f", "false", "no"].includes(normalized)) normalized = "false";
    return normalized === correct ? 1 : 0;
  }
  return value.trim().toLowerCase() === String(correct).trim().toLowerCase() ? 1 : 0;
}

export async function submitResponse(
  db: D1Database,
  sessionId: number,
  questionId: number,
  studentNumber: string,
  value: string,
) {
  const session = await requireLive(db, sessionId);
  const participant = await getParticipant(db, sessionId, studentNumber);
  if (!participant) throw new IdentityError("Enter your student number before answering.");
  const question = await requireQuestionInSet(db, session.set_id, questionId);
  if (!question.visible) throw new SessionError("That question is hidden.");
  if (session.mode === "interactive") {
    if (questionId !== session.current_question_id) throw new SessionError("That question is not open.");
    if (!session.collecting) throw new SessionError("Answering is closed for this question.");
  }
  if (!value.trim()) throw new SessionError("An answer is required.");
  const roundNo = session.mode === "interactive" ? session.current_round : 1;
  const isCorrect = score(question, value);
  const existing = await one<{ id: number }>(
    db,
    "SELECT id FROM responses WHERE session_id = ? AND question_id = ? AND student_number = ? AND round = ?",
    sessionId,
    questionId,
    studentNumber,
    roundNo,
  );
  if (existing) {
    await run(
      db,
      "UPDATE responses SET value = ?, is_correct = ?, updated_at = datetime('now') WHERE id = ?",
      value.trim(),
      isCorrect,
      existing.id,
    );
    return existing;
  }
  return run(
    db,
    `INSERT INTO responses (session_id, question_id, student_number, subclass_id, value, round, is_correct)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    sessionId,
    questionId,
    studentNumber,
    participant.subclass_id,
    value.trim(),
    roundNo,
    isCorrect,
  );
}

export async function resultsForQuestion(
  db: D1Database,
  sessionId: number,
  questionId: number,
  subclassId?: number | null,
  roundNo?: number | null,
) {
  const session = await requireSession(db, sessionId);
  const question = await one<QuestionRow>(db, "SELECT * FROM questions WHERE id = ?", questionId);
  if (!question) throw new SessionError("Question not found.");
  const round = roundNo ?? (session.mode === "interactive" ? session.current_round : 1);
  const subclassSql = subclassId != null ? "AND subclass_id = ?" : "";
  const params: unknown[] = [sessionId, questionId, round];
  if (subclassId != null) params.push(subclassId);
  const rows = await many<{ value: string; n: number }>(
    db,
    `SELECT value, COUNT(*) AS n FROM responses
     WHERE session_id = ? AND question_id = ? AND round = ? ${subclassSql}
     GROUP BY value`,
    ...params,
  );
  const answeredRow = await one<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM responses
     WHERE session_id = ? AND question_id = ? AND round = ? ${subclassSql}`,
    ...params,
  );
  const partParams: unknown[] = [sessionId];
  const partSql = subclassId != null ? "AND subclass_id = ?" : "";
  if (subclassId != null) partParams.push(subclassId);
  const joinedRow = await one<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM participants WHERE session_id = ? ${partSql}`,
    ...partParams,
  );
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.value] = row.n;
  const choices = JSON.parse(question.choices_json || "[]") as string[];
  let bars: { key: string; label: string; count: number; pct?: number }[] = [];
  if (question.type === "mcq") {
    bars = choices.map((label, i) => {
      const letter = String.fromCharCode(65 + i);
      return { key: letter, label: `${letter}. ${label}`, count: counts[letter] ?? 0 };
    });
  } else if (question.type === "true_false") {
    bars = [
      { key: "true", label: "True", count: (counts.true ?? 0) + (counts.True ?? 0) },
      { key: "false", label: "False", count: (counts.false ?? 0) + (counts.False ?? 0) },
    ];
  } else {
    bars = Object.entries(counts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, count]) => ({ key, label: key, count }));
  }
  const total = bars.reduce((s, b) => s + b.count, 0);
  for (const bar of bars) bar.pct = total ? Math.round((1000 * bar.count) / total) / 10 : 0;
  return {
    question,
    choices,
    bars,
    answered: answeredRow?.n ?? 0,
    joined: joinedRow?.n ?? 0,
    round,
    correct: question.correct,
  };
}

export async function sessionByCode(db: D1Database, code: string): Promise<SessionRow | null> {
  return one<SessionRow>(db, "SELECT * FROM sessions WHERE join_code = ?", code.trim().toUpperCase());
}
