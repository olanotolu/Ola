const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body != null ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function showAlert(id, message, type = "error") {
  const el = $(id);
  if (!message) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  el.className = `alert alert-${type}`;
  el.textContent = message;
}

function esc(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pick(obj, ...keys) {
  for (const k of keys) {
    const v = k.split(".").reduce((o, p) => o?.[p], obj);
    if (v != null && v !== "") return v;
  }
  return "";
}

// Navigation
$$(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    $$(".nav-btn").forEach((b) => b.classList.remove("active"));
    $$(".panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $(`#panel-${btn.dataset.panel}`).classList.add("active");
    if (btn.dataset.panel === "crm") {
      import("./crm.js").then((m) => m.refreshCrm());
    }
  });
});

async function refreshStatus() {
  const { data } = await api("/api/local/status");
  const ready = data.signedIn && data.hasApiKey;
  const pill = $("#sidebar-status");
  pill.innerHTML = `
    <span class="status-dot ${ready ? "on" : data.signedIn ? "on" : "off"}"></span>
    ${data.signedIn ? "Signed in" : "Not signed in"}
    ${data.hasApiKey ? " · API key set" : " · No API key"}
  `;

  const details = $("#status-details");
  details.innerHTML = `
    <div class="stat"><div class="stat-value">${data.signedIn ? "✓" : "—"}</div><div class="stat-label">Session</div></div>
    <div class="stat"><div class="stat-value">${data.hasApiKey ? "✓" : "—"}</div><div class="stat-label">API key</div></div>
    <div class="stat"><div class="stat-value" style="font-size:1rem;font-family:var(--font)">${esc(data.profile)}</div><div class="stat-label">Profile</div></div>
    <div class="stat"><div class="stat-value" style="font-size:0.85rem;font-family:var(--font)">${esc(data.baseUrl?.replace("https://", ""))}</div><div class="stat-label">Host</div></div>
  `;

  if (data.defaultEmail && !$("#email").value) {
    $("#email").value = data.defaultEmail;
  }
  return data;
}

// Login
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  showAlert("#connect-alert");
  const btn = e.submitter;
  btn.disabled = true;
  const { ok, data } = await api("/api/local/login", {
    method: "POST",
    body: { email: $("#email").value, password: $("#password").value },
  });
  btn.disabled = false;
  if (!ok) {
    showAlert("#connect-alert", data.message || data.error || "Login failed.");
    return;
  }
  showAlert("#connect-alert", "Signed in successfully.", "success");
  await refreshStatus();
});

$("#logout-btn").addEventListener("click", async () => {
  await api("/api/local/logout", { method: "POST" });
  showAlert("#connect-alert", "Signed out.", "info");
  await refreshStatus();
});

$("#apikey-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = $("#api-key").value.trim();
  if (!key) return;
  const { ok, data } = await api("/api/local/api-key", { method: "POST", body: { apiKey: key } });
  if (!ok) {
    showAlert("#connect-alert", data.message || "Failed to save API key.");
    return;
  }
  showAlert("#connect-alert", "API key saved.", "success");
  $("#api-key").value = "";
  await refreshStatus();
});

async function createKey() {
  const { ok, data } = await api("/api/local/api-keys", {
    method: "POST",
    body: { name: "Ola Leads Testing UI" },
  });
  if (!ok) {
    showAlert("#connect-alert", data.message || "Create key failed — sign in first.");
    return null;
  }
  if (data.key) {
    showAlert("#connect-alert", "New API key created and saved.", "success");
    await refreshStatus();
  }
  return data;
}

$("#create-key-btn").addEventListener("click", createKey);

// Contact search
$("#search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  showAlert("#search-alert");
  const form = e.target;
  form.classList.add("loading");

  const filters = {};
  const title = $("#job-title").value.trim();
  const company = $("#company").value.trim();
  const location = $("#location").value.trim();
  if (title) filters.job_title = title.split(",").map((s) => s.trim()).filter(Boolean);
  if (company) filters.company_name = [company];
  if (location) filters.location = [location];

  const body = {
    filters,
    limit: Number($("#limit").value) || 10,
  };

  const { ok, data } = await api("/api/local/contacts/search", { method: "POST", body });
  form.classList.remove("loading");

  if (!ok) {
    showAlert("#search-alert", data.message || data.error || "Search failed. Check API key on Connect.");
    return;
  }

  renderContacts(data);
});

function renderContacts(data) {
  const container = $("#search-results");
  const rows = data.contacts || data.results || data.data || (Array.isArray(data) ? data : []);

  if (!rows.length) {
    container.innerHTML = `<div class="empty">No contacts found. Try different filters.</div>`;
    return;
  }

  const html = `
    <p style="margin:0 0 0.75rem;font-size:0.85rem;color:var(--ink-muted)">${rows.length} contact(s)</p>
    <div style="overflow-x:auto">
      <table class="results-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Title</th>
            <th>Company</th>
            <th>Location</th>
            <th>LinkedIn</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((c) => `
            <tr>
              <td>${esc(pick(c, "full_name", "name", "first_name"))}</td>
              <td>${esc(pick(c, "job_title", "title"))}</td>
              <td>${esc(pick(c, "company_name", "company", "organization.name"))}</td>
              <td>${esc(pick(c, "location", "city"))}</td>
              <td>${c.linkedin_url ? `<a href="${esc(c.linkedin_url)}" target="_blank" rel="noopener">Profile</a>` : "—"}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
  container.innerHTML = html;
}

