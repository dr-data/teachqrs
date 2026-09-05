import { lastId, many, one, run, type SessionRow, type SubclassRow } from "./db";

export class IdentityError extends Error {}

const STUDENT_RE = /^[A-Za-z0-9_-]{3,20}$/;

export function validateStudentNumber(raw: string | null | undefined): string {
  if (raw == null) throw new IdentityError("Student number is required before you can answer.");
  const value = raw.trim();
  if (!value) throw new IdentityError("Student number is required before you can answer.");
  if (!STUDENT_RE.test(value)) {
    throw new IdentityError(
      "Student number must be 3–20 characters: letters, digits, hyphen, or underscore.",
    );
  }
  return value;
}

export type Participant = {
  id: number;
  session_id: number;
  student_number: string;
  subclass_id: number;
};

export async function joinSession(
  db: D1Database,
  sessionId: number,
  studentNumber: string,
  subclassId: number,
): Promise<Participant> {
  const number = validateStudentNumber(studentNumber);
  const session = await one<SessionRow>(db, "SELECT * FROM sessions WHERE id = ?", sessionId);
  if (!session) throw new IdentityError("Session not found.");
  if (session.status !== "live") throw new IdentityError("This session is not live.");
  const allowed = await one<{ n: number }>(
    db,
    "SELECT 1 AS n FROM session_subclasses WHERE session_id = ? AND subclass_id = ?",
    sessionId,
    subclassId,
  );
  if (!allowed) throw new IdentityError("That subclass is not part of this session.");
  const existing = await one<Participant>(
    db,
    "SELECT * FROM participants WHERE session_id = ? AND student_number = ?",
    sessionId,
    number,
  );
  if (existing) {
    if (existing.subclass_id !== subclassId) {
      throw new IdentityError("This student number already joined a different subclass in this session.");
    }
    return existing;
  }
  const inserted = await run(
    db,
    "INSERT INTO participants (session_id, student_number, subclass_id) VALUES (?, ?, ?)",
    sessionId,
    number,
    subclassId,
  );
  return {
    id: lastId(inserted),
    session_id: sessionId,
    student_number: number,
    subclass_id: subclassId,
  };
}

export async function getParticipant(
  db: D1Database,
  sessionId: number,
  studentNumber: string,
): Promise<Participant | null> {
  return one<Participant>(
    db,
    "SELECT * FROM participants WHERE session_id = ? AND student_number = ?",
    sessionId,
    studentNumber,
  );
}

export async function allowedSubclasses(db: D1Database, sessionId: number): Promise<SubclassRow[]> {
  return many<SubclassRow>(
    db,
    `SELECT sc.* FROM subclasses sc
     JOIN session_subclasses ss ON ss.subclass_id = sc.id
     WHERE ss.session_id = ?
     ORDER BY sc.code`,
    sessionId,
  );
}
