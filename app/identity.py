from __future__ import annotations

import re
import sqlite3

STUDENT_NUMBER_RE = re.compile(r"^[A-Za-z0-9_-]{3,20}$")


class IdentityError(ValueError):
    pass


def validate_student_number(raw: str | None) -> str:
    if raw is None:
        raise IdentityError("Student number is required before you can answer.")
    value = raw.strip()
    if not value:
        raise IdentityError("Student number is required before you can answer.")
    if not STUDENT_NUMBER_RE.fullmatch(value):
        raise IdentityError(
            "Student number must be 3–20 characters: letters, digits, hyphen, or underscore."
        )
    return value


def join_session(
    conn: sqlite3.Connection,
    session_id: int,
    student_number: str,
    subclass_id: int,
) -> dict:
    number = validate_student_number(student_number)
    session = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
    if session is None:
        raise IdentityError("Session not found.")
    if session["status"] != "live":
        raise IdentityError("This session is not live.")

    allowed = conn.execute(
        "SELECT 1 FROM session_subclasses WHERE session_id = ? AND subclass_id = ?",
        (session_id, subclass_id),
    ).fetchone()
    if allowed is None:
        raise IdentityError("That subclass is not part of this session.")

    existing = conn.execute(
        "SELECT * FROM participants WHERE session_id = ? AND student_number = ?",
        (session_id, number),
    ).fetchone()
    if existing is not None:
        if existing["subclass_id"] != subclass_id:
            raise IdentityError(
                "This student number already joined a different subclass in this session."
            )
        return dict(existing)

    conn.execute(
        """
        INSERT INTO participants (session_id, student_number, subclass_id)
        VALUES (?, ?, ?)
        """,
        (session_id, number, subclass_id),
    )
    conn.commit()
    row = conn.execute(
        "SELECT * FROM participants WHERE session_id = ? AND student_number = ?",
        (session_id, number),
    ).fetchone()
    return dict(row)


def get_participant(
    conn: sqlite3.Connection, session_id: int, student_number: str
) -> dict | None:
    row = conn.execute(
        "SELECT * FROM participants WHERE session_id = ? AND student_number = ?",
        (session_id, student_number),
    ).fetchone()
    return dict(row) if row else None
