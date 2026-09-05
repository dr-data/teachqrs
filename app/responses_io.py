from __future__ import annotations

import csv
import io
import sqlite3

RESPONSE_HEADER = [
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
]


def export_responses_csv(conn: sqlite3.Connection, session_id: int) -> str:
    session = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
    if session is None:
        raise ValueError("Session not found.")
    rows = conn.execute(
        """
        SELECT
            r.*,
            q.position AS question_number,
            q.prompt,
            q.type,
            q.correct AS correct_answer,
            sc.code AS subclass
        FROM responses r
        JOIN questions q ON q.id = r.question_id
        JOIN subclasses sc ON sc.id = r.subclass_id
        WHERE r.session_id = ?
        ORDER BY sc.code, r.student_number, q.position, r.round
        """,
        (session_id,),
    ).fetchall()
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=RESPONSE_HEADER, lineterminator="\n")
    writer.writeheader()
    for row in rows:
        correct_flag = row["is_correct"]
        if correct_flag is None:
            is_correct = ""
        else:
            is_correct = "1" if correct_flag else "0"
        writer.writerow(
            {
                "session_name": session["name"],
                "join_code": session["join_code"],
                "subclass": row["subclass"],
                "student_number": row["student_number"],
                "question_number": row["question_number"],
                "prompt": row["prompt"],
                "type": row["type"],
                "response": row["value"],
                "correct_answer": row["correct_answer"] or "",
                "is_correct": is_correct,
                "round": row["round"],
                "submitted_at": row["created_at"],
                "updated_at": row["updated_at"],
            }
        )
    return buf.getvalue()
