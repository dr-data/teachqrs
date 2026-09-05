import pytest

from app.identity import IdentityError, join_session, validate_student_number
from tests.conftest import add_set, add_subclass


def test_blank_rejected():
    with pytest.raises(IdentityError):
        validate_student_number("  ")


def test_none_rejected():
    with pytest.raises(IdentityError):
        validate_student_number(None)


def test_too_short_rejected():
    with pytest.raises(IdentityError):
        validate_student_number("ab")


def test_illegal_charset_rejected():
    with pytest.raises(IdentityError):
        validate_student_number("ab 12")


def test_normalizes_and_accepts():
    assert validate_student_number("  ab-12_3  ") == "ab-12_3"


def test_join_requires_live_session(conn):
    set_id = add_set(conn)
    t01 = add_subclass(conn)
    conn.execute(
        "INSERT INTO questions (set_id, position, prompt, type, choices_json) VALUES (?,1,'Q','short','[]')",
        (set_id,),
    )
    cur = conn.execute(
        "INSERT INTO sessions (set_id, name, join_code, status, mode) VALUES (?,?,?,'draft','survey')",
        (set_id, "L1", "ABCD"),
    )
    session_id = cur.lastrowid
    conn.execute(
        "INSERT INTO session_subclasses (session_id, subclass_id) VALUES (?, ?)",
        (session_id, t01),
    )
    conn.commit()
    with pytest.raises(IdentityError, match="not live"):
        join_session(conn, session_id, "s123", t01)


def test_join_upserts_and_refuses_subclass_switch(conn):
    set_id = add_set(conn)
    t01 = add_subclass(conn, "Tutorial 01", "T01")
    t02 = add_subclass(conn, "Tutorial 02", "T02")
    conn.execute(
        "INSERT INTO questions (set_id, position, prompt, type, choices_json) VALUES (?,1,'Q','short','[]')",
        (set_id,),
    )
    cur = conn.execute(
        "INSERT INTO sessions (set_id, name, join_code, status, mode) VALUES (?,?,?,'live','survey')",
        (set_id, "L1", "ABCD"),
    )
    session_id = cur.lastrowid
    conn.execute("INSERT INTO session_subclasses VALUES (?, ?)", (session_id, t01))
    conn.execute("INSERT INTO session_subclasses VALUES (?, ?)", (session_id, t02))
    conn.commit()

    first = join_session(conn, session_id, "s123", t01)
    again = join_session(conn, session_id, "s123", t01)
    assert first["id"] == again["id"]
    assert again["subclass_id"] == t01

    with pytest.raises(IdentityError, match="different subclass"):
        join_session(conn, session_id, "s123", t02)
