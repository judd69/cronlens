import {
  CronError,
  countRunsInWindow,
  describe,
  detectGotchas,
  fieldMeaning,
  fmtDateTime,
  fmtTime,
  nextRuns,
  parseCron,
  relativeIn,
  runsByDay,
  FIELD_DEFS,
  GOTCHA_EXAMPLES,
  PRESETS,
  type Schedule,
} from "./cron";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const exprInput = $("expr") as HTMLInputElement;
const verdictEl = $("verdict");
const runsEl = $("runs");
const fieldsTable = $("fields-table");
const weekEl = $("week");
const gotchasEl = $("gotchas-list");
const errorBox = $("error-box");
const resultEl = $("result");
const toastEl = $("toast");
const pillMarker = $("pill-marker");
const pillButtons = [...document.querySelectorAll<HTMLButtonElement>("#field-pills button")];

let toastTimer: number | undefined;
function toast(msg: string) {
  toastEl.textContent = msg;
  toastEl.classList.remove("hidden");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.add("hidden"), 2200);
}
async function copy(text: string, msg: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(msg);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    toast(msg);
  }
}

// --- Morphing field pills: one orange pill glides between fields as the caret
// moves (Prompt Motion shape-morph rule, adapted: short spring, tiny overshoot,
// no bounce, no glow). Clicking a pill selects that field's text in the input.
function fieldSpans(value: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  for (const m of value.matchAll(/\S+/g)) {
    spans.push({ start: m.index, end: m.index + m[0].length });
  }
  return spans;
}
function activeFieldIndex(): number {
  const caret = exprInput.selectionStart ?? 0;
  const spans = fieldSpans(exprInput.value);
  if (spans.length === 0) return 0;
  for (let i = 0; i < spans.length; i++) {
    if (caret <= (spans[i] as { end: number }).end) return i;
  }
  return spans.length - 1;
}
function renderPills() {
  const idx = activeFieldIndex();
  pillButtons.forEach((b, i) => b.classList.toggle("active", i === idx));
  const btn = pillButtons[idx];
  const container = btn?.parentElement;
  if (btn && container) {
    const cRect = container.getBoundingClientRect();
    const r = btn.getBoundingClientRect();
    pillMarker.style.opacity = "1";
    pillMarker.style.width = `${r.width}px`;
    pillMarker.style.transform = `translateX(${r.left - cRect.left}px)`;
  }
}
pillButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const idx = Number(btn.dataset.field);
    const spans = fieldSpans(exprInput.value);
    const span = spans[idx];
    exprInput.focus();
    if (span) exprInput.setSelectionRange(span.start, span.end);
    else exprInput.setSelectionRange(0, 0);
    renderPills();
  });
});

