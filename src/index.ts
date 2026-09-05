import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import {
  COOKIE_FLASH,
  COOKIE_STUDENT,
  COOKIE_TEACHER,
  hashPassword,
  readPayload,
  signPayload,
  verifyPassword,
} from "./lib/auth";
import { lastId, many, one, run, type QuestionRow, type SessionRow, type SetRow, type SubclassRow } from "./lib/db";
import { allowedSubclasses, IdentityError, joinSession, validateStudentNumber } from "./lib/identity";
import { CSV_HEADER, exportCsv, exportXlsx, importTable, parseCsv, parseXlsx } from "./lib/questions";
import { qrSvg } from "./lib/qr";
import { exportResponsesCsv } from "./lib/responses";
import {
  closeQuestion,
  closeSession,
  createSession,
  nextQuestion,
  openQuestion,
  reopenForDiscussion,
  resetSessionResponses,
  resultsForQuestion,
  SessionError,
  sessionByCode,
  startSession,
  submitResponse,
} from "./lib/sessions";
import {
  dashboardPage,
  errorPage,
  homePage,
  livePage,
  loginPage,
  playPage,
  setPage,
  setupPage,
  thanksPage,
  welcomePage,
} from "./pages";

const app = new Hono<{ Bindings: Env }>();

function secretOf(env: Env): string {
  if (!env.TEACHQRS_SECRET) throw new Error("TEACHQRS_SECRET is not set");
  return env.TEACHQRS_SECRET;
}

