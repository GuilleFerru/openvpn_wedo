// OpenVPN Admin - JavaScript

let groups = {};
let connectedClients = [];

// ============================================
// Security helpers
// ============================================

/**
 * HTML-escape a value before inserting it into innerHTML.
 * Prevents XSS when rendering server-returned data in template strings.
 */
function esc(str) {
  const d = document.createElement("div");
  d.textContent = String(str == null ? "" : str);
  return d.innerHTML;
}

/**
 * Read the CSRF token from the cookie set by the server.
 * Must be included as X-CSRFToken header on every mutating AJAX request.
 */
function getCsrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : "";
}

/** Shared headers for AJAX requests that mutate state (POST / PUT). */
function jsonHeaders() {
  return {
    "Content-Type": "application/json",
    "X-CSRFToken": getCsrfToken(),
  };
}

// ============================================
// Theme Toggle (light/dark) with persistence
// ============================================

function toggleTheme() {
  const html = document.documentElement;
  const current = html.getAttribute("data-theme") || "dark";
  const next = current === "dark" ? "light" : "dark";
  html.setAttribute("data-theme", next);
  localStorage.setItem("vpn-theme", next);
  updateThemeIcon(next);
}

function updateThemeIcon(theme) {
  const btn = document.getElementById("themeToggle");
  if (btn) {
    btn.innerHTML = theme === "dark"
      ? '<i data-lucide="sun"></i>'
      : '<i data-lucide="moon"></i>';
    btn.title =
      theme === "dark" ? "Cambiar a modo claro" : "Cambiar a modo oscuro";
    if (typeof lucide !== "undefined") lucide.createIcons();
  }
}

// Apply icon on load
updateThemeIcon(document.documentElement.getAttribute("data-theme") || "dark");

// ============================================
// Collapsible sections with localStorage persistence
// ============================================

function saveSectionState(sectionId, isCollapsed) {
  const states = JSON.parse(localStorage.getItem("sectionStates") || "{}");
  states[sectionId] = isCollapsed;
  localStorage.setItem("sectionStates", JSON.stringify(states));
}

function getSectionState(sectionId, defaultCollapsed = true) {
  const states = JSON.parse(localStorage.getItem("sectionStates") || "{}");
  if (states.hasOwnProperty(sectionId)) {
    return states[sectionId];
  }
  return defaultCollapsed;
}

function restoreSectionStates() {
  const sections = [
    { id: "connectedSection", defaultCollapsed: true },
    { id: "rejectedSection", defaultCollapsed: true },
    { id: "clientsSection", defaultCollapsed: false },
  ];

  sections.forEach(({ id, defaultCollapsed }) => {
    const section = document.getElementById(id);
    const icon = document.getElementById(id + "-icon");
    if (section && icon) {
      const shouldBeCollapsed = getSectionState(id, defaultCollapsed);
      if (shouldBeCollapsed) {
        section.classList.add("collapsed");
        icon.classList.add("collapsed");
      } else {
        section.classList.remove("collapsed");
        icon.classList.remove("collapsed");
      }
    }
  });
}

function toggleSection(sectionId) {
  const section = document.getElementById(sectionId);
  const icon = document.getElementById(sectionId + "-icon");
  section.classList.toggle("collapsed");
  icon.classList.toggle("collapsed");
  saveSectionState(sectionId, section.classList.contains("collapsed"));
}

function toggleGroup(groupId) {
  const content = document.getElementById("group-content-" + groupId);
  const icon = document.getElementById("group-icon-" + groupId);
  content.classList.toggle("collapsed");
  icon.classList.toggle("collapsed");
  saveSectionState("group-" + groupId, content.classList.contains("collapsed"));
}

function restoreGroupStates() {
  Object.keys(groups).forEach((gid) => {
    const content = document.getElementById("group-content-" + gid);
    const icon = document.getElementById("group-icon-" + gid);
    if (content && icon) {
      const shouldBeCollapsed = getSectionState("group-" + gid, true);
      if (shouldBeCollapsed) {
        content.classList.add("collapsed");
        icon.classList.add("collapsed");
      } else {
        content.classList.remove("collapsed");
        icon.classList.remove("collapsed");
      }
    }
  });
}

// ============================================
// Monogram preview
// ============================================

function updateMonogramPreview() {
  const input = document.getElementById("groupIcon");
  const preview = document.getElementById("monogramPreview");
  preview.textContent = input.value || "AB";
}

function updateEditMonogramPreview() {
  const input = document.getElementById("editGroupIcon");
  const preview = document.getElementById("editMonogramPreview");
  preview.textContent = input.value || "AB";
}

