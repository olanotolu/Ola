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
  const text = await res.text();
  try {
    const data = JSON.parse(text);
    if (!res.ok && data.ok !== false) data.ok = false;
    if (!res.ok && !data.message) data.message = `HTTP ${res.status}`;
    return data;
  } catch {
    return { ok: false, message: text?.slice(0, 120) || `HTTP ${res.status}` };
  }
}

async function crmApiPost(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
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
let sequencesData = null;
let dragEnrollmentId = null;
let dragContactId = null;

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
    <div class="stat"><div class="stat-value">${esc(data.companies_total ?? 0)}</div><div class="stat-label">Companies</div></div>
    <div class="stat"><div class="stat-value">${esc(data.companies_with_email ?? 0)}</div><div class="stat-label">Co. w/ email</div></div>
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
  $("#drawer-title").textContent = "Loading operator…";
  body.innerHTML = `<div class="empty"><span class="spinner"></span> Loading operator details…</div>`;
  drawer.classList.remove("hidden");
  backdrop.classList.remove("hidden");

  const data = await crmApi(`/api/crm/accounts/${id}`);
  if (!data.ok) {
    $("#drawer-title").textContent = "Could not load";
    body.innerHTML = `<div class="empty">${esc(data.message || "Operator not found.")}</div>`;
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
    <div class="drawer-section" id="drawer-email-section">
      <h3>Email outreach</h3>
      <div id="drawer-email-timeline"><p class="run-meta">Select a contact with email to see timeline.</p></div>
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

  const firstWithEmail = data.contacts.find((c) => c.email);
  if (firstWithEmail) {
    const tl = $("#drawer-email-timeline");
    if (tl) loadContactEmailTimeline(firstWithEmail.id, tl);
  }
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
  container.querySelectorAll("tr.clickable[data-account-id]").forEach((row) => {
    row.addEventListener("click", () => openAccountDrawer(row.dataset.accountId));
  });
  container.querySelectorAll("tr.clickable[data-company-id]").forEach((row) => {
    row.addEventListener("click", () => openCompanyDrawer(row.dataset.companyId));
  });
}

function companiesTable(rows) {
  if (!rows.length) return `<div class="empty">No companies match your filters.</div>`;
  return `
    <table class="results-table">
      <thead>
        <tr>
          <th>Company</th>
          <th>Location</th>
          <th>Industry</th>
          <th>Size</th>
          <th>Employees</th>
          <th>Hiring</th>
          <th>Email</th>
          <th>Domain</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((c) => `
          <tr class="clickable" data-company-id="${esc(c.id)}">
            <td><strong>${esc(c.name)}</strong></td>
            <td>${esc([c.geo_city, c.geo_state].filter(Boolean).join(", ") || "—")}</td>
            <td>${esc(c.industry || "—")}</td>
            <td>${esc(c.company_size || "—")}</td>
            <td>${esc(c.employee_count_us ?? "—")}</td>
            <td>${c.hiring ? '<span class="badge badge-ok">Yes</span>' : "—"}</td>
            <td>${c.primary_email ? `<a href="mailto:${esc(c.primary_email)}">${esc(c.primary_email)}</a>` : "—"}</td>
            <td>${c.company_domain ? `<a href="https://${esc(c.company_domain)}" target="_blank" rel="noopener">${esc(c.company_domain)}</a>` : "—"}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

async function loadCompanyStates() {
  const data = await crmApi("/api/crm/company-states");
  const el = $("#crm-company-state");
  if (!el || el.dataset.loaded) return;
  for (const s of data.states || []) {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = s;
    el.appendChild(opt);
  }
  el.dataset.loaded = "1";
}

async function loadCompanies() {
  const q = $("#crm-company-search")?.value || "";
  const state = $("#crm-company-state")?.value || "";
  const industry = $("#crm-company-industry")?.value || "";
  const hiring = $("#crm-company-hiring")?.checked ? "1" : "";
  const hasEmail = $("#crm-company-email")?.checked ? "1" : "";
  const params = new URLSearchParams({ q, state, industry, hiring, has_email: hasEmail, limit: "250" });
  const data = await crmApi(`/api/crm/companies?${params}`);
  const el = $("#crm-companies-table");
  el.innerHTML = companiesTable(data.rows || []);
  $("#crm-companies-meta").textContent = `Showing ${(data.rows || []).length} of ${data.total ?? 0} companies (Explee)`;
  bindRowClicks(el);
}

async function openCompanyDrawer(id) {
  const drawer = $("#account-drawer");
  const backdrop = $("#drawer-backdrop");
  const body = $("#drawer-body");
  $("#drawer-title").textContent = "Loading company…";
  body.innerHTML = `<div class="empty"><span class="spinner"></span> Loading…</div>`;
  drawer.classList.remove("hidden");
  backdrop.classList.remove("hidden");

  const data = await crmApi(`/api/crm/companies/${id}`);
  if (!data.ok || !data.company) {
    $("#drawer-title").textContent = "Could not load";
    body.innerHTML = `<div class="empty">${esc(data.message || "Company not found.")}</div>`;
    return;
  }

  const c = data.company;
  const sp = c.source_payload || {};
  const emails = (c.all_emails || []).filter(Boolean);
  const socials = [
    c.linkedin_url && { label: "LinkedIn", url: c.linkedin_url },
    sp.facebook && { label: "Facebook", url: sp.facebook.split(";")[0].trim() },
    sp.instagram && { label: "Instagram", url: sp.instagram.split(";")[0].trim() },
    sp.youtube && { label: "YouTube", url: sp.youtube.split(";")[0].trim() },
  ].filter((s) => s?.url);

  $("#drawer-title").textContent = c.name;
  body.innerHTML = `
    <div class="drawer-section">
      <p class="drawer-kicker">${esc([c.geo_city, c.geo_state, c.geo_country].filter(Boolean).join(", "))} · ${esc(c.industry || "Hospitality")}</p>
      <p>${esc(c.description || "")}</p>
      <div class="drawer-facts">
        <span>Domain: <strong>${esc(c.company_domain || "—")}</strong></span>
        <span>Website: ${c.website ? `<a href="${esc(c.website)}" target="_blank" rel="noopener">${esc(c.website)}</a>` : "—"}</span>
        <span>Size: ${esc(c.company_size || "—")}</span>
        <span>Employees (US): ${esc(c.employee_count_us ?? "—")}</span>
        <span>Hiring: ${c.hiring ? "Yes" : "No"}</span>
        <span>Traffic: ${esc(c.traffic || "—")}${c.traffic_growth ? ` (${esc(c.traffic_growth)})` : ""}</span>
      </div>
    </div>
    ${emails.length ? `
    <div class="drawer-section">
      <h3>Emails (${emails.length})</h3>
      <ul>${emails.map((e) => `<li><a href="mailto:${esc(e)}">${esc(e)}</a></li>`).join("")}</ul>
    </div>` : ""}
    ${socials.length ? `
    <div class="drawer-section">
      <h3>Social</h3>
      <ul>${socials.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a></li>`).join("")}</ul>
    </div>` : ""}
    ${sp.primary_nace_description ? `
    <div class="drawer-section">
      <h3>Classification</h3>
      <p>${esc(sp.primary_nace_code || "")} — ${esc(sp.primary_nace_description)}</p>
    </div>` : ""}
    <div class="drawer-section">
      <button class="btn btn-secondary" type="button" id="copy-company-domain">Copy domain for Roger</button>
    </div>
  `;

  $("#copy-company-domain")?.addEventListener("click", () => {
    navigator.clipboard?.writeText(c.company_domain || "");
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

function renderSequencesStats(data) {
  const el = $("#crm-sequences-stats");
  if (!el) return;
  el.innerHTML = `
    <div class="stat"><div class="stat-value">${esc(data.enrolled ?? 0)}</div><div class="stat-label">Enrolled</div></div>
    <div class="stat"><div class="stat-value">${esc(data.delivered ?? 0)}</div><div class="stat-label">Delivered</div></div>
    <div class="stat stat-ok"><div class="stat-value">${esc(data.delivery_rate ?? 0)}%</div><div class="stat-label">Delivery rate</div></div>
    <div class="stat ${(data.failed ?? 0) > 0 ? "stat-warn" : ""}"><div class="stat-value">${esc(data.failed ?? 0)}</div><div class="stat-label">Failed</div></div>
    <div class="stat"><div class="stat-value">${esc(data.queue_pending ?? 0)}</div><div class="stat-label">Retry queue</div></div>
    <div class="stat"><div class="stat-value">${esc(data.opened_confirmed ?? 0)}</div><div class="stat-label">Opens (confirmed)</div></div>
    <div class="stat"><div class="stat-value">${esc(data.opened_suspect ?? 0)}</div><div class="stat-label">Opens (suspect)</div></div>
    <div class="stat"><div class="stat-value">${esc(data.replied ?? 0)}</div><div class="stat-label">Replies</div></div>
    <div class="stat"><div class="stat-value">${esc(data.auto_replied ?? 0)}</div><div class="stat-label">Auto-replies</div></div>
    <div class="stat"><div class="stat-value">${esc(data.reply_rate ?? 0)}%</div><div class="stat-label">Reply rate</div></div>
  `;
}

function sequenceStatusBadges(card) {
  const bits = [];
  if (card.current_step > 0) bits.push(`<span class="badge">Touch ${card.current_step}/5</span>`);
  if (card.has_failed) bits.push(`<span class="badge badge-err">send failed</span>`);
  if (card.failure_reason === "rate_limit") bits.push('<span class="badge badge-warn">rate limited</span>');
  if (card.has_opened) bits.push('<span class="badge badge-ok">opened</span>');
  if (card.has_open_suspect && !card.has_opened) bits.push('<span class="badge">open?</span>');
  if (card.has_replied) bits.push('<span class="badge badge-ok">replied</span>');
  if (card.has_auto_reply) bits.push('<span class="badge">OOO</span>');
  if (card.has_bounced) bits.push('<span class="badge badge-err">bounced</span>');
  if (card.intent_type) bits.push(`<span class="badge badge-warn">${esc(card.intent_type)}</span>`);
  return bits.join(" ");
}

function sequenceCard(card) {
  const nextStep = Math.min((card.current_step || 0) + 1, 5);
  const enrolled = Boolean(card.enrollment_id);
  return `
    <article
      class="kanban-card sequence-card"
      draggable="true"
      data-contact-id="${esc(card.contact_id)}"
      data-enrollment-id="${esc(card.enrollment_id || "")}"
      data-column="${esc(card.column)}"
    >
      <div class="kanban-card-top">
        <strong>${esc(card.name)}</strong>
        ${card.gojiberry_score ? `<span class="badge">${esc(card.gojiberry_score)}</span>` : ""}
      </div>
      <p class="kanban-card-meta">
        <span class="badge badge-warn">${esc(card.tier || "—")}</span>
        ${esc(card.company || "")}
      </p>
      <p class="kanban-card-foot">${esc(card.email)}</p>
      <p class="sequence-badges">${sequenceStatusBadges(card)}</p>
      <div class="sequence-actions">
        ${!enrolled ? `<button type="button" class="btn btn-ghost btn-sm seq-enroll-btn" data-contact-id="${esc(card.contact_id)}">Enroll</button>` : ""}
        <button type="button" class="btn btn-ghost btn-sm seq-preview-btn" data-contact-id="${esc(card.contact_id)}" data-step="${nextStep}">Preview ${nextStep}</button>
        <button type="button" class="btn btn-primary btn-sm seq-send-btn" data-contact-id="${esc(card.contact_id)}" data-step="${nextStep}">Send ${nextStep}</button>
      </div>
    </article>
  `;
}

function renderSequencesBoard(data) {
  sequencesData = data;
  const board = $("#crm-sequences-board");
  if (!board) return;
  if (!data?.columns?.length) {
    board.innerHTML = `<div class="empty">No sequence data.</div>`;
    return;
  }

  board.innerHTML = data.columns
    .map(
      (col) => `
    <section class="kanban-column" data-column="${esc(col.id)}">
      <header class="kanban-column-header">
        <h3>${esc(col.label)}</h3>
        <span class="kanban-count">${esc(col.count)}</span>
      </header>
      <p class="kanban-column-hint">${esc(col.hint)}</p>
      <div class="kanban-column-body" data-drop-column="${esc(col.id)}">
        ${(col.cards || []).map(sequenceCard).join("") || `<div class="kanban-empty">Drop here</div>`}
      </div>
    </section>`,
    )
    .join("");

  bindSequencesDragDrop(board);
  bindSequenceActions(board);
  $("#crm-sequences-meta").textContent = `${data.total ?? 0} contacts · 5-touch sequence`;
}

function bindSequenceActions(board) {
  board.querySelectorAll(".seq-enroll-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const result = await crmApiPost("/api/email/enroll", { contact_id: btn.dataset.contactId });
      if (result.ok) loadSequences();
      else alert(result.message || "Enroll failed");
    });
  });
  board.querySelectorAll(".seq-preview-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const result = await crmApiPost("/api/email/send-step", {
        contact_id: btn.dataset.contactId,
        step: Number(btn.dataset.step),
        preview_only: true,
      });
      if (!result.ok) return alert(result.message || "Preview failed");
      alert(`Subject: ${result.subject}\n\n---\n\n${result.body}`);
    });
  });
  board.querySelectorAll(".seq-send-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const step = Number(btn.dataset.step);
      const preview = await crmApiPost("/api/email/send-step", {
        contact_id: btn.dataset.contactId,
        step,
        preview_only: true,
      });
      if (!preview.ok) return alert(preview.message || "Preview failed");
      if (!confirm(`Send touch ${step}?\n\nSubject: ${preview.subject}`)) return;
      const result = await crmApiPost("/api/email/send-step", {
        contact_id: btn.dataset.contactId,
        step,
      });
      if (result.ok) {
        alert(`Sent touch ${step}`);
        loadSequences();
      } else {
        alert(result.message || "Send failed — check SMTP_* in .env.getleads");
      }
    });
  });
}

function bindSequencesDragDrop(board) {
  board.querySelectorAll(".sequence-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      openContactDrawer(card.dataset.contactId);
    });
    card.addEventListener("dragstart", (e) => {
      dragEnrollmentId = card.dataset.enrollmentId || null;
      dragContactId = card.dataset.contactId;
      card.classList.add("dragging");
      e.dataTransfer?.setData("text/plain", JSON.stringify({
        enrollmentId: dragEnrollmentId,
        contactId: dragContactId,
      }));
      e.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => {
      card.classList.remove("dragging");
      dragEnrollmentId = null;
      dragContactId = null;
      board.querySelectorAll(".kanban-column-body").forEach((b) => b.classList.remove("drag-over"));
    });
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
      let payload = {};
      try {
        payload = JSON.parse(e.dataTransfer?.getData("text/plain") || "{}");
      } catch {
        payload = { contactId: dragContactId, enrollmentId: dragEnrollmentId };
      }
      const newColumn = body.dataset.dropColumn;
      if (!newColumn || !payload.contactId) return;

      if (newColumn === "queue") {
        if (payload.enrollmentId) {
          await crmApiPatch(`/api/email/enrollments/${payload.enrollmentId}`, { outreach_status: "paused" });
        }
        return loadSequences();
      }

      if (!payload.enrollmentId) {
        await crmApiPost("/api/email/enroll", { contact_id: payload.contactId });
        const boardData = await crmApi("/api/email/sequences/board");
        const card = boardData.columns?.flatMap((c) => c.cards || []).find((c) => c.contact_id === payload.contactId);
        if (card?.enrollment_id && newColumn !== "active") {
          await crmApiPatch(`/api/email/enrollments/${card.enrollment_id}`, { outreach_status: newColumn });
        }
        return loadSequences();
      }

      if (newColumn !== "active") {
        const result = await crmApiPatch(`/api/email/enrollments/${payload.enrollmentId}`, {
          outreach_status: newColumn,
        });
        if (!result.ok) alert(result.message || "Could not update status");
      }
      loadSequences();
    });
  });
}

async function loadSequences() {
  const tier = $("#crm-sequences-tier")?.value || "";
  const intent = $("#crm-sequences-intent")?.value || "";
  const due = $("#crm-sequences-due")?.checked ? "1" : "";
  const [stats, board] = await Promise.all([
    crmApi("/api/email/stats"),
    crmApi(`/api/email/sequences/board?tier=${encodeURIComponent(tier)}&intent=${encodeURIComponent(intent)}&due=${due}`),
  ]);
  if (stats.ok) renderSequencesStats(stats);
  if (board.ok) renderSequencesBoard(board);
}

async function openContactDrawer(contactId) {
  const drawer = $("#account-drawer");
  const backdrop = $("#drawer-backdrop");
  const body = $("#drawer-body");
  const card = sequencesData?.columns?.flatMap((c) => c.cards || []).find((c) => c.contact_id === contactId);

  $("#drawer-title").textContent = card?.name || "Contact";
  body.innerHTML = `<div class="empty"><span class="spinner"></span> Loading…</div>`;
  drawer.classList.remove("hidden");
  backdrop.classList.remove("hidden");

  const timelineRes = await crmApi(`/api/email/contact/${contactId}`);
  const enrollment = timelineRes.enrollment;

  body.innerHTML = `
    <div class="drawer-section">
      <p class="drawer-kicker">${esc(card?.title || "")} · ${esc(card?.company || "")}</p>
      <p>${card?.email ? `<a href="mailto:${esc(card.email)}">${esc(card.email)}</a>` : ""}</p>
      ${enrollment ? `<p class="run-meta">Touch ${enrollment.current_step}/5 · ${esc(enrollment.outreach_status)}</p>` : ""}
      ${card?.intent_raw ? `<p class="run-meta">${esc(card.intent_raw)}</p>` : ""}
    </div>
    <div class="drawer-section">
      <h3>Signal brief</h3>
      <textarea id="drawer-signal-brief" class="signal-brief-input" rows="10" placeholder="Paste research / signal notes for touch 1…">${esc(enrollment?.signal_brief || card?.signal_brief || "")}</textarea>
      <div class="row" style="margin-top:0.5rem">
        <button type="button" class="btn btn-secondary btn-sm" id="drawer-save-signal">Save signal</button>
        ${!enrollment ? `<button type="button" class="btn btn-primary btn-sm" id="drawer-enroll">Enroll in sequence</button>` : ""}
      </div>
    </div>
    <div class="drawer-section" id="drawer-email-section">
      <h3>Email timeline</h3>
      <div id="drawer-email-timeline"></div>
    </div>
  `;

  const tl = $("#drawer-email-timeline");
  if (tl) await loadContactEmailTimeline(contactId, tl, timelineRes);

  $("#drawer-save-signal")?.addEventListener("click", async () => {
    const brief = $("#drawer-signal-brief")?.value || "";
    const result = await crmApiPost("/api/email/signal-brief", { contact_id: contactId, signal_brief: brief });
    if (result.ok) alert("Signal brief saved");
    else alert(result.message || "Save failed");
  });
  $("#drawer-enroll")?.addEventListener("click", async () => {
    const brief = $("#drawer-signal-brief")?.value || "";
    const result = await crmApiPost("/api/email/enroll", { contact_id: contactId, signal_brief: brief });
    if (result.ok) {
      alert("Enrolled");
      loadSequences();
      openContactDrawer(contactId);
    } else alert(result.message || "Enroll failed");
  });
}

async function loadContactEmailTimeline(contactId, container, preloaded) {
  const data = preloaded || (await crmApi(`/api/email/contact/${contactId}`));
  if (!data.ok || !data.timeline?.length) {
    container.innerHTML = `<p class="run-meta">No emails sent yet.</p>`;
    return;
  }
  const enrollment = data.enrollment;
  let html = "";
  if (enrollment) {
    html += `<p class="run-meta">Sequence: touch ${enrollment.current_step}/5 · ${esc(enrollment.outreach_status)}</p>`;
  }
  html += data.timeline
    .map(
      (s) => `
    <div class="email-timeline-item">
      <strong>${esc(s.subject)}</strong>
      ${s.sequence_step ? `<span class="badge">Touch ${s.sequence_step}</span>` : ""}
      <span class="badge ${s.status === "failed" ? "badge-err" : ""}">${esc(s.status)}</span>
      ${s.failure_reason ? `<span class="badge badge-warn">${esc(s.failure_reason)}</span>` : ""}
      <p class="run-meta">${fmtTime(s.sent_at || s.created_at)} → ${esc(s.to_email)}</p>
      ${s.error_message ? `<p class="run-meta" style="color:#a33">${esc(s.error_message)}</p>` : ""}
      ${(s.crm_email_events || []).map((e) => {
        const conf = e.payload?.confidence ? ` (${e.payload.confidence})` : "";
        return `<span class="badge ${e.event_type === "failed" || e.event_type === "rate_limited" ? "badge-err" : ""}">${esc(e.event_type)}${esc(conf)}</span> `;
      }).join("")}
    </div>`,
    )
    .join("");
  container.innerHTML = html;
}

export async function refreshCrm() {
  const badge = $("#crm-live-badge");
  if (badge) badge.textContent = "↻ Refreshing…";

  try {
    const stats = await crmApi("/api/crm/stats");
    renderStats(stats);
    await Promise.all([loadContacts(), loadAccounts(), loadCompanies()]);
    if ($("#crm-tab-pipeline")?.classList.contains("active")) {
      await loadPipeline();
    }
    if ($("#crm-tab-sequences")?.classList.contains("active")) {
      await loadSequences();
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
      if (tab.dataset.crmTab === "sequences") loadSequences();
      if (tab.dataset.crmTab === "companies") {
        loadCompanyStates();
        loadCompanies();
      }
    });
  });

  $("#crm-sequences-refresh")?.addEventListener("click", loadSequences);
  $("#crm-sequences-queue")?.addEventListener("click", async () => {
    const btn = $("#crm-sequences-queue");
    if (btn) btn.disabled = true;
    try {
      const result = await crmApiPost("/api/email/queue/process", {});
      alert(`Queue: ${result.processed ?? 0} processed`);
      await loadSequences();
    } catch (e) {
      alert(e.message || "Queue process failed");
    } finally {
      if (btn) btn.disabled = false;
    }
  });
  $("#crm-sequences-tier")?.addEventListener("change", loadSequences);
  $("#crm-sequences-intent")?.addEventListener("change", loadSequences);
  $("#crm-sequences-due")?.addEventListener("change", loadSequences);

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

  let companyDebounce;
  $("#crm-company-search")?.addEventListener("input", () => {
    clearTimeout(companyDebounce);
    companyDebounce = setTimeout(loadCompanies, 350);
  });
  $("#crm-company-state")?.addEventListener("change", loadCompanies);
  $("#crm-company-industry")?.addEventListener("change", loadCompanies);
  $("#crm-company-hiring")?.addEventListener("change", loadCompanies);
  $("#crm-company-email")?.addEventListener("change", loadCompanies);

  $("#crm-pipeline-refresh")?.addEventListener("click", loadPipeline);
  let pipelineDebounce;
  $("#crm-pipeline-search")?.addEventListener("input", () => {
    clearTimeout(pipelineDebounce);
    pipelineDebounce = setTimeout(loadPipeline, 350);
  });
  $("#crm-pipeline-tier")?.addEventListener("change", loadPipeline);
  $("#crm-pipeline-market")?.addEventListener("change", loadPipeline);

  loadMarkets();
  loadCompanyStates();
  startCrmAutoRefresh();
}


if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initCrm);
} else {
  initCrm();
}
