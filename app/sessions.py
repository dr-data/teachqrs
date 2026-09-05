from __future__ import annotations

import json
import random
import sqlite3
import string

from app.identity import IdentityError, get_participant

AMBIGUOUS = set("01OIL")
JOIN_ALPHABET = [c for c in string.ascii_uppercase + string.digits if c not in AMBIGUOUS]


class SessionError(ValueError):
    pass


def _visible_questions(conn: sqlite3.Connection, set_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM questions WHERE set_id = ? AND visible = 1 ORDER BY position, id",
        (set_id,),
    ).fetchall()


def generate_join_code(conn: sqlite3.Connection) -> str:
    for _ in range(40):
        code = "".join(random.choice(JOIN_ALPHABET) for _ in range(4))
        exists = conn.execute("SELECT 1 FROM sessions WHERE join_code = ?", (code,)).fetchone()
        if exists is None:
            return code
    raise SessionError("Could not allocate a join code.")


def create_session(
    conn: sqlite3.Connection,
    set_id: int,
    name: str,
    subclass_ids: list[int],
    mode: str | None = None,
) -> dict:
    qset = conn.execute("SELECT * FROM question_sets WHERE id = ?", (set_id,)).fetchone()
    if qset is None:
        raise SessionError("Question set not found.")
    questions = _visible_questions(conn, set_id)
    if not questions:
        raise SessionError("Cannot start a session with no visible questions.")
    if not subclass_ids:
        raise SessionError("Choose at least one subclass.")
    for sid in subclass_ids:
        row = conn.execute("SELECT id FROM subclasses WHERE id = ?", (sid,)).fetchone()
        if row is None:
            raise SessionError(f"Subclass {sid} not found.")
    chosen_mode = mode or qset["mode"]
    if chosen_mode not in {"survey", "interactive"}:
        raise SessionError("Mode must be survey or interactive.")
    code = generate_join_code(conn)
    cur = conn.execute(
        """
        INSERT INTO sessions (set_id, name, join_code, status, current_question_id, collecting, reveal_results, current_round, mode)
        VALUES (?, ?, ?, 'draft', NULL, 0, 0, 1, ?)
        """,
        (set_id, name.strip() or qset["title"], code, chosen_mode),
    )
    session_id = cur.lastrowid
    for sid in subclass_ids:
        conn.execute(
            "INSERT INTO session_subclasses (session_id, subclass_id) VALUES (?, ?)",
            (session_id, sid),
        )
    conn.commit()
    return dict(conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone())


def start_session(conn: sqlite3.Connection, session_id: int) -> dict:
    session = _require_session(conn, session_id)
    questions = _visible_questions(conn, session["set_id"])
    if not questions:
        raise SessionError("Cannot start a session with no visible questions.")
    first_id = questions[0]["id"]
    collecting = 1 if session["mode"] == "survey" else 1
    conn.execute(
        """
        UPDATE sessions
        SET status = 'live',
            current_question_id = ?,
            collecting = ?,
            reveal_results = 0,
            current_round = 1,
            started_at = datetime('now')
        WHERE id = ?
        """,
        (first_id, collecting, session_id),
    )
    conn.commit()
    return _require_session(conn, session_id)


def close_session(conn: sqlite3.Connection, session_id: int) -> dict:
    _require_session(conn, session_id)
    conn.execute(
        """
        UPDATE sessions
        SET status = 'closed', collecting = 0, reveal_results = 1, closed_at = datetime('now')
        WHERE id = ?
        """,
        (session_id,),
    )
    conn.commit()
    return _require_session(conn, session_id)


def open_question(conn: sqlite3.Connection, session_id: int, question_id: int | None = None) -> dict:
    session = _require_live(conn, session_id)
    qid = question_id or session["current_question_id"]
    _require_question_in_set(conn, session["set_id"], qid)
    conn.execute(
        """
        UPDATE sessions
        SET current_question_id = ?, collecting = 1, reveal_results = 0
        WHERE id = ?
        """,
        (qid, session_id),
    )
    conn.commit()
    return _require_session(conn, session_id)