// Funding signals
$("#load-signals-btn").addEventListener("click", async () => {
  showAlert("#signals-alert");
  const btn = $("#load-signals-btn");
  btn.disabled = true;
  const limit = $("#signals-limit").value || 20;
  const { ok, data } = await api(`/api/local/funding/signals?limit=${limit}`);
  btn.disabled = false;

  if (!ok) {
    showAlert("#signals-alert", data.message || "Failed to load signals.");
    return;
  }

  const items = data.signals || data.results || data.data || (Array.isArray(data) ? data : []);
  const container = $("#signals-results");

  if (!items.length) {
    container.innerHTML = `<div class="empty">No signals returned.</div><pre class="json-out">${esc(JSON.stringify(data, null, 2))}</pre>`;
    return;
  }

  container.innerHTML = `
    <div style="overflow-x:auto">
      <table class="results-table">
        <thead>
          <tr>
            <th>Company</th>
            <th>Round</th>
            <th>Amount</th>
            <th>Date</th>
          </tr>
        </thead>
        <tbody>
          ${items.map((s) => `
            <tr>
              <td>${esc(pick(s, "company_name", "company", "name"))}</td>
              <td>${esc(pick(s, "round_type", "round", "funding_type"))}</td>
              <td>${esc(pick(s, "amount", "funding_amount"))}</td>
              <td>${esc(pick(s, "announced_date", "date", "announced_at"))}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
});

// Dashboard
$("#load-dashboard-btn").addEventListener("click", async () => {
  showAlert("#dashboard-alert");
  const [statsRes, runsRes] = await Promise.all([
    api("/api/local/dashboard/stats"),
    api("/api/local/dashboard/runs?limit=10"),
  ]);

  if (!statsRes.ok) {
    showAlert("#dashboard-alert", statsRes.data.message || "Sign in to view dashboard.");
    return;
  }

  const stats = statsRes.data;
  const statKeys = Object.entries(stats).filter(([k]) => !["ok", "message"].includes(k));
  $("#dashboard-stats").innerHTML = statKeys.length
    ? statKeys.map(([k, v]) => `
        <div class="stat">
          <div class="stat-value">${esc(typeof v === "object" ? JSON.stringify(v) : v)}</div>
          <div class="stat-label">${esc(k.replace(/_/g, " "))}</div>
        </div>
      `).join("")
    : `<pre class="json-out">${esc(JSON.stringify(stats, null, 2))}</pre>`;

  const runs = runsRes.data.runs || runsRes.data.results || (Array.isArray(runsRes.data) ? runsRes.data : []);
  const runsEl = $("#dashboard-runs");
  if (!runs.length) {
    runsEl.innerHTML = `<pre class="json-out">${esc(JSON.stringify(runsRes.data, null, 2))}</pre>`;
    return;
  }
  runsEl.innerHTML = `
    <table class="results-table">
      <thead><tr><th>ID</th><th>Status</th><th>Created</th></tr></thead>
      <tbody>
        ${runs.map((r) => `
          <tr>
            <td>${esc(pick(r, "id", "runId"))}</td>
            <td>${esc(pick(r, "status", "state"))}</td>
            <td>${esc(pick(r, "created_at", "createdAt"))}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
});

// API keys list
$("#load-keys-btn").addEventListener("click", loadKeys);
$("#keys-create-btn").addEventListener("click", async () => {
  const data = await createKey();
  if (data) loadKeys();
});

async function loadKeys() {
  showAlert("#keys-alert");
  const { ok, data } = await api("/api/local/api-keys");
  if (!ok) {
    showAlert("#keys-alert", data.message || "Sign in to list keys.");
    return;
  }
  const keys = data.keys || data.apiKeys || (Array.isArray(data) ? data : []);
  const el = $("#keys-list");
  if (!keys.length) {
    el.innerHTML = `<pre class="json-out">${esc(JSON.stringify(data, null, 2))}</pre>`;
    return;
  }
  el.innerHTML = `
    <table class="results-table">
      <thead><tr><th>Name</th><th>Prefix</th><th>Created</th></tr></thead>
      <tbody>
        ${keys.map((k) => `
          <tr>
            <td>${esc(pick(k, "name", "label"))}</td>
            <td><code>${esc(pick(k, "prefix", "key_prefix", "id"))}</code></td>
            <td>${esc(pick(k, "created_at", "createdAt"))}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

refreshStatus();
