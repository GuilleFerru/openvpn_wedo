.PHONY: init plan apply destroy status ssh logs reset-vm

# Inicializar Terraform (descargar providers, configurar backend)
init:
	terraform init

# Ver cambios pendientes sin aplicar
plan:
	terraform plan

# Aplicar cambios (crear/modificar infraestructura)
apply:
	terraform apply

# Ver estado actual de los recursos
status:
	terraform show

# SSH a la VM via IAP
ssh:
	gcloud compute ssh vpn-prod-vm --zone=us-central1-a --tunnel-through-iap

# Ver logs del startup script (serial port)
logs:
	gcloud compute instances get-serial-port-output vpn-prod-vm --zone=us-central1-a

# Destruir solo la VM (preserva VPC y firewall para reintentar)
destroy-vm:
	terraform destroy -target=google_compute_instance.vpn_vm

# Destruir toda la infraestructura
destroy-full:
	terraform destroy

# Recrear la VM (destroy + apply)
reset-vm: destroy-vm apply
