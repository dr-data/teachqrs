import pytest

from app.identity import IdentityError, join_session
from app.questions_io import import_table, parse_csv
from app.sessions import (
    SessionError,
    close_question,
    create_session,
    reopen_for_discussion,
    results_for_question,
    start_session,
    submit_response,
)
from tests.conftest import add_set, add_subclass

CSV = """question_number,prompt,type,choice_a,choice_b,choice_c,choice_d,choice_e,correct,points
1,Pick the energy answer,mcq,Wrong,Mechanical energy,Nope,,,B,1
"""


def _live_two_subclasses(conn):
    set_id = add_set(conn)
    import_table(conn, set_id, parse_csv(CSV))
    t01 = add_subclass(conn, "Tutorial 01", "T01")
    t02 = add_subclass(conn, "Tutorial 02", "T02")
    session = create_session(conn, set_id, "Lesson 1", [t01, t02], mode="interactive")
    session = start_session(conn, session["id"])
    return session, t01, t02


def test_create_fails_without_questions(conn):
    set_id = add_set(conn)
    t01 = add_subclass(conn)
    with pytest.raises(SessionError, match="no visible questions"):
        create_session(conn, set_id, "Empty", [t01])


def test_create_fails_without_subclasses(conn):
    set_id = add_set(conn)
    import_table(conn, set_id, parse_csv(CSV))
    with pytest.raises(SessionError, match="at least one subclass"):
        create_session(conn, set_id, "No groups", [])


def test_subclass_filters_do_not_leak(conn):
    session, t01, t02 = _live_two_subclasses(conn)
    join_session(conn, session["id"], "s001", t01)
    join_session(conn, session["id"], "s002", t02)
    qid = session["current_question_id"]
    submit_response(conn, session["id"], qid, "s001", "B")
    submit_response(conn, session["id"], qid, "s002", "A")
    all_results = results_for_question(conn, session["id"], qid)
    t01_results = results_for_question(conn, session["id"], qid, subclass_id=t01)
    t02_results = results_for_question(conn, session["id"], qid, subclass_id=t02)
    assert all_results["answered"] == 2
    assert t01_results["answered"] == 1
    assert t02_results["answered"] == 1
    t01_keys = {b["key"]: b["count"] for b in t01_results["bars"]}
    t02_keys = {b["key"]: b["count"] for b in t02_results["bars"]}
    assert t01_keys["B"] == 1
    assert t01_keys["A"] == 0
    assert t02_keys["A"] == 1
    assert t02_keys["B"] == 0


def test_submit_before_join_raises(conn):
    session, t01, _t02 = _live_two_subclasses(conn)
    with pytest.raises(IdentityError, match="student number"):
        submit_response(conn, session["id"], session["current_question_id"], "ghost", "A")


def test_change_while_open_updates_same_round(conn):
    session, t01, _t02 = _live_two_subclasses(conn)
    join_session(conn, session["id"], "s001", t01)
    qid = session["current_question_id"]
    first = submit_response(conn, session["id"], qid, "s001", "A")
    second = submit_response(conn, session["id"], qid, "s001", "B")
    assert first["id"] == second["id"]
    assert second["value"] == "B"
    assert second["round"] == 1
    n = conn.execute("SELECT COUNT(*) FROM responses").fetchone()[0]
    assert n == 1


def test_reopen_creates_round_two(conn):
    session, t01, _t02 = _live_two_subclasses(conn)
    join_session(conn, session["id"], "s001", t01)
    qid = session["current_question_id"]
    submit_response(conn, session["id"], qid, "s001", "A")
    close_question(conn, session["id"])
    with pytest.raises(SessionError, match="closed"):
        submit_response(conn, session["id"], qid, "s001", "B")
    reopen_for_discussion(conn, session["id"])
    second = submit_response(conn, session["id"], qid, "s001", "B")
    assert second["round"] == 2
    n = conn.execute("SELECT COUNT(*) FROM responses").fetchone()[0]
    assert n == 2