// ============================================
// Modal functions
// ============================================

function showModal(id) {
  document.getElementById(id).style.display = "flex";
}

function hideModal(id) {
  document.getElementById(id).style.display = "none";
}

function showEditGroupModal(groupId, name, icon) {
  document.getElementById("editGroupId").value = groupId;
  document.getElementById("editGroupName").value = name;
  document.getElementById("editGroupIcon").value = icon || "";
  document.getElementById("editMonogramPreview").textContent = icon || "AB";
  showModal("modalEditGroup");
}

async function showCreateGroupModal() {
  document.getElementById("groupIcon").value = "";
  document.getElementById("monogramPreview").textContent = "AB";
  document.getElementById("groupName").value = "";
  showModal("modalCreateGroup");
  const r = await fetch("/api/next-group-range");
  const d = await r.json();
  document.getElementById("groupRangePreview").textContent = d.available
    ? `${d.start_ip} - ${d.end_ip}`
    : "No hay más rangos disponibles";
}

// ============================================
// Event delegation for edit-group buttons
// (avoids inline onclick with unescaped data)
// ============================================

document.addEventListener("click", (e) => {
  const btn = e.target.closest(".btn-edit");
  if (btn) {
    const gid = btn.dataset.gid;
    const g = groups[gid];
    if (g) showEditGroupModal(gid, g.name, g.icon);
  }
});

// ============================================
// Forms
// ============================================

document.getElementById("editGroupForm").onsubmit = async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector("button");
  btn.disabled = true;
  btn.textContent = "Guardando...";

  const groupId = document.getElementById("editGroupId").value;
  const r = await fetch("/api/groups/" + groupId, {
    method: "PUT",
    headers: jsonHeaders(),
    body: JSON.stringify({
      name: document.getElementById("editGroupName").value,
      icon: document.getElementById("editGroupIcon").value.toUpperCase() || "AB",
    }),
  });
  const d = await r.json();

  btn.disabled = false;
  btn.textContent = "Guardar Cambios";

  if (d.success) {
    hideModal("modalEditGroup");
    location.reload();
  } else {
    alert("Error: " + d.error);
  }
};

document.getElementById("createGroupForm").onsubmit = async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector("button");
  btn.disabled = true;
  btn.textContent = "Creando...";

  const r = await fetch("/api/groups", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      name: document.getElementById("groupName").value,
      icon: document.getElementById("groupIcon").value.toUpperCase() || "AB",
    }),
  });
  const d = await r.json();

  btn.disabled = false;
  btn.textContent = "Crear Grupo";

  if (d.success) {
    hideModal("modalCreateGroup");
    document.getElementById("groupName").value = "";
    location.reload();
  } else {
    alert("Error: " + d.error);
  }
};

document.getElementById("createForm").onsubmit = async (e) => {
  e.preventDefault();
  const status = document.getElementById("createStatus");
  const btn = e.target.querySelector('button[type="submit"]');

  status.style.display = "block";
  status.className = "status loading";
  status.textContent = "⏳ Creando cliente...";
  btn.disabled = true;

  const r = await fetch("/api/create", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      name: document.getElementById("clientName").value,
      group: document.getElementById("clientGroup").value,
    }),
  });
  const d = await r.json();

  btn.disabled = false;

  if (d.success) {
    status.className = "status success";
    // Build success message via DOM to avoid XSS via innerHTML
    status.textContent = "";
    const msg = document.createElement("span");
    msg.textContent = `✅ Cliente creado! IP: `;
    const ip = document.createElement("strong");
    ip.textContent = d.ip;
    const sep = document.createTextNode(" \u00a0 ");
    const link = document.createElement("a");
    link.href = "/download/" + encodeURIComponent(d.name);
    link.className = "download-link";
    link.textContent = "↓ Descargar .ovpn";
    const note = document.createElement("span");
    note.style.cssText = "color:#888;font-size:12px;";
    note.textContent = " (recargando en 3s...)";
    status.append(msg, ip, sep, link, note);
    document.getElementById("clientName").value = "";
    setTimeout(() => location.reload(), 3000);
  } else {
    status.className = "status error";
    status.textContent = "❌ " + d.error;
  }
};

