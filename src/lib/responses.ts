import { many, one, type SessionRow } from "./db";

export const RESPONSE_HEADER = [
  "session_name",
  "join_code",
  "subclass",
  "student_number",
  "question_number",
  "prompt",
  "type",
  "response",
  "correct_answer",
  "is_correct",
  "round",
  "submitted_at",
  "updated_at",
] as const;

type ExportRow = {
  question_number: number;
  prompt: string;
  type: string;
  correct_answer: string | null;
  subclass: string;
  student_number: string;
  value: string;
  is_correct: number | null;
  round: number;
  created_at: string;
  updated_at: string;
};

function csvEscape(value: unknown): string {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

export async function exportResponsesCsv(db: D1Database, sessionId: number): Promise<string> {
  const session = await one<SessionRow>(db, "SELECT * FROM sessions WHERE id = ?", sessionId);
  if (!session) throw new Error("Session not found.");
  const rows = await many<ExportRow>(
    db,
    `SELECT
        r.value, r.student_number, r.is_correct, r.round, r.created_at, r.updated_at,
        q.position AS question_number, q.prompt, q.type, q.correct AS correct_answer,
        sc.code AS subclass
     FROM responses r
     JOIN questions q ON q.id = r.question_id
     JOIN subclasses sc ON sc.id = r.subclass_id
     WHERE r.session_id = ?
     ORDER BY sc.code, r.student_number, q.position, r.round`,
    sessionId,
  );
  const lines = [RESPONSE_HEADER.join(",")];
  for (const row of rows) {
    const correctFlag = row.is_correct == null ? "" : row.is_correct ? "1" : "0";
    lines.push(
      [
        session.name,
        session.join_code,
        row.subclass,
        row.student_number,
        row.question_number,
        row.prompt,
        row.type,
        row.value,
        row.correct_answer ?? "",
        correctFlag,
        row.round,
        row.created_at,
        row.updated_at,
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  return lines.join("\n");
}
