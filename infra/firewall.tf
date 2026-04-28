# ============================================================
# Firewall rules — superficie mínima
# ============================================================

# OpenVPN — UDP 1194 desde cualquier origen
resource "google_compute_firewall" "vpn_udp" {
  name    = "vpn-prod-fw-vpn"
  network = google_compute_network.vpn_vpc.name

  allow {
    protocol = "udp"
    ports    = ["1194"]
  }

  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["vpn-prod-app"]
}

# OpenVPN daemon moderno — UDP 1195 para clientes con OpenVPN 2.5+ (sin comp-lzo).
# Ver docs/plan_2_daemons_ug63.md §3.3 / §9.1.
resource "google_compute_firewall" "vpn_udp_modern" {
  name    = "vpn-prod-fw-vpn-modern"
  network = google_compute_network.vpn_vpc.name

  allow {
    protocol = "udp"
    ports    = ["1195"]
  }

  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["vpn-prod-app"]
}

# HTTPS + HTTP (redirect) — TCP 80/443 desde cualquier origen
resource "google_compute_firewall" "https" {
  name    = "vpn-prod-fw-https"
  network = google_compute_network.vpn_vpc.name

  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }

  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["vpn-prod-app"]
}

# SSH via IAP — solo desde rangos de Identity-Aware Proxy de Google
resource "google_compute_firewall" "iap_ssh" {
  name    = "vpn-prod-fw-iap-ssh"
  network = google_compute_network.vpn_vpc.name

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["vpn-prod-iap-ssh"]
}