document.getElementById("revokeForm").onsubmit = async (e) => {
  e.preventDefault();
  if (
    !confirm(
      "¿Revocar este cliente? Esta acción es IRREVERSIBLE.\n\n⚠️ OpenVPN se reiniciará y las conexiones activas se desconectarán momentáneamente.",
    )
  )
    return;

  const status = document.getElementById("revokeStatus");
  const btn = e.target.querySelector('button[type="submit"]');

  status.style.display = "block";
  status.className = "status loading";
  status.textContent = "⏳ Revocando...";
  btn.disabled = true;

  const r = await fetch("/api/revoke", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      name: document.getElementById("revokeClientName").value,
    }),
  });
  const d = await r.json();

  btn.disabled = false;

  if (d.success) {
    status.className = "status success";
    status.textContent = "✅ Cliente revocado correctamente (recargando...)";
    document.getElementById("revokeClientName").value = "";
    setTimeout(() => location.reload(), 1500);
  } else {
    status.className = "status error";
    status.textContent = "❌ " + d.error;
  }
};

// ============================================
// Load groups
// ============================================

async function loadGroups() {
  const r = await fetch("/api/groups");
  const d = await r.json();
  groups = d.groups;

  const container = document.getElementById("groupsList");
  const select = document.getElementById("clientGroup");

  const sortedGroups = Object.entries(groups).sort((a, b) => {
    if (a[1].is_system) return -1;
    if (b[1].is_system) return 1;
    return a[1].name.localeCompare(b[1].name);
  });

  document.getElementById("groupsCount").textContent = sortedGroups.length;

  if (sortedGroups.length === 0) {
    container.innerHTML =
      '<div class="empty-state"><p>No hay grupos creados</p></div>';
  } else {
    let html = "";
    for (const [id, g] of sortedGroups) {
      const used = g.client_count || 0;
      const total = g.capacity || 254;
      const isAdmin = g.is_system || g.can_see_all;

      // id is always [a-z0-9-] so safe as data attribute value and in class
      html += `
        <div class="group-card ${isAdmin ? "admin" : ""}">
          <div class="group-header">
            <div>
              <span class="group-icon">${esc(g.icon)}</span>
              <span class="group-name">${esc(g.name)}</span>
              ${!isAdmin ? `<button class="btn-edit" data-gid="${id}"><i data-lucide="pencil"></i></button>` : ""}
            </div>
            <div style="text-align:right;">
              <div><strong>${used}</strong> / ${total}</div>
              <div class="group-range">${esc(g.start_ip)} - ${esc(g.end_ip)}</div>
            </div>
          </div>
        </div>
      `;
    }
    container.innerHTML = html;
    if (typeof lucide !== "undefined") lucide.createIcons();
  }

  select.innerHTML = '<option value="">-- Seleccionar grupo --</option>';
  for (const [id, g] of sortedGroups) {
    const used = g.client_count || 0;
    const total = g.capacity || 254;
    const full = used >= total;
    const opt = document.createElement("option");
    opt.value = id;
    opt.disabled = full;
    opt.textContent = `${g.icon} ${g.name} (${used}/${total})${full ? " - LLENO" : ""}`;
    select.appendChild(opt);
  }
}

// ============================================
// Load clients
// ============================================

async function loadClients() {
  const btn = document.getElementById("btnRefreshClients");
  btn.innerHTML = '<i data-lucide="loader-circle" class="spin"></i>';
  if (typeof lucide !== "undefined") lucide.createIcons();
  btn.disabled = true;

  const r = await fetch("/api/clients");
  const d = await r.json();

  document.getElementById("clientsCount").textContent = d.clients.length;

  const byGroup = {};
  for (const c of d.clients) {
    const gid = c.group || "sin-grupo";
    if (!byGroup[gid]) byGroup[gid] = [];
    byGroup[gid].push(c);
  }

  const sortedGroups = Object.entries(groups).sort((a, b) => {
    if (a[1].is_system) return -1;
    if (b[1].is_system) return 1;
    return a[1].name.localeCompare(b[1].name);
  });

  let html = "";

  for (const [gid, g] of sortedGroups) {
    const clients = byGroup[gid] || [];
    const onlineCount = clients.filter((c) =>
      connectedClients.includes(c.name),
    ).length;

    html += `
      <div class="group-header-collapsible" onclick="toggleGroup('${gid}')">
        <div style="display:flex; align-items:center; gap:8px;">
          <span class="collapse-icon collapsed" id="group-icon-${gid}">▼</span>
          <span style="font-size:20px;">${esc(g.icon)}</span>
          <strong class="group-section-name">${esc(g.name)}</strong>
          <span class="count-badge">${clients.length}</span>
          ${onlineCount > 0 ? `<span class="badge badge-online">${onlineCount} online</span>` : ""}
        </div>
      </div>
      <div class="group-clients collapsed" id="group-content-${gid}">
    `;

    if (clients.length === 0) {
      html +=
        '<p class="info-text" style="padding:10px 16px;">Sin clientes</p>';
    } else {
      for (const c of clients) {
        const isOnline = connectedClients.includes(c.name);
        const badge = isOnline
          ? '<span class="badge badge-online">● Online</span>'
          : '<span class="badge badge-offline">○ Offline</span>';

        html += `
          <div class="client-row">
            <div>
              <span class="client-name">${esc(c.name)}</span>
              <span class="client-ip">${esc(c.ip || "IP dinámica")}</span>
              ${badge}
            </div>
            <a href="/download/${encodeURIComponent(c.name)}" class="btn-small btn-secondary"><i data-lucide="download" style="width:12px;height:12px;vertical-align:middle;margin-right:3px;"></i>.ovpn</a>
          </div>
        `;
      }
    }
    html += "</div>";
  }

  document.getElementById("clientsByGroup").innerHTML =
    html ||
    '<div class="empty-state"><p>No hay clientes</p></div>';

  restoreGroupStates();
  if (typeof lucide !== "undefined") lucide.createIcons();

  btn.innerHTML = '<i data-lucide="refresh-cw"></i>';
  btn.disabled = false;
  if (typeof lucide !== "undefined") lucide.createIcons();
}

