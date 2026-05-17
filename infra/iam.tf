# ============================================================
# Service Account dedicado — sin acceso a recursos de TB
# ============================================================

resource "google_service_account" "vpn_sa" {
  account_id   = "vpn-prod-sa"
  display_name = "VPN Production Service Account"
}

# Logging — enviar logs a Cloud Logging
resource "google_project_iam_member" "vpn_logging" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.vpn_sa.email}"
}

# Monitoring — enviar métricas a Cloud Monitoring
resource "google_project_iam_member" "vpn_monitoring" {
  project = var.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.vpn_sa.email}"
}

# Storage — escribir backups al bucket GCS
resource "google_storage_bucket_iam_member" "vpn_backup_writer" {
  bucket = google_storage_bucket.vpn_backups.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.vpn_sa.email}"
}

# Secret Manager — leer admin-password y secret-key desde la VM
resource "google_secret_manager_secret_iam_member" "vpn_admin_password_access" {
  secret_id = google_secret_manager_secret.admin_password.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.vpn_sa.email}"
}

resource "google_secret_manager_secret_iam_member" "vpn_secret_key_access" {
  secret_id = google_secret_manager_secret.secret_key.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.vpn_sa.email}"
}