function html(body: string, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function redirect(location: string, status = 303) {
  return new Response(null, { status, headers: { Location: location } });
}

function formList(value: unknown): string[] {
  if (value == null || value === "") return [];
  if (Array.isArray(value)) return value.map(String);
  return [String(value)];
}

function formStr(value: unknown): string {
  if (value == null) return "";
  if (typeof File !== "undefined" && value instanceof File) return "";
  return String(value);
}

async function teacherExists(db: D1Database) {
  return Boolean(await one<{ id: number }>(db, "SELECT id FROM teachers LIMIT 1"));
}

async function teacherId(c: { req: { raw: Request }; env: Env }): Promise<number | null> {
  const payload = await readPayload(secretOf(c.env), getCookie(c as never, COOKIE_TEACHER));
  return payload && typeof payload.id === "number" ? payload.id : payload && typeof payload.id === "string" ? Number(payload.id) : null;
}

function bounce(location: string): never {
  throw new HTTPException(303, { res: redirect(location) });
}

async function flashOf(c: { req: { raw: Request }; env: Env }) {
  const payload = await readPayload(secretOf(c.env), getCookie(c as never, COOKIE_FLASH));
  if (!payload || typeof payload.m !== "string") return null;
  return { m: payload.m, e: Boolean(payload.e) };
}

async function redirectFlash(c: { env: Env }, url: string, message: string, error = false) {
  const res = redirect(url);
  const token = await signPayload(secretOf(c.env), { m: message, e: error });
  res.headers.append("Set-Cookie", `${COOKIE_FLASH}=${token}; Path=/; Max-Age=20; SameSite=Lax`);
  return res;
}

function setSignedCookie(res: Response, name: string, token: string, maxAge = 60 * 60 * 24 * 14) {
  res.headers.append("Set-Cookie", `${name}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);
}

app.get("/", () => html(homePage()));

app.post("/join", async (c) => {
  const body = await c.req.parseBody();
  return redirect(`/j/${formStr(body.code).trim().toUpperCase()}`);
});

app.get("/teacher/setup", async (c) => {
  if (await teacherExists(c.env.DB)) return redirect("/teacher/login");
  return html(setupPage(await flashOf(c)));
});

app.post("/teacher/setup", async (c) => {
  if (await teacherExists(c.env.DB)) return redirect("/teacher/login");
  const body = await c.req.parseBody();
  const password = formStr(body.password);
  const confirm = formStr(body.confirm);
  if (password.length < 6) return redirectFlash(c, "/teacher/setup", "Password must be at least 6 characters.", true);
  if (password !== confirm) return redirectFlash(c, "/teacher/setup", "Passwords do not match.", true);
  const inserted = await run(c.env.DB, "INSERT INTO teachers (password_hash) VALUES (?)", await hashPassword(password));
  const res = redirect("/teacher");
  setSignedCookie(res, COOKIE_TEACHER, await signPayload(secretOf(c.env), { id: lastId(inserted) }));
  return res;
});

app.get("/teacher/login", async (c) => {
  if (!(await teacherExists(c.env.DB))) return redirect("/teacher/setup");
  return html(loginPage(await flashOf(c)));
});

app.post("/teacher/login", async (c) => {
  const body = await c.req.parseBody();
  const row = await one<{ id: number; password_hash: string }>(c.env.DB, "SELECT * FROM teachers LIMIT 1");
  if (!row || !(await verifyPassword(formStr(body.password), row.password_hash))) {
    return redirectFlash(c, "/teacher/login", "Wrong password.", true);
  }
  const res = redirect("/teacher");
  setSignedCookie(res, COOKIE_TEACHER, await signPayload(secretOf(c.env), { id: row.id }));
  return res;
});

app.post("/teacher/logout", () => {
  const res = redirect("/");
  res.headers.append("Set-Cookie", `${COOKIE_TEACHER}=; Path=/; Max-Age=0`);
  return res;
});

app.get("/teacher", async (c) => {
  if (!(await teacherExists(c.env.DB))) return redirect("/teacher/setup");
  if ((await teacherId(c)) == null) bounce("/teacher/login");
  const sets = await many<SetRow>(c.env.DB, "SELECT * FROM question_sets ORDER BY id DESC");
  const subclasses = await many<SubclassRow>(c.env.DB, "SELECT * FROM subclasses ORDER BY code");
  const sessions = await many<SessionRow & { set_title: string }>(
    c.env.DB,
    `SELECT s.*, qs.title AS set_title
     FROM sessions s JOIN question_sets qs ON qs.id = s.set_id
     ORDER BY s.id DESC LIMIT 20`,
  );
  return html(dashboardPage({ flash: await flashOf(c), sets, subclasses, sessions }));
});

app.post("/teacher/subclasses", async (c) => {
  if ((await teacherId(c)) == null) bounce("/teacher/login");
  const body = await c.req.parseBody();
  const code = formStr(body.code).trim().toUpperCase();
  const name = formStr(body.name).trim();
  if (!code || !name) return redirectFlash(c, "/teacher", "Subclass name and code are required.", true);
  try {
    await run(c.env.DB, "INSERT INTO subclasses (name, code) VALUES (?, ?)", name, code);
  } catch {
    return redirectFlash(c, "/teacher", "That subclass code already exists.", true);
  }
  return redirectFlash(c, "/teacher", `Subclass ${code} added.`);
});

app.post("/teacher/subclasses/:id/delete", async (c) => {
  if ((await teacherId(c)) == null) bounce("/teacher/login");
  await run(c.env.DB, "DELETE FROM subclasses WHERE id = ?", Number(c.req.param("id")));
  return redirectFlash(c, "/teacher", "Subclass removed.");
});

app.post("/teacher/sets", async (c) => {
  if ((await teacherId(c)) == null) bounce("/teacher/login");
  const body = await c.req.parseBody();
  const mode = formStr(body.mode) === "survey" ? "survey" : "interactive";
  const inserted = await run(
    c.env.DB,
    "INSERT INTO question_sets (title, mode) VALUES (?, ?)",
    formStr(body.title).trim() || "Untitled set",
    mode,
  );
  return redirect(`/teacher/sets/${lastId(inserted)}`);
});

app.get("/teacher/sets/template.csv", async (c) => {
  if ((await teacherId(c)) == null) bounce("/teacher/login");
  return new Response(`${CSV_HEADER.join(",")}\n`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": "attachment; filename=teachqrs-questions-template.csv",
    },
  });
});

app.get("/teacher/sets/:id", async (c) => {
  if ((await teacherId(c)) == null) bounce("/teacher/login");
  const id = Number(c.req.param("id"));
  const qset = await one<SetRow>(c.env.DB, "SELECT * FROM question_sets WHERE id = ?", id);
  if (!qset) return html(errorPage("Question set not found"), 404);
  const questions = (await many<QuestionRow>(c.env.DB, "SELECT * FROM questions WHERE set_id = ? ORDER BY position, id", id)).map(
    (q) => ({ ...q, choices: JSON.parse(q.choices_json || "[]") as string[] }),
  );
  return html(setPage({ flash: await flashOf(c), qset, questions }));
});

app.post("/teacher/sets/:id", async (c) => {
  if ((await teacherId(c)) == null) bounce("/teacher/login");
  const id = Number(c.req.param("id"));
  const body = await c.req.parseBody();
  await run(
    c.env.DB,
    "UPDATE question_sets SET title = ?, mode = ?, welcome_message = ?, thanks_message = ? WHERE id = ?",
    formStr(body.title).trim(),
    formStr(body.mode),
    formStr(body.welcome_message).trim(),
    formStr(body.thanks_message).trim(),
    id,
  );
  return redirectFlash(c, `/teacher/sets/${id}`, "Set saved.");
});

app.post("/teacher/sets/:id/questions", async (c) => {
  if ((await teacherId(c)) == null) bounce("/teacher/login");
  const id = Number(c.req.param("id"));
  const body = await c.req.parseBody();
  const result = await importTable(c.env.DB, id, [
    {
      prompt: formStr(body.prompt),
      type: formStr(body.type),
      choice_a: formStr(body.choice_a),
      choice_b: formStr(body.choice_b),
      choice_c: formStr(body.choice_c),
      choice_d: formStr(body.choice_d),
      choice_e: formStr(body.choice_e),
      correct: formStr(body.correct),
      points: formStr(body.points) || "1",
    },
  ]);
  if (result.errors.length) return redirectFlash(c, `/teacher/sets/${id}`, result.errors[0], true);
  return redirectFlash(c, `/teacher/sets/${id}`, "Question added.");
});

app.post("/teacher/sets/:id/questions/:qid/delete", async (c) => {
  if ((await teacherId(c)) == null) bounce("/teacher/login");
  await run(
    c.env.DB,
    "DELETE FROM questions WHERE id = ? AND set_id = ?",
    Number(c.req.param("qid")),
    Number(c.req.param("id")),
  );
  return redirectFlash(c, `/teacher/sets/${c.req.param("id")}`, "Question deleted.");
});

app.post("/teacher/sets/:id/questions/:qid/toggle", async (c) => {
  if ((await teacherId(c)) == null) bounce("/teacher/login");
  await run(
    c.env.DB,
    "UPDATE questions SET visible = 1 - visible WHERE id = ? AND set_id = ?",
    Number(c.req.param("qid")),
    Number(c.req.param("id")),
  );
  return redirect(`/teacher/sets/${c.req.param("id")}`);
});

app.post("/teacher/sets/:id/questions/:qid/move", async (c) => {
  if ((await teacherId(c)) == null) bounce("/teacher/login");
  const setId = Number(c.req.param("id"));
  const qid = Number(c.req.param("qid"));
  const body = await c.req.parseBody();
  const questions = await many<QuestionRow>(
    c.env.DB,
    "SELECT * FROM questions WHERE set_id = ? ORDER BY position, id",
    setId,
  );
  const idx = questions.findIndex((q) => q.id === qid);
  const swap = formStr(body.direction) === "up" ? idx - 1 : idx + 1;
  if (idx >= 0 && swap >= 0 && swap < questions.length) {
    const a = questions[idx];
    const b = questions[swap];
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE questions SET position = ? WHERE id = ?").bind(b.position, a.id),
      c.env.DB.prepare("UPDATE questions SET position = ? WHERE id = ?").bind(a.position, b.id),
    ]);
  }
  return redirect(`/teacher/sets/${setId}`);
});

app.post("/teacher/sets/:id/import", async (c) => {
  if ((await teacherId(c)) == null) bounce("/teacher/login");
  const id = Number(c.req.param("id"));
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) return redirectFlash(c, `/teacher/sets/${id}`, "Choose a CSV or Excel file.", true);
  let rows: Record<string, unknown>[] = [];
  try {
    const name = file.name.toLowerCase();
    if (name.endsWith(".xlsx") || name.endsWith(".xls")) rows = parseXlsx(await file.arrayBuffer());
    else rows = parseCsv(await file.text());
  } catch (err) {
    return redirectFlash(c, `/teacher/sets/${id}`, `Could not read file: ${err instanceof Error ? err.message : err}`, true);
  }
  const result = await importTable(c.env.DB, id, rows);
  let msg = `Imported ${result.imported} question(s).`;
  if (result.errors.length) msg += ` ${result.errors.slice(0, 5).join(" ")}`;
  return redirectFlash(c, `/teacher/sets/${id}`, msg, Boolean(result.errors.length) && result.imported === 0);
});

app.get("/teacher/sets/:id/export.csv", async (c) => {
  if ((await teacherId(c)) == null) bounce("/teacher/login");
  const id = Number(c.req.param("id"));
  const body = await exportCsv(c.env.DB, id);
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename=teachqrs-questions-${id}.csv`,
    },
  });
});

