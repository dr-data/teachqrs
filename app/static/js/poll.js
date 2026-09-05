(function () {
  const root = document.querySelector(".live-grid");
  if (!root) return;
  const sessionId = root.dataset.session;
  let subclassId = "";
  const barsEl = document.getElementById("bars");
  const promptEl = document.getElementById("prompt");
  const metaEl = document.getElementById("qmeta");
  const joinedEl = document.getElementById("joined");
  const answeredEl = document.getElementById("answered");

  document.getElementById("filters")?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-subclass]");
    if (!btn) return;
    subclassId = btn.dataset.subclass || "";
    document.querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", c === btn));
    tick();
  });

  function render(data) {
    const results = data.results;
    if (!results) {
      promptEl.textContent = "No question selected.";
      barsEl.innerHTML = "";
      return;
    }
    const q = results.question;
    metaEl.textContent = `Question ${q.position} · ${q.type} · round ${results.round}`;
    promptEl.textContent = q.prompt;
    joinedEl.textContent = results.joined;
    answeredEl.textContent = results.answered;
    barsEl.innerHTML = results.bars
      .map((bar) => {
        const keyClass = results.correct && String(results.correct).toLowerCase() === String(bar.key).toLowerCase() ? " key" : "";
        return `<div class="bar${keyClass}"><span>${bar.label}</span><div class="track"><div class="fill" style="width:${bar.pct}%"></div></div><strong>${bar.count}</strong></div>`;
      })
      .join("");
  }

  async function tick() {
    const qs = subclassId ? `?subclass_id=${encodeURIComponent(subclassId)}` : "";
    const res = await fetch(`/api/live/${sessionId}${qs}`, { headers: { Accept: "application/json" } });
    if (!res.ok) return;
    render(await res.json());
  }

  tick();
  setInterval(tick, 1200);
})();