// ============================================
// Load connected clients
// ============================================

async function loadConnected() {
  const btn = document.getElementById("btnRefreshConnected");
  btn.innerHTML = '<i data-lucide="loader-circle" class="spin"></i>';
  if (typeof lucide !== "undefined") lucide.createIcons();
  btn.disabled = true;

  const r = await fetch("/api/connected");
  const d = await r.json();
  connectedClients = d.clients.map((c) => c.name);

  const tbody = document.getElementById("connectedList");
  document.getElementById("connectedCount").textContent = d.clients.length;

  if (d.clients.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="6" style="color:var(--muted-2);text-align:center;padding:20px;">Sin conexiones activas</td></tr>';
  } else {
    tbody.innerHTML = d.clients
      .map((c) => {
        const grpBadge = c.group_name
          ? `<span class="badge badge-group">${esc(c.group_icon)} ${esc(c.group_name)}</span>`
          : '<span style="color:var(--muted-2)">-</span>';
        // VPN IP: link only when it looks like a real IPv4 (prevents href injection)
        const rawVpnIp = c.vpn_ip || "";
        const isRealIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(rawVpnIp);
        const vpnIpCell = isRealIp
          ? `<a href="http://${esc(rawVpnIp)}" target="_blank" rel="noopener noreferrer" class="vpn-ip-link">${esc(rawVpnIp)}</a>`
          : `<span class="vpn-ip-dynamic">Dinámica</span>`;
        return `
          <tr>
            <td class="td-name" data-label="Cliente"><strong>${esc(c.name)}</strong></td>
            <td class="td-group" data-label="Grupo">${grpBadge}</td>
            <td class="td-vpn-ip" data-label="IP VPN">${vpnIpCell}</td>
            <td class="td-real-ip" data-label="IP Real">${esc(c.real_ip)}</td>
            <td class="td-since" data-label="Conectado">${esc(c.connected_since)}</td>
            <td class="td-traffic" data-label="Tráfico">↓${esc(c.bytes_recv)} ↑${esc(c.bytes_sent)}</td>
          </tr>
        `;
      })
      .join("");
  }

  btn.innerHTML = '<i data-lucide="refresh-cw"></i>';
  btn.disabled = false;
  if (typeof lucide !== "undefined") lucide.createIcons();
  loadClients();
}

// ============================================
// Load rejected clients
// ============================================

async function loadRejected() {
  const r = await fetch("/api/rejected");
  const d = await r.json();

  const tbody = document.getElementById("rejectedList");
  const card = document.getElementById("rejectedCard");

  if (d.clients.length === 0) {
    card.style.display = "none";
  } else {
    card.style.display = "block";
    document.getElementById("rejectedCount").textContent = d.clients.length;
    tbody.innerHTML = d.clients
      .map(
        (c) => `
        <tr class="rejected-row">
          <td class="td-name" data-label="Cliente"><strong>${esc(c.name)}</strong></td>
          <td class="td-real-ip" data-label="IP Real">${esc(c.real_ip)}</td>
          <td class="td-since" data-label="Último intento">${esc(c.last_attempt)}</td>
          <td class="td-traffic" data-label="Motivo" style="color:var(--danger);font-size:12px">${esc(c.reason)}</td>
        </tr>
      `,
      )
      .join("");
  }
}

// ============================================
// Initialize
// ============================================

restoreSectionStates();
loadGroups();
loadConnected();
loadRejected();
setInterval(loadConnected, 30000);
setInterval(loadRejected, 30000);
