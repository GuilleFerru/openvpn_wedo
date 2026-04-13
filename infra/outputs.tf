output "vpn_static_ip" {
  description = "IP pública estática de la VM VPN"
  value       = google_compute_address.vpn_static_ip.address
}

output "vpn_admin_url" {
  description = "URL del panel de administración"
  value       = "https://${var.domain_name}"
}

output "ssh_command" {
  description = "Comando SSH via IAP"
  value       = "gcloud compute ssh ${google_compute_instance.vpn_vm.name} --zone=${var.zone} --tunnel-through-iap"
}

output "serial_logs_command" {
  description = "Comando para ver logs de la VM (startup script)"
  value       = "gcloud compute instances get-serial-port-output ${google_compute_instance.vpn_vm.name} --zone=${var.zone}"
}

output "dns_record" {
  description = "Registro DNS a configurar"
  value       = "${var.domain_name} → A → ${google_compute_address.vpn_static_ip.address}"
}

output "backup_bucket" {
  description = "Bucket GCS para backups"
  value       = "gs://${google_storage_bucket.vpn_backups.name}"
}

output "persistent_disk" {
  description = "Disco persistente para datos VPN (prevent_destroy = true)"
  value       = google_compute_disk.vpn_data.name
}