def close_question(conn: sqlite3.Connection, session_id: int) -> dict:
    _require_live(conn, session_id)
    conn.execute(
        "UPDATE sessions SET collecting = 0, reveal_results = 1 WHERE id = ?",
        (session_id,),
    )
    conn.commit()
    return _require_session(conn, session_id)


def reopen_for_discussion(conn: sqlite3.Connection, session_id: int) -> dict:
    session = _require_live(conn, session_id)
    conn.execute(
        """
        UPDATE sessions
        SET collecting = 1, reveal_results = 0, current_round = current_round + 1
        WHERE id = ?
        """,
        (session_id,),
    )
    conn.commit()
    return _require_session(conn, session_id)


def next_question(conn: sqlite3.Connection, session_id: int, step: int = 1) -> dict:
    session = _require_live(conn, session_id)
    questions = _visible_questions(conn, session["set_id"])
    ids = [q["id"] for q in questions]
    if not ids:
        raise SessionError("No visible questions.")
    try:
        idx = ids.index(session["current_question_id"])
    except ValueError:
        idx = 0
    idx = min(max(idx + step, 0), len(ids) - 1)
    conn.execute(
        """
        UPDATE sessions
        SET current_question_id = ?, collecting = 1, reveal_results = 0, current_round = 1
        WHERE id = ?
        """,
        (ids[idx], session_id),
    )
    conn.commit()
    return _require_session(conn, session_id)


def reset_session_responses(conn: sqlite3.Connection, session_id: int) -> None:
    conn.execute("DELETE FROM responses WHERE session_id = ?", (session_id,))
    conn.execute("DELETE FROM participants WHERE session_id = ?", (session_id,))
    conn.execute(
        "UPDATE sessions SET current_round = 1, collecting = 0, reveal_results = 0 WHERE id = ?",
        (session_id,),
    )
    conn.commit()


def _score(question: sqlite3.Row, value: str) -> int | None:
    correct = question["correct"]
    if not correct:
        return None
    qtype = question["type"]
    if qtype == "mcq":
        return int(value.strip().upper()[:1] == correct)
    if qtype == "true_false":
        normalized = value.strip().lower()
        if normalized in {"t", "true", "yes"}:
            normalized = "true"
        elif normalized in {"f", "false", "no"}:
            normalized = "false"
        return int(normalized == correct)
    return int(value.strip().lower() == str(correct).strip().lower())


