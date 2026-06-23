const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function esc(s) {
  if (s == null || s === "") return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function crmApi(path) {
  const res = await fetch(path);
  return res.json();
}

async function crmApiPatch(path, body) {
  const res = await fetch(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

let refreshTimer = null;
let pipelineData = null;
let dragAccountId = null;

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function renderStats(data) {
  const el = $("#crm-stats");
  if (!el) return;
  const run = data.run;
  const pct = run?.accounts_total
    ? Math.round((run.accounts_done / run.accounts_total) * 100)
    : 0;

  el.innerHTML = `
    <div class="stat"><div class="stat-value">${esc(data.contacts_total)}</div><div class="stat-label">Contacts</div></div>
    <div class="stat"><div class="stat-value">${esc(data.contacts_with_email)}</div><div class="stat-label">With email</div></div>
    <div class="stat"><div class="stat-value">${esc(data.contacts_with_linkedin)}</div><div class="stat-label">With LinkedIn</div></div>
    <div class="stat"><div class="stat-value">${esc(data.gojiberry_contacts ?? 0)}</div><div class="stat-label">Gojiberry</div></div>
    <div class="stat"><div class="stat-value">${esc(data.contacts_with_phone)}</div><div class="stat-label">With phone</div></div>
    <div class="stat"><div class="stat-value">${esc(data.accounts_enriched)}/${esc(data.accounts_total)}</div><div class="stat-label">Operators enriched</div></div>
    <div class="stat"><div class="stat-value">${esc(data.properties_total)}</div><div class="stat-label">Properties</div></div>
    <div class="stat"><div class="stat-value">${run?.credits_remaining ?? "—"}</div><div class="stat-label">Credits left</div></div>
  `;

  const runEl = $("#crm-run-status");
  if (run) {
    runEl.innerHTML = `
      <div class="run-bar"><div class="run-bar-fill" style="width:${pct}%"></div></div>
      <p class="run-meta">
        <strong>${esc(run.status)}</strong> ·
        ${esc(run.accounts_done ?? 0)} / ${esc(run.accounts_total)} accounts ·
        +${esc(run.contacts_added ?? 0)} contacts ·
        ${esc(run.credits_used ?? 0)} credits used ·
        started ${fmtTime(run.started_at)}
      </p>
    `;
  } else {
    runEl.innerHTML = `<p class="run-meta">No enrichment run recorded yet.</p>`;
  }
}

function contactsTable(rows) {
  if (!rows.length) return `<div class="empty">No contacts match your filters.</div>`;
  return `
    <table class="results-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Title</th>
          <th>Operator</th>
          <th>Market</th>
          <th>Email</th>
          <th>Phone</th>
          <th>LinkedIn</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((c) => `
          <tr class="clickable" data-account-id="${esc(c.account_id)}">
            <td><strong>${esc(c.name)}</strong></td>
            <td>${esc(c.title)}</td>
            <td>${esc(c.group_name)}</td>
            <td><span class="badge badge-warn">${esc(c.tier)}</span> ${esc(c.market_name)}</td>
            <td>${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : "—"}</td>
            <td>${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : "—"}</td>
            <td class="li-cell">${c.linkedin_url ? `<a class="li-link" href="${esc(c.linkedin_url)}" target="_blank" rel="noopener" title="${esc(c.linkedin_url)}">LinkedIn ↗</a>` : "—"}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function accountsTable(rows) {
  if (!rows.length) return `<div class="empty">No operators match your filters.</div>`;
  return `
    <table class="results-table">
      <thead>
        <tr>
          <th>Operator</th>
          <th>Market</th>
          <th>Tier</th>
          <th>Mix</th>
          <th>Properties</th>
          <th>Contacts</th>
          <th>Domain</th>
          <th>Enriched</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((a) => `
          <tr class="clickable" data-account-id="${esc(a.id)}">
            <td><strong>${esc(a.group_name)}</strong></td>
            <td>${esc(a.market_name)}</td>
            <td><span class="badge badge-warn">${esc(a.tier)}</span></td>
            <td>${esc(a.mix)}</td>
            <td>${esc(a.property_count_nyc || 0)} NYC · ${esc(a.property_count_total || 0)} total</td>
            <td>${esc(a.email_count || 0)} / ${esc(a.contact_count || 0)}</td>
            <td>${esc(a.org_domain || "—")}</td>
            <td>${a.getleads_enriched_at ? "✓" : "—"}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

async function openAccountDrawer(id) {
  const drawer = $("#account-drawer");
  const backdrop = $("#drawer-backdrop");
  const body = $("#drawer-body");
  $("#drawer-title").textContent = "Loading…";
  body.innerHTML = `<div class="empty">Loading operator…</div>`;
  drawer.classList.remove("hidden");
  backdrop.classList.remove("hidden");

  const data = await crmApi(`/api/crm/accounts/${id}`);
  if (!data.ok) {
    body.innerHTML = `<div class="empty">Could not load operator.</div>`;
    return;
  }

  const a = data.account;
  $("#drawer-title").textContent = a.group_name;

  body.innerHTML = `
    <div class="drawer-section">
      <p class="drawer-kicker">${esc(a.market_name)} · ${esc(a.tier)} · ${esc(a.mix)} · ${esc(a.stage)}</p>
      <p>${esc(a.org_about_us || a.hq_address || "")}</p>
      <div class="drawer-facts">
        <span>Domain: <strong>${esc(a.org_domain || "—")}</strong></span>
        <span>Industry: ${esc(a.org_industry || "—")}</span>
        <span>Headcount: ${esc(a.employee_count_range || "—")}</span>
        <span>Properties: ${esc(a.property_count_nyc)} NYC / ${esc(a.property_count_total)} total</span>
      </div>
    </div>
    <div class="drawer-section">
      <h3>Contacts (${data.contacts.length})</h3>
      ${contactsTable(data.contacts)}
    </div>
    ${data.properties.length ? `
    <div class="drawer-section">
      <h3>Properties (${data.properties.length}${data.properties.length >= 50 ? "+" : ""})</h3>
      <ul class="prop-list">
        ${data.properties.map((p) => `<li><strong>${esc(p.name)}</strong> — ${esc(p.neighborhood || p.address || "")}</li>`).join("")}
      </ul>
    </div>` : ""}
  `;

  body.querySelectorAll("[data-account-id]").forEach((row) => {
    row.addEventListener("click", (e) => e.stopPropagation());
  });
}

function closeDrawer() {
  $("#account-drawer").classList.add("hidden");
  $("#drawer-backdrop").classList.add("hidden");
}

async function loadContacts() {
  const q = $("#crm-contact-search")?.value || "";
  const hasEmail = $("#crm-email-only")?.checked ? "1" : "";
  const hasLinkedIn = $("#crm-linkedin-only")?.checked ? "1" : "";
  const source = $("#crm-gojiberry-only")?.checked ? "gojiberry" : "";
  const data = await crmApi(
    `/api/crm/contacts?q=${encodeURIComponent(q)}&has_email=${hasEmail}&has_linkedin=${hasLinkedIn}&source=${source}&limit=300`,
  );
  const el = $("#crm-contacts-table");
  el.innerHTML = contactsTable(data.rows || []);
  $("#crm-contacts-meta").textContent = `Showing ${(data.rows || []).length} of ${data.total ?? 0} contacts`;
  bindRowClicks(el);
}

async function loadAccounts() {
  const q = $("#crm-account-search")?.value || "";
  const tier = $("#crm-tier-filter")?.value || "";
  const market = $("#crm-market-filter")?.value || "";
  const data = await crmApi(
    `/api/crm/accounts?q=${encodeURIComponent(q)}&tier=${encodeURIComponent(tier)}&market=${encodeURIComponent(market)}&limit=200`,
  );
  const el = $("#crm-accounts-table");
  el.innerHTML = accountsTable(data.rows || []);
  $("#crm-accounts-meta").textContent = `Showing ${(data.rows || []).length} of ${data.total ?? 0} operators`;
  bindRowClicks(el);
}

function bindRowClicks(container) {
  container.querySelectorAll("tr.clickable").forEach((row) => {
    row.addEventListener("click", () => openAccountDrawer(row.dataset.accountId));
  });
}

async function loadMarkets() {
  const data = await crmApi("/api/crm/markets");
  for (const sel of ["#crm-market-filter", "#crm-pipeline-market"]) {
    const el = $(sel);
    if (!el) continue;
    for (const m of data.markets || []) {
      const opt = document.createElement("option");
      opt.value = m.market_key;
      opt.textContent = m.market_name;
      el.appendChild(opt);
    }
  }
}

function kanbanCard(account) {
  return `
    <article
      class="kanban-card"
      draggable="true"
      data-account-id="${esc(account.id)}"
      data-stage="${esc(account.stage)}"
    >
      <div class="kanban-card-top">
        <strong>${esc(account.group_name)}</strong>
        ${account.is_gojiberry ? '<span class="badge badge-ok">Gojiberry</span>' : ""}
      </div>
      <p class="kanban-card-meta">
        <span class="badge badge-warn">${esc(account.tier)}</span>
        ${esc(account.market_name || "")}
      </p>
      <p class="kanban-card-foot">
        ${esc(account.email_count || 0)} emails · ${esc(account.contact_count || 0)} contacts
      </p>
    </article>
  `;
}

function renderKanbanBoard(data) {
  pipelineData = data;
  const board = $("#crm-pipeline-board");
  if (!board) return;

  if (!data?.stages?.length) {
    board.innerHTML = `<div class="empty">No pipeline data.</div>`;
    return;
  }

  board.innerHTML = data.stages
    .map(
      (col) => `
    <section class="kanban-column" data-stage="${esc(col.id)}">
      <header class="kanban-column-header">
        <h3>${esc(col.label)}</h3>
        <span class="kanban-count">${esc(col.count)}</span>
      </header>
      <p class="kanban-column-hint">${esc(col.hint)}</p>
      <div class="kanban-column-body" data-drop-stage="${esc(col.id)}">
        ${(col.accounts || []).map(kanbanCard).join("") || `<div class="kanban-empty">Drop here</div>`}
      </div>
    </section>
  `,
    )
    .join("");

  bindKanbanDragDrop(board);
  $("#crm-pipeline-meta").textContent = `${data.total ?? 0} operators on board · drag to move`;
}

function bindKanbanDragDrop(board) {
  board.querySelectorAll(".kanban-card").forEach((card) => {
    card.addEventListener("dragstart", (e) => {
      dragAccountId = card.dataset.accountId;
      card.classList.add("dragging");
      e.dataTransfer?.setData("text/plain", dragAccountId);
      e.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => {
      card.classList.remove("dragging");
      dragAccountId = null;
      board.querySelectorAll(".kanban-column-body").forEach((b) => b.classList.remove("drag-over"));
    });
    card.addEventListener("click", () => openAccountDrawer(card.dataset.accountId));
  });

  board.querySelectorAll(".kanban-column-body").forEach((body) => {
    body.addEventListener("dragover", (e) => {
      e.preventDefault();
      body.classList.add("drag-over");
      e.dataTransfer.dropEffect = "move";
    });
    body.addEventListener("dragleave", () => body.classList.remove("drag-over"));
    body.addEventListener("drop", async (e) => {
      e.preventDefault();
      body.classList.remove("drag-over");
      const accountId = e.dataTransfer?.getData("text/plain") || dragAccountId;
      const newStage = body.dataset.dropStage;
      if (!accountId || !newStage) return;

      const card = board.querySelector(`[data-account-id="${accountId}"]`);
      const oldStage = card?.dataset.stage;
      if (!card || oldStage === newStage) return;

      body.querySelector(".kanban-empty")?.remove();
      body.prepend(card);
      card.dataset.stage = newStage;

      const fromBody = board.querySelector(`.kanban-column[data-stage="${oldStage}"] .kanban-column-body`);
      if (fromBody && !fromBody.querySelector(".kanban-card")) {
        fromBody.innerHTML = `<div class="kanban-empty">Drop here</div>`;
      }
      updateKanbanCounts(board);

      const result = await crmApiPatch(`/api/crm/accounts/${accountId}/stage`, { stage: newStage });
      if (!result.ok) {
        await loadPipeline();
        alert(result.message || "Could not update stage.");
      }
    });
  });
}

function updateKanbanCounts(board) {
  board.querySelectorAll(".kanban-column").forEach((col) => {
    const stage = col.dataset.stage;
    const count = col.querySelectorAll(".kanban-card").length;
    const countEl = col.querySelector(".kanban-count");
    if (countEl) countEl.textContent = String(count);
    if (pipelineData?.stages) {
      const bucket = pipelineData.stages.find((s) => s.id === stage);
      if (bucket) bucket.count = count;
    }
  });
}

async function loadPipeline() {
  const q = $("#crm-pipeline-search")?.value || "";
  const tier = $("#crm-pipeline-tier")?.value || "";
  const market = $("#crm-pipeline-market")?.value || "";
  const data = await crmApi(
    `/api/crm/pipeline?q=${encodeURIComponent(q)}&tier=${encodeURIComponent(tier)}&market=${encodeURIComponent(market)}&limit=600`,
  );
  if (data.ok) renderKanbanBoard(data);
}

export async function refreshCrm() {
  const badge = $("#crm-live-badge");
  if (badge) badge.textContent = "↻ Refreshing…";

  try {
    const stats = await crmApi("/api/crm/stats");
    renderStats(stats);
    await Promise.all([loadContacts(), loadAccounts()]);
    if ($("#crm-tab-pipeline")?.classList.contains("active")) {
      await loadPipeline();
    }
    if (badge) {
      badge.textContent = `● Live · ${new Date().toLocaleTimeString()}`;
      badge.className = "badge badge-ok";
    }
  } catch (err) {
    if (badge) {
      badge.textContent = "Offline";
      badge.className = "badge badge-err";
    }
    console.error(err);
  }
}

export function startCrmAutoRefresh() {
  refreshCrm();
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshCrm, 20000);
}

// Init when DOM ready
function initCrm() {
  if (!$("#panel-crm")) return;

  $$(".crm-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".crm-tab").forEach((t) => t.classList.remove("active"));
      $$(".crm-tab-panel").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      $(`#crm-tab-${tab.dataset.crmTab}`).classList.add("active");
      if (tab.dataset.crmTab === "pipeline") loadPipeline();
    });
  });

  $("#crm-refresh-btn")?.addEventListener("click", refreshCrm);
  $("#drawer-close")?.addEventListener("click", closeDrawer);
  $("#drawer-backdrop")?.addEventListener("click", closeDrawer);

  let debounce;
  const debouncedContacts = () => {
    clearTimeout(debounce);
    debounce = setTimeout(loadContacts, 350);
  };
  $("#crm-contact-search")?.addEventListener("input", debouncedContacts);
  $("#crm-email-only")?.addEventListener("change", loadContacts);
  $("#crm-linkedin-only")?.addEventListener("change", loadContacts);
  $("#crm-gojiberry-only")?.addEventListener("change", loadContacts);
  $("#crm-account-search")?.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(loadAccounts, 350);
  });
  $("#crm-tier-filter")?.addEventListener("change", loadAccounts);
  $("#crm-market-filter")?.addEventListener("change", loadAccounts);

  $("#crm-pipeline-refresh")?.addEventListener("click", loadPipeline);
  let pipelineDebounce;
  $("#crm-pipeline-search")?.addEventListener("input", () => {
    clearTimeout(pipelineDebounce);
    pipelineDebounce = setTimeout(loadPipeline, 350);
  });
  $("#crm-pipeline-tier")?.addEventListener("change", loadPipeline);
  $("#crm-pipeline-market")?.addEventListener("change", loadPipeline);

  loadMarkets();
  startCrmAutoRefresh();
}


if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initCrm);
} else {
  initCrm();
}
