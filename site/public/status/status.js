// Human-readable status: providers, demos, Spaces, today's remaining capacity, next reset in IST.
const ist = (iso) =>
  new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  }).format(new Date(iso)) + " IST";
const BREAKER = {
  closed: "Operational",
  half_open: "Standby (re-checked on next use)",
  open: "Paused after errors (retrying in 5 min)",
};
const STATE = {
  live: "Live",
  capacity: "Daily free capacity used — recorded runs only",
  down: "Offline",
  not_deployed: "Not deployed yet",
};
const row = (cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
const n = (x) => (typeof x === "number" ? x.toLocaleString("en-IN") : "—");

const TITLES = fetch("/projects.json")
  .then((r) => r.json())
  .then(({ projects }) => Object.fromEntries(projects.map((p) => [p.slug.replace("-", ""), p.title])))
  .catch(() => ({}));

/** Hides a section (its heading and table) when it has nothing deployed to show. */
const hideSection = (tbodyId) => {
  const table = document.getElementById(tbodyId).closest("table");
  table.hidden = true;
  table.previousElementSibling.hidden = true;
};

async function main() {
  try {
    const s = await (await fetch("/api/status", { cache: "no-store" })).json();
    const titles = await TITLES;
    document.getElementById("summary").textContent =
      `Updated ${ist(s.updatedAt)}. Free quotas reset at ${ist(s.resetsAt)}.`;
    document.getElementById("providers").innerHTML =
      row([
        "Workers AI (gpt-oss-120b, bge-m3, re-ranker)",
        BREAKER[s.providers.workersai.breaker] ?? s.providers.workersai.breaker,
        `${n(s.providers.workersai.neuronsLeft)} neurons`,
      ]) +
      row([
        "Groq (gpt-oss-120b, fallback)",
        BREAKER[s.providers.groq.breaker] ?? s.providers.groq.breaker,
        `${n(s.providers.groq.tokensLeft)} tokens`,
      ]);
    // Only deployed demos and Spaces are listed; undeployed ones appear once they go live.
    const demos = Object.entries(s.projects).filter(([, p]) => p.state !== "not_deployed");
    document.getElementById("projects").innerHTML = demos
      .map(([k, p]) =>
        row([titles[k] ?? k, STATE[p.state] ?? p.state, n(p.neuronsLeft), n(p.groqTokensLeft)]),
      )
      .join("");
    if (demos.length === 0) hideSection("projects");
    const spaces = Object.entries(s.spaces).filter(([, v]) => v !== "not_deployed");
    document.getElementById("spaces").innerHTML = spaces.map(([k, v]) => row([titles[k] ?? k, v])).join("");
    if (spaces.length === 0) hideSection("spaces");
    if (s.lastCron) {
      document
        .getElementById("footer")
        .insertAdjacentHTML(
          "afterbegin",
          `Last scheduled check: ${ist(s.lastCron.ts)} (${s.lastCron.ok ? "ok" : "failed"}) · `,
        );
    }
  } catch {
    document.getElementById("summary").textContent =
      "Status is unavailable right now. The demos still open on their recorded runs.";
  }
}
main();
