(function () {
  const root = document.querySelector("main.phone[data-code]");
  if (!root) return;
  const code = root.dataset.code;
  const start = {
    qid: root.dataset.qid,
    round: root.dataset.round,
    collecting: root.dataset.collecting,
  };

  async function tick() {
    const res = await fetch(`/api/j/${code}/state`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.status !== "live") {
      window.location.reload();
      return;
    }
    if (
      String(data.current_question_id) !== String(start.qid) ||
      String(data.current_round) !== String(start.round) ||
      String(Number(data.collecting)) !== String(start.collecting)
    ) {
      window.location.reload();
    }
  }

  setInterval(tick, 1500);
})();
