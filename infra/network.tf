# ============================================================
# VPC dedicada — aislada de tb-prod-vpc (ThingsBoard)
# Sin peering, sin rutas compartidas, sin acceso lateral
# ============================================================

resource "google_compute_network" "vpn_vpc" {
  name                    = "vpn-prod-vpc"
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"
}

resource "google_compute_subnetwork" "vpn_subnet" {
  name                     = "vpn-prod-subnet"
  ip_cidr_range            = "10.30.1.0/24"
  region                   = var.region
  network                  = google_compute_network.vpn_vpc.id
  private_ip_google_access = true
}

# Cloud Router + NAT para salida a internet (apt-get, docker pull, etc.)
resource "google_compute_router" "vpn_router" {
  name    = "vpn-prod-router"
  region  = var.region
  network = google_compute_network.vpn_vpc.id
}

resource "google_compute_router_nat" "vpn_nat" {
  name                               = "vpn-prod-nat"
  router                             = google_compute_router.vpn_router.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"

  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}
