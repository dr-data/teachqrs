import * as XLSX from "xlsx";
import { many, run, type QuestionRow } from "./db";

export const CSV_HEADER = [
  "question_number",
  "prompt",
  "type",
  "choice_a",
  "choice_b",
  "choice_c",
  "choice_d",
  "choice_e",
  "correct",
  "points",
] as const;

const CHOICE_KEYS = ["choice_a", "choice_b", "choice_c", "choice_d", "choice_e"] as const;
const VALID_TYPES = new Set(["mcq", "true_false", "short"]);

export type ImportResult = { imported: number; errors: string[] };

function normalizeType(raw: unknown): string {
  const value = String(raw ?? "mcq")
    .trim()
    .toLowerCase()
    .replace(/[-\s]/g, "_");
  const aliases: Record<string, string> = {
    mc: "mcq",
    multiple_choice: "mcq",
    tf: "true_false",
    truefalse: "true_false",
  };
  return aliases[value] ?? value;
}

function normalizeCorrect(qtype: string, raw: unknown): string | null {
  if (raw == null) return null;
  const value = String(raw).trim();
  if (!value) return null;
  if (qtype === "mcq") {
    const letter = value[0].toUpperCase();
    if (!"ABCDE".includes(letter)) throw new Error(`correct must be A–E for mcq, got ${value}`);
    return letter;
  }
  if (qtype === "true_false") {
    const lowered = value.toLowerCase();
    if (["true", "t", "yes", "1"].includes(lowered)) return "true";
    if (["false", "f", "no", "0"].includes(lowered)) return "false";
    throw new Error(`correct must be true/false for true_false, got ${value}`);
  }
  return value;
}

function choicesFromRow(row: Record<string, unknown>, qtype: string): string[] {
  if (qtype === "true_false") return ["True", "False"];
  if (qtype === "short") return [];
  return CHOICE_KEYS.map((k) => String(row[k] ?? "").trim()).filter(Boolean);
}

function rowToQuestion(row: Record<string, unknown>, index: number) {
  const prompt = String(row.prompt ?? "").trim();
  if (!prompt) throw new Error("prompt is required");
  const qtype = normalizeType(row.type);
  if (!VALID_TYPES.has(qtype)) throw new Error(`unknown type ${qtype}`);
  const choices = choicesFromRow(row, qtype);
  if (qtype === "mcq" && choices.length < 2) throw new Error("mcq needs at least two choices");
  const correct = normalizeCorrect(qtype, row.correct);
  if (qtype === "mcq" && correct) {
    const idx = correct.charCodeAt(0) - 65;
    if (idx >= choices.length) throw new Error(`correct ${correct} has no matching choice`);
  }
  const pointsRaw = String(row.points ?? "").trim();
  const points = pointsRaw ? Number(pointsRaw) : 1;
  const posRaw = String(row.question_number ?? "").trim();
  const position = posRaw ? Number(posRaw) : index;
  return { position, prompt, type: qtype, choices, correct, points };
}

export function parseCsv(text: string): Record<string, unknown>[] {
  const wb = XLSX.read(text, { type: "string" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error("CSV is missing a header row");
  return XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false }) as Record<string, unknown>[];
}

export function parseXlsx(data: ArrayBuffer): Record<string, unknown>[] {
  const wb = XLSX.read(data, { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error("Excel sheet is empty");
  return XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false }) as Record<string, unknown>[];
}

export async function importTable(
  db: D1Database,
  setId: number,
  rows: Record<string, unknown>[],
): Promise<ImportResult> {
  const result: ImportResult = { imported: 0, errors: [] };
  const existing = await many<{ position: number }>(
    db,
    "SELECT position FROM questions WHERE set_id = ?",
    setId,
  );
  const taken = new Set(existing.map((r) => r.position));
  let nextPos = taken.size ? Math.max(...taken) + 1 : 1;
  for (let i = 0; i < rows.length; i++) {
    try {
      const q = rowToQuestion(rows[i], nextPos);
      let pos = q.position;
      if (taken.has(pos)) pos = nextPos;
      await run(
        db,
        `INSERT INTO questions (set_id, position, prompt, type, choices_json, correct, points, visible)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        setId,
        pos,
        q.prompt,
        q.type,
        JSON.stringify(q.choices),
        q.correct,
        q.points,
      );
      taken.add(pos);
      nextPos = Math.max(nextPos, pos) + 1;
      result.imported += 1;
    } catch (err) {
      result.errors.push(`Row ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}

export async function exportRows(db: D1Database, setId: number) {
  const questions = await many<QuestionRow>(
    db,
    "SELECT * FROM questions WHERE set_id = ? ORDER BY position, id",
    setId,
  );
  return questions.map((q) => {
    const choices = JSON.parse(q.choices_json || "[]") as string[];
    const padded = [...choices, "", "", "", "", ""].slice(0, 5);
    return {
      question_number: q.position,
      prompt: q.prompt,
      type: q.type,
      choice_a: q.type === "mcq" ? padded[0] : "",
      choice_b: q.type === "mcq" ? padded[1] : "",
      choice_c: q.type === "mcq" ? padded[2] : "",
      choice_d: q.type === "mcq" ? padded[3] : "",
      choice_e: q.type === "mcq" ? padded[4] : "",
      correct: q.correct ?? "",
      points: q.points,
    };
  });
}

export async function exportCsv(db: D1Database, setId: number): Promise<string> {
  const rows = await exportRows(db, setId);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows, { header: [...CSV_HEADER] }), "questions");
  return XLSX.utils.sheet_to_csv(wb.Sheets.questions);
}

export async function exportXlsx(db: D1Database, setId: number): Promise<Uint8Array> {
  const rows = await exportRows(db, setId);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows, { header: [...CSV_HEADER] }), "questions");
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as Uint8Array;
}