def submit_response(
    conn: sqlite3.Connection,
    session_id: int,
    question_id: int,
    student_number: str,
    value: str,
) -> dict:
    session = _require_live(conn, session_id)
    participant = get_participant(conn, session_id, student_number)
    if participant is None:
        raise IdentityError("Enter your student number before answering.")
    question = _require_question_in_set(conn, session["set_id"], question_id)
    if not question["visible"]:
        raise SessionError("That question is hidden.")
    if session["mode"] == "interactive":
        if question_id != session["current_question_id"]:
            raise SessionError("That question is not open.")
        if not session["collecting"]:
            raise SessionError("Answering is closed for this question.")
    if not str(value).strip():
        raise SessionError("An answer is required.")

    round_no = session["current_round"] if session["mode"] == "interactive" else 1
    is_correct = _score(question, str(value))
    existing = conn.execute(
        """
        SELECT * FROM responses
        WHERE session_id = ? AND question_id = ? AND student_number = ? AND round = ?
        """,
        (session_id, question_id, student_number, round_no),
    ).fetchone()
    if existing:
        conn.execute(
            """
            UPDATE responses
            SET value = ?, is_correct = ?, updated_at = datetime('now')
            WHERE id = ?
            """,
            (str(value).strip(), is_correct, existing["id"]),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM responses WHERE id = ?", (existing["id"],)).fetchone()
        return dict(row)

    conn.execute(
        """
        INSERT INTO responses (session_id, question_id, student_number, subclass_id, value, round, is_correct)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            session_id,
            question_id,
            student_number,
            participant["subclass_id"],
            str(value).strip(),
            round_no,
            is_correct,
        ),
    )
    conn.commit()
    row = conn.execute(
        """
        SELECT * FROM responses
        WHERE session_id = ? AND question_id = ? AND student_number = ? AND round = ?
        """,
        (session_id, question_id, student_number, round_no),
    ).fetchone()
    return dict(row)


def results_for_question(
    conn: sqlite3.Connection,
    session_id: int,
    question_id: int,
    subclass_id: int | None = None,
    round_no: int | None = None,
) -> dict:
    session = _require_session(conn, session_id)
    question = conn.execute("SELECT * FROM questions WHERE id = ?", (question_id,)).fetchone()
    if question is None:
        raise SessionError("Question not found.")
    if round_no is None:
        round_no = session["current_round"] if session["mode"] == "interactive" else 1
    params: list = [session_id, question_id, round_no]
    subclass_sql = ""
    if subclass_id is not None:
        subclass_sql = "AND subclass_id = ?"
        params.append(subclass_id)
    rows = conn.execute(
        f"""
        SELECT value, COUNT(*) AS n
        FROM responses
        WHERE session_id = ? AND question_id = ? AND round = ? {subclass_sql}
        GROUP BY value
        """,
        params,
    ).fetchall()
    answered = conn.execute(
        f"""
        SELECT COUNT(*) FROM responses
        WHERE session_id = ? AND question_id = ? AND round = ? {subclass_sql}
        """,
        params,
    ).fetchone()[0]
    participant_params: list = [session_id]
    part_sql = ""
    if subclass_id is not None:
        part_sql = "AND subclass_id = ?"
        participant_params.append(subclass_id)
    joined = conn.execute(
        f"SELECT COUNT(*) FROM participants WHERE session_id = ? {part_sql}",
        participant_params,
    ).fetchone()[0]
    counts = {row["value"]: row["n"] for row in rows}
    choices = json.loads(question["choices_json"] or "[]")
    bars = []
    if question["type"] == "mcq":
        for i, label in enumerate(choices):
            letter = chr(ord("A") + i)
            bars.append({"key": letter, "label": f"{letter}. {label}", "count": counts.get(letter, 0)})
    elif question["type"] == "true_false":
        bars = [
            {"key": "true", "label": "True", "count": counts.get("true", 0) + counts.get("True", 0)},
            {"key": "false", "label": "False", "count": counts.get("false", 0) + counts.get("False", 0)},
        ]
    else:
        bars = [{"key": k, "label": k, "count": n} for k, n in sorted(counts.items())]
    total = sum(b["count"] for b in bars) or 0
    for bar in bars:
        bar["pct"] = round(100 * bar["count"] / total, 1) if total else 0.0
    return {
        "question": dict(question),
        "choices": choices,
        "bars": bars,
        "answered": answered,
        "joined": joined,
        "round": round_no,
        "correct": question["correct"],
    }


def _require_session(conn: sqlite3.Connection, session_id: int) -> dict:
    row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
    if row is None:
        raise SessionError("Session not found.")
    return dict(row)


def _require_live(conn: sqlite3.Connection, session_id: int) -> dict:
    session = _require_session(conn, session_id)
    if session["status"] != "live":
        raise SessionError("Session is not live.")
    return session


def _require_question_in_set(conn: sqlite3.Connection, set_id: int, question_id: int) -> sqlite3.Row:
    row = conn.execute(
        "SELECT * FROM questions WHERE id = ? AND set_id = ?",
        (question_id, set_id),
    ).fetchone()
    if row is None:
        raise SessionError("Question is not in this set.")
    return row
