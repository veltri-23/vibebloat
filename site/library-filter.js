function normalized(value) {
  return String(value ?? "").trim().toLowerCase();
}

function selectedSet(values) {
  return new Set((values ?? []).map(normalized).filter(Boolean));
}

function matchesSelection(selected, values) {
  return selected.size === 0 || values.some((value) => selected.has(normalized(value)));
}

export function filterGuardRecords(records, criteria = {}) {
  const terms = normalized(criteria.query).split(/\s+/).filter(Boolean);
  const classes = selectedSet(criteria.classes);
  const confidences = selectedSet(criteria.confidences);
  const agents = selectedSet(criteria.agents);

  return records.filter((record) => {
    const text = normalized(`${record.id} ${record.description} ${record.pattern}`);
    return terms.every((term) => text.includes(term))
      && matchesSelection(classes, [record.class])
      && matchesSelection(confidences, [record.confidence])
      && matchesSelection(agents, record.agents);
  });
}

function selectedValues(root, name) {
  return [...root.querySelectorAll(`input[name="${name}"]:checked`)].map((input) => input.value);
}

export function initializeLibrarySearch(root = document) {
  const section = root.querySelector("#library");
  if (!section) return;

  const search = section.querySelector("#library-search");
  const status = section.querySelector("#library-status");
  const empty = section.querySelector("#library-empty");
  const clear = section.querySelector("#clear-library-filters");
  const rows = [...section.querySelectorAll("[data-guard-row]")];
  const records = rows.map((row) => ({
    id: row.dataset.id,
    description: row.dataset.description,
    pattern: row.dataset.pattern,
    class: row.dataset.class,
    confidence: row.dataset.confidence,
    agents: row.dataset.agents.split(","),
    row,
  }));

  const update = () => {
    const matches = new Set(filterGuardRecords(records, {
      query: search.value,
      classes: selectedValues(section, "class"),
      confidences: selectedValues(section, "confidence"),
      agents: selectedValues(section, "agent"),
    }));
    for (const record of records) record.row.hidden = !matches.has(record);
    empty.hidden = matches.size !== 0;
    status.textContent = matches.size === 0
      ? "No guards match current search and filters."
      : `Showing ${matches.size} of ${records.length} guards.`;
  };

  search.addEventListener("input", update);
  section.addEventListener("change", update);
  clear.addEventListener("click", () => {
    search.value = "";
    for (const input of section.querySelectorAll('input[type="checkbox"]')) input.checked = false;
    update();
    search.focus();
  });
  section.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const menu = event.target.closest("details[open]");
    if (!menu) return;
    menu.open = false;
    menu.querySelector("summary").focus();
  });
  update();
}

if (typeof document !== "undefined") initializeLibrarySearch();
