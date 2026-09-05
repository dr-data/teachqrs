from app.identity import join_session
from app.questions_io import import_table, parse_csv
from app.responses_io import RESPONSE_HEADER, export_responses_csv
from app.sessions import create_session, reopen_for_discussion, start_session, submit_response
from tests.conftest import add_set, add_subclass

CSV = """question_number,prompt,type,choice_a,choice_b,choice_c,choice_d,choice_e,correct,points
1,Pick the energy answer,mcq,Wrong,Mechanical energy,Nope,,,B,1
"""


def test_export_header_and_identity_columns(conn):
    set_id = add_set(conn)
    import_table(conn, set_id, parse_csv(CSV))
    t01 = add_subclass(conn, "Tutorial 01", "T01")
    t02 = add_subclass(conn, "Tutorial 02", "T02")
    session = start_session(conn, create_session(conn, set_id, "Lesson 1", [t01, t02])["id"])
    join_session(conn, session["id"], "3035123456", t01)
    join_session(conn, session["id"], "3035987654", t02)
    qid = session["current_question_id"]
    submit_response(conn, session["id"], qid, "3035123456", "B")
    submit_response(conn, session["id"], qid, "3035987654", "A")
    reopen_for_discussion(conn, session["id"])
    submit_response(conn, session["id"], qid, "3035123456", "B")

    csv_text = export_responses_csv(conn, session["id"])
    header = csv_text.splitlines()[0]
    assert header == ",".join(RESPONSE_HEADER)
    assert "3035123456" in csv_text
    assert "3035987654" in csv_text
    assert ",T01," in csv_text
    assert ",T02," in csv_text
    assert ",2," in csv_text  # round 2 row
    lines = csv_text.splitlines()
    assert len(lines) == 4  # header + 3 response rows