function render(schedule: Schedule, now: Date) {
  errorBox.classList.add("hidden");
  resultEl.classList.remove("hidden");
  verdictEl.textContent = describe(schedule);
  const next = nextRuns(schedule, now, 10);
  const nextEl = $("next-run");
  if (schedule.reboot) {
    nextEl.textContent = "No next run — @reboot";
  } else if (next.length > 0) {
    nextEl.textContent = `Next run ${relativeIn(now, next[0] as Date)} · ${fmtDateTime(next[0] as Date)}`;
  } else {
    nextEl.textContent = "Never runs in the next 4 years";
  }
  const in30 = countRunsInWindow(schedule, now, 30);
  $("freq").textContent = schedule.reboot
    ? "Once per boot"
    : `≈ ${in30} run${in30 === 1 ? "" : "s"} in the next 30 days`;
  $("tz-note").textContent = `Times in ${Intl.DateTimeFormat().resolvedOptions().timeZone ?? "local time"}`;

  runsEl.innerHTML = "";
  if (next.length === 0) {
    runsEl.innerHTML = "<li><span>No upcoming runs found.</span><span class='rel'>check the gotchas below</span></li>";
  } else {
    for (const d of next) {
      const li = document.createElement("li");
      const when = document.createElement("span");
      when.textContent = fmtDateTime(d);
      const rel = document.createElement("span");
      rel.className = "rel";
      rel.textContent = relativeIn(now, d);
      li.append(when, rel);
      runsEl.appendChild(li);
    }
  }

  fieldsTable.innerHTML = "";
  if (schedule.reboot) {
    fieldsTable.innerHTML = "<tr><td colspan='3'>@reboot has no fields — it runs once at startup.</td></tr>";
  } else {
    for (const f of schedule.fields) {
      const tr = document.createElement("tr");
      const name = document.createElement("td");
      name.textContent = f.def.label;
      const raw = document.createElement("td");
      const code = document.createElement("code");
      code.textContent = f.raw;
      raw.appendChild(code);
      const meaning = document.createElement("td");
      meaning.textContent = fieldMeaning(f);
      tr.append(name, raw, meaning);
      fieldsTable.appendChild(tr);
    }
  }

  weekEl.innerHTML = "";
  const days = runsByDay(schedule, now, 7);
  for (const day of days) {
    const row = document.createElement("div");
    row.className = "week-row";
    const label = document.createElement("div");
    label.className = "week-day";
    label.textContent = `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day.date.getDay()]} ${day.date.getDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][day.date.getMonth()]}`;
    const times = document.createElement("div");
    times.className = "week-times";
    if (day.times.length === 0) {
      const none = document.createElement("span");
      none.className = "none";
      none.textContent = "no runs";
      times.appendChild(none);
    } else {
      for (const t of day.times) {
        const s = document.createElement("span");
        s.textContent = t;
        times.appendChild(s);
      }
    }
    row.append(label, times);
    weekEl.appendChild(row);
  }

  gotchasEl.innerHTML = "";
  const gotchas = detectGotchas(schedule, next);
  for (const g of gotchas) {
    const li = document.createElement("li");
    const badge = document.createElement("span");
    badge.className = `badge badge-${g.level}`;
    badge.textContent = g.level.toUpperCase();
    const title = document.createElement("strong");
    title.textContent = g.title;
    const detail = document.createElement("p");
    detail.textContent = g.detail;
    li.append(badge, title, detail);
    gotchasEl.appendChild(li);
  }
}

function renderError(err: unknown) {
  resultEl.classList.add("hidden");
  errorBox.classList.remove("hidden");
  if (err instanceof CronError) {
    errorBox.innerHTML = "";
    const strong = document.createElement("strong");
    strong.textContent = err.message;
    errorBox.appendChild(strong);
    if (err.hint) {
      const p = document.createElement("p");
      p.className = "hint-text";
      p.textContent = err.hint;
      errorBox.appendChild(p);
    }
  } else {
    errorBox.textContent = "Could not parse that expression.";
  }
}

let debounce: number | undefined;
function update() {
  window.clearTimeout(debounce);
  debounce = window.setTimeout(() => {
    try {
      const schedule = parseCron(exprInput.value);
      render(schedule, new Date());
    } catch (e) {
      renderError(e);
    }
    renderPills();
    const url = new URL(window.location.href);
    url.searchParams.set("q", exprInput.value);
    window.history.replaceState(null, "", url);
  }, 120);
}

// Presets + trap examples
const presetsEl = $("presets");
for (const p of PRESETS) {
  const b = document.createElement("button");
  b.textContent = p.label;
  b.title = p.expr;
  b.addEventListener("click", () => {
    exprInput.value = p.expr;
    exprInput.focus();
    update();
  });
  presetsEl.appendChild(b);
}
const trapsEl = $("traps");
for (const t of GOTCHA_EXAMPLES) {
  const b = document.createElement("button");
  const strong = document.createElement("strong");
  strong.textContent = t.label;
  const code = document.createElement("code");
  code.textContent = t.expr;
  const note = document.createElement("span");
  note.textContent = t.note;
  b.append(strong, code, note);
  b.addEventListener("click", () => {
    exprInput.value = t.expr;
    document.getElementById("explain")?.scrollIntoView({ behavior: "smooth" });
    exprInput.focus();
    update();
  });
  trapsEl.appendChild(b);
}

