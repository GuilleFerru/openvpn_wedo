# ============================================================
# VM + IP estática + disco persistente para OpenVPN
# ============================================================

resource "google_compute_address" "vpn_static_ip" {
  name   = "vpn-prod-static-ip"
  region = var.region
}

# Disco persistente separado para datos VPN (PKI, clients, CCD)
# Sobrevive a la destrucción de la VM
resource "google_compute_disk" "vpn_data" {
  name = "vpn-prod-data"
  type = "pd-balanced"
  size = 10 # GB — suficiente para PKI + configs + .ovpn
  zone = var.zone

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_compute_instance" "vpn_vm" {
  name         = "vpn-prod-vm"
  machine_type = var.machine_type
  zone         = var.zone
  tags         = ["vpn-prod-app", "vpn-prod-iap-ssh"]

  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2204-lts"
      size  = var.disk_size_gb
      type  = "pd-balanced"
    }
  }

  # Disco persistente para datos VPN
  attached_disk {
    source      = google_compute_disk.vpn_data.id
    device_name = "vpn-data"
  }

  network_interface {
    subnetwork = google_compute_subnetwork.vpn_subnet.id

    access_config {
      nat_ip = google_compute_address.vpn_static_ip.address
    }
  }

  # Metadata — secrets inyectados desde Terraform variables
  metadata = {
    enable-oslogin     = "TRUE"
    serial-port-enable = "TRUE"
    admin-password     = var.admin_password
    secret-key         = var.secret_key
    domain-name        = var.domain_name
    acme-email         = var.acme_email
    public-ip          = google_compute_address.vpn_static_ip.address
    repo-url           = var.repo_url
    backup-bucket      = google_storage_bucket.vpn_backups.name
  }

  metadata_startup_script = file("${path.module}/scripts/startup.sh")

  service_account {
    email  = google_service_account.vpn_sa.email
    scopes = ["https://www.googleapis.com/auth/cloud-platform"]
  }

  allow_stopping_for_update = true

  depends_on = [
    google_compute_router_nat.vpn_nat
  ]
}
