from pathlib import Path

from openpyxl import Workbook

from app.questions_io import CSV_HEADER, export_csv, import_table, parse_csv, parse_xlsx
from tests.conftest import add_set

SAMPLE = Path(__file__).resolve().parents[1] / "sample_data" / "questions.csv"


def test_sample_csv_imports_three_questions(conn):
    set_id = add_set(conn)
    rows = parse_csv(SAMPLE.read_text())
    result = import_table(conn, set_id, rows)
    assert result.imported == 3
    assert result.errors == []
    prompts = [r["prompt"] for r in conn.execute("SELECT prompt FROM questions ORDER BY position")]
    assert len(prompts) == 3
    assert "conserved" in prompts[0]


def test_export_round_trips_header_and_types(conn):
    set_id = add_set(conn)
    import_table(conn, set_id, parse_csv(SAMPLE.read_text()))
    exported = export_csv(conn, set_id)
    header = exported.splitlines()[0]
    assert header == ",".join(CSV_HEADER)
    again = add_set(conn, title="Copy")
    result = import_table(conn, again, parse_csv(exported))
    assert result.imported == 3
    types = [r[0] for r in conn.execute("SELECT type FROM questions WHERE set_id = ? ORDER BY position", (again,))]
    assert types == ["mcq", "true_false", "short"]


def test_bad_type_is_collected_and_valid_rows_still_import(conn):
    set_id = add_set(conn)
    csv_text = (
        ",".join(CSV_HEADER)
        + "\n"
        + '1,"Good",mcq,A,B,,,,A,1\n'
        + '2,"Bad",not_a_type,A,B,,,,A,1\n'
        + '3,"Also good",true_false,,,,,true,1\n'
    )
    result = import_table(conn, set_id, parse_csv(csv_text))
    assert result.imported == 2
    assert len(result.errors) == 1
    assert "unknown type" in result.errors[0]


def test_xlsx_matches_csv(conn):
    set_id = add_set(conn)
    csv_rows = parse_csv(SAMPLE.read_text())
    import_table(conn, set_id, csv_rows)
    from app.questions_io import export_xlsx

    xlsx_bytes = export_xlsx(conn, set_id)
    parsed = parse_xlsx(xlsx_bytes)
    assert [r["prompt"] for r in parsed] == [r["prompt"] for r in csv_rows]


def test_parse_xlsx_from_workbook():
    wb = Workbook()
    ws = wb.active
    ws.append(CSV_HEADER)
    ws.append([1, "Is 1+1=2?", "true_false", "", "", "", "", "", "true", 1])
    from io import BytesIO

    buf = BytesIO()
    wb.save(buf)
    rows = parse_xlsx(buf.getvalue())
    assert rows[0]["prompt"] == "Is 1+1=2?"
    assert rows[0]["type"] == "true_false"