// Copy actions
$("copy-expr").addEventListener("click", () => void copy(exprInput.value, "Expression copied"));
$("copy-summary").addEventListener("click", () => {
  try {
    const s = parseCron(exprInput.value);
    const next = nextRuns(s, new Date(), 1);
    void copy(
      `${s.expression} — ${describe(s)} Next run: ${next.length ? fmtDateTime(next[0] as Date) : "never"}.`,
      "Summary copied",
    );
  } catch {
    toast("Fix the expression first");
  }
});
$("copy-crontab").addEventListener("click", () => {
  try {
    const s = parseCron(exprInput.value);
    void copy(`${s.expression} /usr/local/bin/your-job.sh`, "Crontab line copied — swap in your command");
  } catch {
    toast("Fix the expression first");
  }
});
$("copy-link").addEventListener("click", () => {
  const url = new URL(window.location.href);
  url.searchParams.set("q", exprInput.value);
  void copy(url.toString(), "Share link copied");
});

// Builder
const patternEl = $("b-pattern") as HTMLSelectElement;
const minuteEl = $("b-minute") as HTMLInputElement;
const hourEl = $("b-hour") as HTMLInputElement;
const nEl = $("b-n") as HTMLInputElement;
const dowEl = $("b-dow") as HTMLSelectElement;
const domEl = $("b-dom") as HTMLInputElement;
const monthEl = $("b-month") as HTMLSelectElement;
function builderExpr(): string {
  const m = minuteEl.value || "0";
  const h = hourEl.value || "0";
  switch (patternEl.value) {
    case "every-minute": return "* * * * *";
    case "every-n": return `*/${nEl.value || "15"} * * * *`;
    case "hourly": return `${m} * * * *`;
    case "daily": return `${m} ${h} * * *`;
    case "weekdays": return `${m} ${h} * * 1-5`;
    case "weekly": return `${m} ${h} * * ${dowEl.value}`;
    case "monthly": return `${m} ${h} ${domEl.value || "1"} * *`;
    case "yearly": return `${m} ${h} ${domEl.value || "1"} ${monthEl.value} *`;
    default: return `${m} ${h} * * *`;
  }
}
function syncBuilder() {
  const p = patternEl.value;
  const show = (id: string, visible: boolean) => {
    $(id).style.display = visible ? "" : "none";
  };
  show("b-n-wrap", p === "every-n");
  show("b-minute-wrap", !["every-minute", "every-n"].includes(p));
  show("b-hour-wrap", !["every-minute", "every-n", "hourly"].includes(p));
  show("b-dow-wrap", p === "weekly");
  show("b-dom-wrap", ["monthly", "yearly"].includes(p));
  show("b-month-wrap", p === "yearly");
  $("b-output").textContent = builderExpr();
}
for (const el of [patternEl, minuteEl, hourEl, nEl, dowEl, domEl, monthEl]) {
  el.addEventListener("input", syncBuilder);
  el.addEventListener("change", syncBuilder);
}
$("b-apply").addEventListener("click", () => {
  exprInput.value = builderExpr();
  document.getElementById("explain")?.scrollIntoView({ behavior: "smooth" });
  exprInput.focus();
  update();
});

// Init from ?q=, then first render
const initial = new URLSearchParams(window.location.search).get("q");
if (initial) exprInput.value = initial;
exprInput.addEventListener("input", update);
exprInput.addEventListener("click", renderPills);
exprInput.addEventListener("keyup", renderPills);
exprInput.addEventListener("focus", renderPills);
window.addEventListener("resize", renderPills);
syncBuilder();
update();
window.setTimeout(renderPills, 50);
