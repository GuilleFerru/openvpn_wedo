# ============================================================
# Secret Manager — secrets sensibles fuera de instance metadata
# ============================================================

resource "google_secret_manager_secret" "admin_password" {
  secret_id = "vpn-admin-password"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "admin_password" {
  secret      = google_secret_manager_secret.admin_password.id
  secret_data = var.admin_password
}

resource "google_secret_manager_secret" "secret_key" {
  secret_id = "vpn-secret-key"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "secret_key" {
  secret      = google_secret_manager_secret.secret_key.id
  secret_data = var.secret_key
}