app.get("/teacher/sets/:id/export.xlsx", async (c) => {
  if ((await teacherId(c)) == null) bounce("/teacher/login");
  const id = Number(c.req.param("id"));
  const body = await exportXlsx(c.env.DB, id);
  return new Response(body, {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename=teachqrs-questions-${id}.xlsx`,
    },
  });
});

app.post("/teacher/sessions", async (c) => {
  if ((await teacherId(c)) == null) bounce("/teacher/login");
  const body = await c.req.parseBody({ all: true });
  const subclassIds = formList(body.subclass_ids).map(Number).filter((n) => Number.isFinite(n));
  try {
    const session = await createSession(
      c.env.DB,
      Number(formStr(body.set_id)),
      formStr(body.name),
      subclassIds,
      formStr(body.mode),
    );
    await startSession(c.env.DB, session.id);
    return redirect(`/live/${session.id}`);
  } catch (err) {
    return redirectFlash(c, "/teacher", err instanceof Error ? err.message : "Could not start session.", true);
  }
});

app.get("/live/:id", async (c) => {
  if ((await teacherId(c)) == null) bounce("/teacher/login");
  const id = Number(c.req.param("id"));
  const session = await one<SessionRow>(c.env.DB, "SELECT * FROM sessions WHERE id = ?", id);
  if (!session) return html(errorPage("Session not found"), 404);
  const subclasses = await allowedSubclasses(c.env.DB, id);
  const joinUrl = `${new URL(c.req.url).origin}/j/${session.join_code}`;
  return html(livePage({ session, subclasses, joinUrl }));
});

app.post("/live/:id/open", async (c) => {
  if ((await teacherId(c)) == null) bounce("/teacher/login");
  await openQuestion(c.env.DB, Number(c.req.param("id")));
  return redirect(`/live/${c.req.param("id")}`);
});
app.post("/live/:id/close-question", async (c) => {
  if ((await teacherId(c)) == null) bounce("/teacher/login");
  await closeQuestion(c.env.DB, Number(c.req.param("id")));
  return redirect(`/live/${c.req.param("id")}`);
});
app.post("/live/:id/reopen", async (c) => {
  if ((await teacherId(c)) == null) bounce("/teacher/login");
  await reopenForDiscussion(c.env.DB, Number(c.req.param("id")));
  return redirect(`/live/${c.req.param("id")}`);
});
app.post("/live/:id/next", async (c) => {
  if ((await teacherId(c)) == null) bounce("/teacher/login");
  const body = await c.req.parseBody();
  await nextQuestion(c.env.DB, Number(c.req.param("id")), formStr(body.direction) === "prev" ? -1 : 1);
  return redirect(`/live/${c.req.param("id")}`);
});
app.post("/live/:id/close", async (c) => {
  if ((await teacherId(c)) == null) bounce("/teacher/login");
  await closeSession(c.env.DB, Number(c.req.param("id")));
  return redirect(`/live/${c.req.param("id")}`);
});
app.post("/live/:id/reset", async (c) => {
  if ((await teacherId(c)) == null) bounce("/teacher/login");
  const id = Number(c.req.param("id"));
  await resetSessionResponses(c.env.DB, id);
  await startSession(c.env.DB, id);
  return redirect(`/live/${id}`);
});

app.get("/live/:id/qr.png", async (c) => {
  if ((await teacherId(c)) == null) bounce("/teacher/login");
  const session = await one<SessionRow>(c.env.DB, "SELECT * FROM sessions WHERE id = ?", Number(c.req.param("id")));
  if (!session) return html(errorPage("Session not found"), 404);
  const url = `${new URL(c.req.url).origin}/j/${session.join_code}`;
  return new Response(qrSvg(url), { headers: { "content-type": "image/svg+xml; charset=utf-8" } });
});

app.get("/teacher/sessions/:id/export.csv", async (c) => {
  if ((await teacherId(c)) == null) bounce("/teacher/login");
  const id = Number(c.req.param("id"));
  const session = await one<SessionRow>(c.env.DB, "SELECT * FROM sessions WHERE id = ?", id);
  if (!session) return html(errorPage("Session not found"), 404);
  const body = await exportResponsesCsv(c.env.DB, id);
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename=teachqrs-responses-${session.join_code}.csv`,
    },
  });
});

