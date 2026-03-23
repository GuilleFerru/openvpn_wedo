// OpenVPN Admin - JavaScript

let groups = {};
let connectedClients = [];

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
    btn.textContent = theme === "dark" ? "☀️" : "🌙";
    btn.title =
      theme === "dark" ? "Cambiar a modo claro" : "Cambiar a modo oscuro";
  }
}

// Apply icon on load
updateThemeIcon(document.documentElement.getAttribute("data-theme") || "dark");

// ============================================
// Collapsible sections with localStorage persistence
// ============================================

// Save section state to localStorage
function saveSectionState(sectionId, isCollapsed) {
  const states = JSON.parse(localStorage.getItem("sectionStates") || "{}");
  states[sectionId] = isCollapsed;
  localStorage.setItem("sectionStates", JSON.stringify(states));
}

// Get section state from localStorage
function getSectionState(sectionId, defaultCollapsed = true) {
  const states = JSON.parse(localStorage.getItem("sectionStates") || "{}");
  if (states.hasOwnProperty(sectionId)) {
    return states[sectionId];
  }
  return defaultCollapsed;
}

// Restore all section states on page load
function restoreSectionStates() {
  // Main sections with their defaults
  const sections = [
    { id: "connectedSection", defaultCollapsed: true },
    { id: "rejectedSection", defaultCollapsed: true },
    { id: "clientsSection", defaultCollapsed: false }, // Clientes por Grupo expanded by default
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

// Toggle collapsible sections (with persistence)
function toggleSection(sectionId) {
  const section = document.getElementById(sectionId);
  const icon = document.getElementById(sectionId + "-icon");
  section.classList.toggle("collapsed");
  icon.classList.toggle("collapsed");

  // Save state
  saveSectionState(sectionId, section.classList.contains("collapsed"));
}

// Toggle group in clients list (with persistence)
function toggleGroup(groupId) {
  const content = document.getElementById("group-content-" + groupId);
  const icon = document.getElementById("group-icon-" + groupId);
  content.classList.toggle("collapsed");
  icon.classList.toggle("collapsed");

  // Save state
  saveSectionState("group-" + groupId, content.classList.contains("collapsed"));
}

// Restore group states after loading clients
function restoreGroupStates() {
  Object.keys(groups).forEach((gid) => {
    const content = document.getElementById("group-content-" + gid);
    const icon = document.getElementById("group-icon-" + gid);
    if (content && icon) {
      const shouldBeCollapsed = getSectionState("group-" + gid, true); // Groups collapsed by default
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

// Monogram preview update functions
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

// Modal functions
function showModal(id) {
  document.getElementById(id).style.display = "flex";
}

function hideModal(id) {
  document.getElementById(id).style.display = "none";
}

// Edit group modal
function showEditGroupModal(groupId, name, icon) {
  document.getElementById("editGroupId").value = groupId;
  document.getElementById("editGroupName").value = name;
  document.getElementById("editGroupIcon").value = icon || "";
  document.getElementById("editMonogramPreview").textContent = icon || "AB";
  showModal("modalEditGroup");
}

// Create group modal
async function showCreateGroupModal() {
  document.getElementById("groupIcon").value = "";
  document.getElementById("monogramPreview").textContent = "AB";
  document.getElementById("groupName").value = "";
  showModal("modalCreateGroup");
  const r = await fetch("/api/next-group-range");
  const d = await r.json();
  if (d.available) {
    document.getElementById("groupRangePreview").textContent =
      `${d.start_ip} - ${d.end_ip}`;
  } else {
    document.getElementById("groupRangePreview").textContent =
      "No hay más rangos disponibles";
  }
}

// Edit group form
document.getElementById("editGroupForm").onsubmit = async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector("button");
  btn.disabled = true;
  btn.textContent = "Guardando...";

  const groupId = document.getElementById("editGroupId").value;
  const r = await fetch("/api/groups/" + groupId, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: document.getElementById("editGroupName").value,
      icon:
        document.getElementById("editGroupIcon").value.toUpperCase() || "AB",
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

// Create group form
document.getElementById("createGroupForm").onsubmit = async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector("button");
  btn.disabled = true;
  btn.textContent = "Creando...";

  const r = await fetch("/api/groups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

// Create client form
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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: document.getElementById("clientName").value,
      password: document.getElementById("caPassword").value,
      group: document.getElementById("clientGroup").value,
    }),
  });
  const d = await r.json();

  btn.disabled = false;

  if (d.success) {
    status.className = "status success";
    status.innerHTML = `✅ Cliente creado! IP: <strong>${d.ip}</strong> &nbsp; <a href="/download/${d.name}" style="color:#00d4ff;font-weight:bold;">📥 Descargar .ovpn</a> <span style="color:#888;font-size:12px;">(recargando en 3s...)</span>`;
    document.getElementById("clientName").value = "";
    setTimeout(() => location.reload(), 3000);
  } else {
    status.className = "status error";
    status.textContent = "❌ " + d.error;
  }
};

// Revoke client form
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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: document.getElementById("revokeClientName").value,
      password: document.getElementById("revokePassword").value,
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

// Load groups
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

  if (sortedGroups.length === 0) {
    container.innerHTML =
      '<div class="empty-state"><div class="icon">📁</div><p>No hay grupos creados</p></div>';
  } else {
    let html = "";
    for (const [id, g] of sortedGroups) {
      const used = g.client_count || 0;
      const total = g.capacity || 254;
      const isAdmin = g.is_system || g.can_see_all;

      html += `
                <div class="group-card ${isAdmin ? "admin" : ""}">
                    <div class="group-header">
                        <div>
                            <span class="group-icon">${g.icon}</span>
                            <span class="group-name">${g.name}</span>
                            ${isAdmin ? '<span class="badge badge-admin" style="margin-left:10px;">VE TODO</span>' : ""}
                            ${!isAdmin ? `<button class="btn-edit" onclick="showEditGroupModal('${id}', '${g.name.replace(/'/g, "\\'")}', '${g.icon}')">✏️</button>` : ""}
                        </div>
                        <div style="text-align:right;">
                            <div><strong>${used}</strong> / ${total}</div>
                            <div class="group-range">${g.start_ip} - ${g.end_ip}</div>
                        </div>
                    </div>
                </div>
            `;
    }
    container.innerHTML = html;
  }

  select.innerHTML = '<option value="">-- Seleccionar grupo --</option>';
  for (const [id, g] of sortedGroups) {
    const used = g.client_count || 0;
    const total = g.capacity || 254;
    const full = used >= total;
    select.innerHTML += `<option value="${id}" ${full ? "disabled" : ""}>${g.icon} ${g.name} (${used}/${total})${full ? " - LLENO" : ""}</option>`;
  }
}

// Load clients
async function loadClients() {
  const btn = document.getElementById("btnRefreshClients");
  btn.innerHTML = "⏳";
  btn.disabled = true;

  const r = await fetch("/api/clients");
  const d = await r.json();

  // Update count badge
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
                    <span style="font-size:20px;">${g.icon}</span>
                    <strong style="color:#ffd700;">${g.name}</strong>
                    <span class="count-badge">${clients.length}</span>
                    ${onlineCount > 0 ? `<span class="badge badge-online">${onlineCount} online</span>` : ""}
                </div>
            </div>
            <div class="group-clients collapsed" id="group-content-${gid}">
        `;

    if (clients.length === 0) {
      html +=
        '<p style="color:#555;font-size:13px;margin-left:10px;padding:10px;">Sin clientes</p>';
    } else {
      for (const c of clients) {
        const isOnline = connectedClients.includes(c.name);
        const badge = isOnline
          ? '<span class="badge badge-online">● Online</span>'
          : '<span class="badge badge-offline">○ Offline</span>';

        html += `
                    <div class="client-row">
                        <div>
                            <span class="client-name">${c.name}</span>
                            <span class="client-ip">${c.ip || "IP dinámica"}</span>
                            ${badge}
                        </div>
                        <a href="/download/${c.name}" class="btn-small" style="background:#0f3460;color:#00d4ff;">📥 .ovpn</a>
                    </div>
                `;
      }
    }
    html += "</div>";
  }

  document.getElementById("clientsByGroup").innerHTML =
    html ||
    '<div class="empty-state"><div class="icon">👥</div><p>No hay clientes</p></div>';

  // Restore group collapsed states from localStorage
  restoreGroupStates();

  btn.innerHTML = "🔄";
  btn.disabled = false;
}

// Load connected clients
async function loadConnected() {
  const btn = document.getElementById("btnRefreshConnected");
  btn.innerHTML = "⏳";
  btn.disabled = true;

  const r = await fetch("/api/connected");
  const d = await r.json();
  connectedClients = d.clients.map((c) => c.name);

  const tbody = document.getElementById("connectedList");

  // Update count badge
  document.getElementById("connectedCount").textContent = d.clients.length;

  if (d.clients.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="6" style="color:#555;text-align:center;">Sin conexiones activas</td></tr>';
  } else {
    tbody.innerHTML = d.clients
      .map((c) => {
        const grpBadge = c.group_name
          ? `<span class="badge badge-group">${c.group_icon} ${c.group_name}</span>`
          : '<span style="color:#666">-</span>';
        const vpnIpLink =
          c.vpn_ip && c.vpn_ip !== "Dinámica"
            ? `<a href="http://${c.vpn_ip}" target="_blank" style="color:#00d4ff;text-decoration:none;" title="Abrir en nueva pestaña">${c.vpn_ip}</a>`
            : c.vpn_ip;
        return `
                <tr>
                    <td><strong>${c.name}</strong></td>
                    <td>${grpBadge}</td>
                    <td style="font-family:monospace">${vpnIpLink}</td>
                    <td style="font-family:monospace;color:#888">${c.real_ip}</td>
                    <td style="color:#888;font-size:12px">${c.connected_since}</td>
                    <td style="font-size:12px">↓${c.bytes_recv} ↑${c.bytes_sent}</td>
                </tr>
            `;
      })
      .join("");
  }

  btn.innerHTML = "🔄";
  btn.disabled = false;
  loadClients();
}

// Load rejected clients
async function loadRejected() {
  const r = await fetch("/api/rejected");
  const d = await r.json();

  const tbody = document.getElementById("rejectedList");
  const card = document.getElementById("rejectedCard");

  if (d.clients.length === 0) {
    card.style.display = "none";
  } else {
    card.style.display = "block";
    // Update count badge
    document.getElementById("rejectedCount").textContent = d.clients.length;
    tbody.innerHTML = d.clients
      .map(
        (c) => `
            <tr style="background: rgba(255,77,77,0.1);">
                <td><strong style="color:#ff6b6b;">${c.name}</strong></td>
                <td style="font-family:monospace;color:#888">${c.real_ip}</td>
                <td style="color:#888;font-size:12px">${c.last_attempt}</td>
                <td style="color:#ff6b6b;font-size:12px">${c.reason}</td>
            </tr>
        `,
      )
      .join("");
  }
}

// Initialize
restoreSectionStates(); // Restore collapsed/expanded states from localStorage
loadGroups();
loadConnected();
loadRejected();
setInterval(loadConnected, 30000);
setInterval(loadRejected, 30000);
