# ============================================================
# Bucket GCS para backups — fuera de cualquier VM/disco
# ============================================================

resource "google_storage_bucket" "vpn_backups" {
  name     = "${var.project_id}-vpn-prod-backups"
  location = var.region

  uniform_bucket_level_access = true
  force_destroy               = false

  # Retener backups 90 días, luego eliminar automáticamente
  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      age = 90
    }
  }

  # Versionado para proteger contra sobreescrituras accidentales
  versioning {
    enabled = true
  }
}
