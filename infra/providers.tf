terraform {
  required_version = ">= 1.6.0"

  backend "gcs" {
    bucket = "tfstate-vpn-prod"
    prefix = "terraform/state"
  }

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.30"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
}
