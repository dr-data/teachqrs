export function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function layout(opts: {
  title: string;
  bodyClass?: string;
  body: string;
  scripts?: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(opts.title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:ital,wght@0,400;0,700;1,400&family=Fraunces:opsz,wght@9..144,500;9..144,700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/static/css/app.css">
</head>
<body class="${esc(opts.bodyClass ?? "")}">
  ${opts.body}
  ${opts.scripts ?? ""}
</body>
</html>`;
}

export function flashHtml(flash: { m: string; e?: boolean } | null): string {
  if (!flash) return "";
  return `<p class="flash ${flash.e ? "bad" : ""}">${esc(flash.m)}</p>`;
}

type Q = {
  id: number;
  position: number;
  prompt: string;
  type: string;
  choices: string[];
  correct?: string | null;
  visible?: number;
};

export function homePage() {
  return layout({
    title: "TeachQRS",
    bodyClass: "page-home",
    body: `<main class="shell">
  <p class="eyebrow">Classroom quick response</p>
  <h1>TeachQRS</h1>
  <p class="lede">Join with the 4-character code on the projector. Your student number is required before any question appears.</p>
  <form class="join-box" method="post" action="/join">
    <label for="code">Join code</label>
    <input id="code" name="code" maxlength="8" autocapitalize="characters" autocomplete="off" required>
    <button type="submit">Join session</button>
  </form>
  <p class="fine"><a href="/teacher">Teacher login</a></p>
</main>`,
  });
}

export function setupPage(flash: { m: string; e?: boolean } | null) {
  return layout({
    title: "Set password",
    body: `<main class="shell narrow">
  <p class="eyebrow">First run</p>
  <h1>Protect this classroom</h1>
  <p class="lede">Set a teacher password stored in Cloudflare D1. Students never see it.</p>
  ${flashHtml(flash)}
  <form method="post" action="/teacher/setup" class="stack">
    <label>Password <input type="password" name="password" minlength="6" required></label>
    <label>Confirm <input type="password" name="confirm" minlength="6" required></label>
    <button type="submit">Create teacher login</button>
  </form>
</main>`,
  });
}

export function loginPage(flash: { m: string; e?: boolean } | null) {
  return layout({
    title: "Teacher login",
    body: `<main class="shell narrow">
  <p class="eyebrow">Teacher</p>
  <h1>Sign in</h1>
  ${flashHtml(flash)}
  <form method="post" action="/teacher/login" class="stack">
    <label>Password <input type="password" name="password" required></label>
    <button type="submit">Open dashboard</button>
  </form>
</main>`,
  });
}

export function dashboardPage(opts: {
  flash: { m: string; e?: boolean } | null;
  sets: { id: number; title: string; mode: string }[];
  subclasses: { id: number; name: string; code: string }[];
  sessions: { id: number; name: string; join_code: string; status: string; set_title: string }[];
}) {
  const start =
    opts.sets.length && opts.subclasses.length
      ? `<form method="post" action="/teacher/sessions" class="grid-form">
      <label>Session name <input name="name" placeholder="Lecture 4 — energy" required></label>
      <label>Question set
        <select name="set_id" required>
          ${opts.sets.map((s) => `<option value="${s.id}">${esc(s.title)}</option>`).join("")}
        </select>
      </label>
      <label>Mode
        <select name="mode">
          <option value="interactive">Interactive (one question at a time)</option>
          <option value="survey">Survey (all questions at once)</option>
        </select>
      </label>
      <fieldset>
        <legend>Subclasses that may join</legend>
        ${opts.subclasses
          .map(
            (sc, i) =>
              `<label class="check"><input type="checkbox" name="subclass_ids" value="${sc.id}" ${i === 0 ? "checked" : ""}> ${esc(sc.code)} — ${esc(sc.name)}</label>`,
          )
          .join("")}
      </fieldset>
      <button type="submit">Start live session</button>
    </form>`
      : `<p class="hint">Add at least one subclass and one question set first.</p>`;
  return layout({
    title: "Teacher dashboard",
    bodyClass: "page-admin",
    body: `<header class="topbar">
  <strong>TeachQRS</strong>
  <form method="post" action="/teacher/logout"><button class="text">Sign out</button></form>
</header>
<main class="admin">
  ${flashHtml(opts.flash)}
  <section>
    <h1>Start a live session</h1>
    <p class="hint">One question set, one or more subclasses. Students enter a student number, then answer the same items.</p>
    ${start}
  </section>
  <section>
    <h2>Subclasses</h2>
    <form method="post" action="/teacher/subclasses" class="row-form">
      <input name="code" placeholder="T01" required maxlength="12">
      <input name="name" placeholder="Tutorial 01" required>
      <button type="submit">Add</button>
    </form>
    <ul class="plain">
      ${
        opts.subclasses.length
          ? opts.subclasses
              .map(
                (sc) => `<li>
        <span>${esc(sc.code)} — ${esc(sc.name)}</span>
        <form method="post" action="/teacher/subclasses/${sc.id}/delete"><button class="text danger">Remove</button></form>
      </li>`,
              )
              .join("")
          : "<li>None yet. Add T01 / T02 so the same quiz can be filtered by group.</li>"
      }
    </ul>
  </section>
  <section>
    <h2>Question sets</h2>
    <form method="post" action="/teacher/sets" class="row-form">
      <input name="title" placeholder="Week 3 conceptual check" required>
      <select name="mode">
        <option value="interactive">Interactive</option>
        <option value="survey">Survey</option>
      </select>
      <button type="submit">Create set</button>
    </form>
    <ul class="plain">
      ${
        opts.sets.length
          ? opts.sets.map((s) => `<li><a href="/teacher/sets/${s.id}">${esc(s.title)}</a> <em>${esc(s.mode)}</em></li>`).join("")
          : "<li>No sets yet. Create one, then import a CSV or Excel file.</li>"
      }
    </ul>
  </section>
  <section>
    <h2>Recent sessions</h2>
    <ul class="plain">
      ${
        opts.sessions.length
          ? opts.sessions
              .map(
                (s) => `<li>
        <a href="/live/${s.id}">${esc(s.name)}</a>
        <code>${esc(s.join_code)}</code>
        <em>${esc(s.status)}</em>
        · ${esc(s.set_title)}
        <a href="/teacher/sessions/${s.id}/export.csv">Export responses CSV</a>
      </li>`,
              )
              .join("")
          : "<li>No sessions yet.</li>"
      }
    </ul>
  </section>
</main>`,
  });
}

export function setPage(opts: {
  flash: { m: string; e?: boolean } | null;
  qset: { id: number; title: string; mode: string; welcome_message: string; thanks_message: string };
  questions: Q[];
}) {
  const qs = opts.questions
    .map(
      (q) => `<li class="${q.visible ? "" : "dim"}">
        <p><strong>Q${q.position}</strong> · ${esc(q.type)}${q.correct ? ` · key ${esc(q.correct)}` : ""}${q.visible ? "" : " · hidden"}</p>
        <p>${esc(q.prompt)}</p>
        ${q.choices.length ? `<ul>${q.choices.map((c, i) => `<li>${"ABCDE"[i]}. ${esc(c)}</li>`).join("")}</ul>` : ""}
        <div class="row-links">
          <form method="post" action="/teacher/sets/${opts.qset.id}/questions/${q.id}/move"><input type="hidden" name="direction" value="up"><button class="text">Up</button></form>
          <form method="post" action="/teacher/sets/${opts.qset.id}/questions/${q.id}/move"><input type="hidden" name="direction" value="down"><button class="text">Down</button></form>
          <form method="post" action="/teacher/sets/${opts.qset.id}/questions/${q.id}/toggle"><button class="text">${q.visible ? "Hide" : "Show"}</button></form>
          <form method="post" action="/teacher/sets/${opts.qset.id}/questions/${q.id}/delete"><button class="text danger">Delete</button></form>
        </div>
      </li>`,
    )
    .join("");
  return layout({
    title: opts.qset.title,
    bodyClass: "page-admin",
    body: `<header class="topbar">
  <a href="/teacher">Dashboard</a>
  <strong>${esc(opts.qset.title)}</strong>
</header>
<main class="admin">
  ${flashHtml(opts.flash)}
  <section>
    <h1>Question set</h1>
    <form method="post" action="/teacher/sets/${opts.qset.id}" class="stack">
      <label>Title <input name="title" value="${esc(opts.qset.title)}" required></label>
      <label>Mode
        <select name="mode">
          <option value="interactive" ${opts.qset.mode === "interactive" ? "selected" : ""}>Interactive</option>
          <option value="survey" ${opts.qset.mode === "survey" ? "selected" : ""}>Survey</option>
        </select>
      </label>
      <label>Welcome message <textarea name="welcome_message" rows="2">${esc(opts.qset.welcome_message)}</textarea></label>
      <label>Thank-you message <textarea name="thanks_message" rows="2">${esc(opts.qset.thanks_message)}</textarea></label>
      <button type="submit">Save set</button>
    </form>
    <p class="row-links">
      <a href="/teacher/sets/${opts.qset.id}/export.csv">Export CSV</a>
      <a href="/teacher/sets/${opts.qset.id}/export.xlsx">Export Excel</a>
      <a href="/teacher/sets/template.csv">Download import template</a>
    </p>
  </section>
  <section>
    <h2>Import questions</h2>
    <p class="hint">CSV or Excel with header: question_number, prompt, type, choice_a…e, correct, points.</p>
    <form method="post" action="/teacher/sets/${opts.qset.id}/import" enctype="multipart/form-data" class="row-form">
      <input type="file" name="file" accept=".csv,.xlsx,.xls" required>
      <button type="submit">Import</button>
    </form>
  </section>
  <section>
    <h2>Questions</h2>
    <ol class="questions">${qs || "<li>No questions yet. Import a file or add one below.</li>"}</ol>
  </section>
  <section>
    <h2>Add one question</h2>
    <form method="post" action="/teacher/sets/${opts.qset.id}/questions" class="stack">
      <label>Prompt <textarea name="prompt" rows="2" required></textarea></label>
      <label>Type
        <select name="type">
          <option value="mcq">Multiple choice</option>
          <option value="true_false">True / false</option>
          <option value="short">Short text</option>
        </select>
      </label>
      <div class="choice-grid">
        <input name="choice_a" placeholder="A">
        <input name="choice_b" placeholder="B">
        <input name="choice_c" placeholder="C">
        <input name="choice_d" placeholder="D">
        <input name="choice_e" placeholder="E">
      </div>
      <label>Correct (A–E, true/false, or exact short text; blank = survey)
        <input name="correct" placeholder="B">
      </label>
      <label>Points <input name="points" type="number" step="0.5" value="1"></label>
      <button type="submit">Add question</button>
    </form>
  </section>
</main>`,
  });
}

export function livePage(opts: {
  session: {
    id: number;
    name: string;
    join_code: string;
    status: string;
    mode: string;
    current_round: number;
  };
  subclasses: { id: number; code: string }[];
  joinUrl: string;
}) {
  const chips = opts.subclasses
    .map((sc) => `<button type="button" class="chip" data-subclass="${sc.id}">${esc(sc.code)}</button>`)
    .join("");
  const controls =
    opts.session.mode === "interactive" && opts.session.status === "live"
      ? `<div class="controls">
      <form method="post" action="/live/${opts.session.id}/open"><button>Open answers</button></form>
      <form method="post" action="/live/${opts.session.id}/close-question"><button class="secondary">Close &amp; reveal</button></form>
      <form method="post" action="/live/${opts.session.id}/reopen"><button class="secondary">Reopen for discussion</button></form>
      <form method="post" action="/live/${opts.session.id}/next"><input type="hidden" name="direction" value="prev"><button class="secondary">Previous</button></form>
      <form method="post" action="/live/${opts.session.id}/next"><input type="hidden" name="direction" value="next"><button class="secondary">Next</button></form>
    </div>`
      : "";
  const end =
    opts.session.status === "live"
      ? `<form method="post" action="/live/${opts.session.id}/close" class="end"><button class="danger">End session</button></form>`
      : `<p class="hint">Session closed. Export the CSV from the header.</p>`;
  return layout({
    title: `Live ${opts.session.join_code}`,
    bodyClass: "page-live",
    scripts: `<script src="/static/js/poll.js"></script>`,
    body: `<header class="live-bar">
  <span class="pill ${opts.session.status === "live" ? "on" : ""}">${esc(opts.session.status)}</span>
  <strong>${esc(opts.session.name)}</strong>
  <span>round ${opts.session.current_round}</span>
  <a href="/teacher">Dashboard</a>
  <a href="/teacher/sessions/${opts.session.id}/export.csv">Export CSV</a>
</header>
<div class="live-grid" data-session="${opts.session.id}" data-mode="${esc(opts.session.mode)}">
  <aside class="join-panel">
    <p class="eyebrow">Students join</p>
    <p class="join-code">${esc(opts.session.join_code)}</p>
    <img class="qr" alt="Join QR code" src="/live/${opts.session.id}/qr.png">
    <p class="join-url">${esc(opts.joinUrl)}</p>
    <p class="counts"><span id="joined">0</span> joined · <span id="answered">0</span> answered</p>
    <div class="filters" id="filters">
      <button type="button" class="chip on" data-subclass="">All</button>
      ${chips}
    </div>
  </aside>
  <section class="stage">
    <p class="eyebrow" id="qmeta">Question</p>
    <h1 id="prompt">Waiting…</h1>
    <div id="bars" class="bars"></div>
    ${controls}
    ${end}
  </section>
</div>`,
  });
}

export function welcomePage(opts: {
  flash: { m: string; e?: boolean } | null;
  session: { join_code: string; status: string };
  qset: { title: string; welcome_message: string };
  subclasses: { id: number; name: string; code: string }[];
}) {
  let form = `<p class="flash bad">This session is not live.</p>`;
  if (opts.session.status === "live") {
    const subclassField =
      opts.subclasses.length === 1
        ? `<input type="hidden" name="subclass_id" value="${opts.subclasses[0].id}">
      <p class="hint">You will be recorded in subclass <strong>${esc(opts.subclasses[0].code)}</strong>.</p>`
        : `<fieldset>
        <legend>Subclass</legend>
        ${opts.subclasses
          .map(
            (sc) =>
              `<label class="check"><input type="radio" name="subclass_id" value="${sc.id}" required> ${esc(sc.code)} — ${esc(sc.name)}</label>`,
          )
          .join("")}
      </fieldset>`;
    form = `${flashHtml(opts.flash)}
  <form method="post" action="/j/${esc(opts.session.join_code)}/join" class="stack">
    <label>Student number
      <input name="student_number" required minlength="3" maxlength="20" autocomplete="username" autocapitalize="off" placeholder="e.g. 3035123456">
    </label>
    ${subclassField}
    <button type="submit">Continue to questions</button>
  </form>`;
  }
  return layout({
    title: `Join ${opts.session.join_code}`,
    bodyClass: "page-phone",
    body: `<main class="phone">
  <p class="eyebrow">${esc(opts.session.join_code)} · ${esc(opts.qset.title)}</p>
  <h1>Before you answer</h1>
  <p class="lede">${esc(opts.qset.welcome_message)}</p>
  ${form}
</main>`,
  });
}

function questionCard(opts: {
  q: Q;
  session: { join_code: string; mode: string; collecting: number };
  answers: Record<number, { value: string }>;
}) {
  const { q, session, answers } = opts;
  const disabled = session.mode === "interactive" && !session.collecting ? "disabled" : "";
  const current = answers[q.id]?.value;
  let fields = `<input name="value" value="${esc(current ?? "")}" ${disabled} required>`;
  if (q.type === "mcq") {
    fields = q.choices
      .map((c, i) => {
        const letter = "ABCDE"[i];
        return `<label class="choice">
          <input type="radio" name="value" value="${letter}" ${current === letter ? "checked" : ""} ${disabled} required>
          <span>${letter}. ${esc(c)}</span>
        </label>`;
      })
      .join("");
  } else if (q.type === "true_false") {
    fields = `<label class="choice"><input type="radio" name="value" value="true" ${current === "true" ? "checked" : ""} ${disabled} required> True</label>
      <label class="choice"><input type="radio" name="value" value="false" ${current === "false" ? "checked" : ""} ${disabled} required> False</label>`;
  }
  return `<article class="qcard">
  <p class="eyebrow">Question ${q.position}</p>
  <h2>${esc(q.prompt)}</h2>
  <form method="post" action="/j/${esc(session.join_code)}/answer">
    <input type="hidden" name="question_id" value="${q.id}">
    ${fields}
    <button type="submit" ${disabled}>${current ? "Update answer" : "Submit answer"}</button>
  </form>
</article>`;
}

export function playPage(opts: {
  flash: { m: string; e?: boolean } | null;
  session: {
    join_code: string;
    mode: string;
    collecting: number;
    current_question_id: number | null;
    current_round: number;
  };
  studentNumber: string;
  questions: Q[];
  answers: Record<number, { value: string; round: number }>;
}) {
  let cards = "";
  if (opts.session.mode === "interactive") {
    const q = opts.questions.find((item) => item.id === opts.session.current_question_id);
    cards = q
      ? questionCard({ q, session: opts.session, answers: opts.answers })
      : `<p class="lede">Waiting for the next question.</p>`;
    if (!opts.session.collecting) {
      cards += `<p class="hint">Answering is closed. Wait for the teacher to reopen or move on.</p>`;
    }
  } else {
    cards = opts.questions.map((q) => questionCard({ q, session: opts.session, answers: opts.answers })).join("");
  }
  return layout({
    title: "Questions",
    bodyClass: "page-phone",
    scripts: `<script src="/static/js/student.js"></script>`,
    body: `<main class="phone" data-code="${esc(opts.session.join_code)}" data-qid="${opts.session.current_question_id ?? ""}" data-round="${opts.session.current_round}" data-collecting="${opts.session.collecting}">
  <p class="eyebrow">${esc(opts.studentNumber)} · ${esc(opts.session.join_code)} · round ${opts.session.current_round}</p>
  ${flashHtml(opts.flash)}
  ${cards}
</main>`,
  });
}

export function thanksPage(message: string) {
  return layout({
    title: "Thank you",
    bodyClass: "page-phone",
    body: `<main class="phone"><h1>Finished</h1><p class="lede">${esc(message)}</p></main>`,
  });
}

export function errorPage(message: string) {
  return layout({
    title: "Error",
    body: `<main class="shell"><h1>Not available</h1><p class="lede">${esc(message)}</p><p class="fine"><a href="/">Back</a></p></main>`,
  });
}