app.get("/api/live/:id", async (c) => {
  if ((await teacherId(c)) == null) bounce("/teacher/login");
  const id = Number(c.req.param("id"));
  const session = await one<SessionRow>(c.env.DB, "SELECT * FROM sessions WHERE id = ?", id);
  if (!session) return c.json({ error: "not found" }, 404);
  const subclassId = c.req.query("subclass_id") ? Number(c.req.query("subclass_id")) : null;
  const qid = session.current_question_id;
  const results = qid ? await resultsForQuestion(c.env.DB, id, qid, subclassId) : null;
  if (results?.question) {
    (results.question as QuestionRow & { choices?: string[] }).choices = JSON.parse(results.question.choices_json || "[]");
  }
  return c.json({
    session,
    subclasses: await allowedSubclasses(c.env.DB, id),
    results,
    join_code: session.join_code,
  });
});

app.get("/j/:code", async (c) => {
  const session = await sessionByCode(c.env.DB, c.req.param("code"));
  if (!session) return html(errorPage("Unknown join code"), 404);
  const payload = await readPayload(secretOf(c.env), getCookie(c, COOKIE_STUDENT));
  if (payload?.session_id === session.id && payload.student_number && session.status === "live") {
    return redirect(`/j/${session.join_code}/play`);
  }
  const qset = await one<SetRow>(c.env.DB, "SELECT * FROM question_sets WHERE id = ?", session.set_id);
  if (!qset) return html(errorPage("Question set not found"), 404);
  return html(
    welcomePage({
      flash: await flashOf(c),
      session,
      qset,
      subclasses: await allowedSubclasses(c.env.DB, session.id),
    }),
  );
});

