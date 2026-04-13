variable "project_id" {
  description = "ID del proyecto GCP"
  type        = string
  default     = "integracion-tagoio"
}

variable "region" {
  description = "Región GCP"
  type        = string
  default     = "us-central1"
}

variable "zone" {
  description = "Zona GCP"
  type        = string
  default     = "us-central1-a"
}

variable "domain_name" {
  description = "Dominio para el panel admin (HTTPS via Traefik + Let's Encrypt)"
  type        = string
  default     = "vpn.we-do.io"
}

variable "acme_email" {
  description = "Email para Let's Encrypt (requerido por protocolo ACME)"
  type        = string
  default     = "admin@we-do.io"
}

variable "admin_password" {
  description = "Password del panel de administración web"
  type        = string
  sensitive   = true
}

variable "secret_key" {
  description = "Flask session secret key (generar con: python -c \"import secrets; print(secrets.token_hex(32))\")"
  type        = string
  sensitive   = true
}

variable "machine_type" {
  description = "Tipo de máquina GCE para la VM"
  type        = string
  default     = "e2-small"
}

variable "disk_size_gb" {
  description = "Tamaño del disco boot en GB"
  type        = number
  default     = 20
}

variable "repo_url" {
  description = "URL del repositorio git para clonar en la VM"
  type        = string
  default     = "https://github.com/we-do-io/openvpn_wedo.git"
}