app.post("/j/:code/join", async (c) => {
  const session = await sessionByCode(c.env.DB, c.req.param("code"));
  if (!session) return html(errorPage("Unknown join code"), 404);
  const body = await c.req.parseBody();
  const subclasses = await allowedSubclasses(c.env.DB, session.id);
  let subclassId = body.subclass_id ? Number(formStr(body.subclass_id)) : null;
  if (!subclasses.length) return redirectFlash(c, `/j/${session.join_code}`, "This session has no subclass.", true);
  if (subclassId == null) {
    if (subclasses.length === 1) subclassId = subclasses[0].id;
    else return redirectFlash(c, `/j/${session.join_code}`, "Choose your subclass.", true);
  }
  try {
    validateStudentNumber(formStr(body.student_number));
    const participant = await joinSession(c.env.DB, session.id, formStr(body.student_number), subclassId);
    const res = redirect(`/j/${session.join_code}/play`);
    setSignedCookie(
      res,
      COOKIE_STUDENT,
      await signPayload(secretOf(c.env), {
        session_id: session.id,
        student_number: participant.student_number,
        subclass_id: participant.subclass_id,
      }),
      60 * 60 * 24,
    );
    return res;
  } catch (err) {
    return redirectFlash(c, `/j/${session.join_code}`, err instanceof Error ? err.message : "Could not join.", true);
  }
});

async function requireStudent(c: { req: { raw: Request }; env: Env }, session: SessionRow) {
  const payload = await readPayload(secretOf(c.env), getCookie(c as never, COOKIE_STUDENT));
  if (!payload || payload.session_id !== session.id || !payload.student_number) {
    bounce(`/j/${session.join_code}`);
  }
  return payload as { session_id: number; student_number: string; subclass_id: number };
}

app.get("/j/:code/play", async (c) => {
  const session = await sessionByCode(c.env.DB, c.req.param("code"));
  if (!session) return html(errorPage("Unknown join code"), 404);
  const qset = await one<SetRow>(c.env.DB, "SELECT * FROM question_sets WHERE id = ?", session.set_id);
  if (!qset) return html(errorPage("Question set not found"), 404);
  if (session.status !== "live") return html(thanksPage(qset.thanks_message));
  const payload = await requireStudent(c, session);
  const questions = (await many<QuestionRow>(
    c.env.DB,
    "SELECT * FROM questions WHERE set_id = ? AND visible = 1 ORDER BY position, id",
    session.set_id,
  )).map((q) => ({ ...q, choices: JSON.parse(q.choices_json || "[]") as string[] }));
  const mine = await many<{ question_id: number; value: string; round: number }>(
    c.env.DB,
    "SELECT question_id, value, round FROM responses WHERE session_id = ? AND student_number = ?",
    session.id,
    payload.student_number,
  );
  const answers: Record<number, { value: string; round: number }> = {};
  for (const row of mine) {
    const prev = answers[row.question_id];
    if (!prev || row.round >= prev.round) answers[row.question_id] = row;
  }
  return html(
    playPage({
      flash: await flashOf(c),
      session,
      studentNumber: payload.student_number,
      questions,
      answers,
    }),
  );
});

app.post("/j/:code/answer", async (c) => {
  const session = await sessionByCode(c.env.DB, c.req.param("code"));
  if (!session) return html(errorPage("Unknown join code"), 404);
  const payload = await requireStudent(c, session);
  const body = await c.req.parseBody();
  try {
    await submitResponse(c.env.DB, session.id, Number(formStr(body.question_id)), payload.student_number, formStr(body.value));
  } catch (err) {
    return redirectFlash(c, `/j/${session.join_code}/play`, err instanceof Error ? err.message : "Could not save.", true);
  }
  return redirect(`/j/${session.join_code}/play`);
});

app.get("/api/j/:code/state", async (c) => {
  const session = await sessionByCode(c.env.DB, c.req.param("code"));
  if (!session) return c.json({ error: "not found" }, 404);
  const payload = await readPayload(secretOf(c.env), getCookie(c, COOKIE_STUDENT));
  return c.json({
    identified: Boolean(payload && payload.session_id === session.id && payload.student_number),
    status: session.status,
    mode: session.mode,
    collecting: Boolean(session.collecting),
    current_question_id: session.current_question_id,
    reveal_results: Boolean(session.reveal_results),
    current_round: session.current_round,
  });
});

app.get("/api/session/:code/questions", async (c) => {
  const session = await sessionByCode(c.env.DB, c.req.param("code"));
  if (!session) return c.json({ error: "not found" }, 404);
  const payload = await readPayload(secretOf(c.env), getCookie(c, COOKIE_STUDENT));
  if (!payload || payload.session_id !== session.id || !payload.student_number) {
    return c.json({ error: "Student number required before questions are shown." }, 401);
  }
  const questions = await many<QuestionRow>(
    c.env.DB,
    "SELECT * FROM questions WHERE set_id = ? AND visible = 1 ORDER BY position, id",
    session.set_id,
  );
  const out = [];
  for (const q of questions) {
    if (session.mode === "interactive" && q.id !== session.current_question_id) continue;
    out.push({ ...q, choices: JSON.parse(q.choices_json || "[]") });
  }
  return c.json({ questions: out });
});

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  if (err instanceof Response) return err;
  if (err instanceof IdentityError || err instanceof SessionError) {
    return html(errorPage(err.message), 400);
  }
  console.error(err);
  return html(errorPage("Something went wrong."), 500);
});

app.notFound(async (c) => {
  if (c.req.path.startsWith("/static/")) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return html(errorPage("Not found"), 404);
});

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
} satisfies ExportedHandler<Env>;
