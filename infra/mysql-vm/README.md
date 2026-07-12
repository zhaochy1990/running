# MySQL VM Infrastructure

This directory defines the first production-shaped MySQL host for the future
SQLite replacement work. This PR only creates the VM and installs MySQL; the
STRIDE application still reads and writes the existing SQLite databases until a
separate data-access migration changes that path.

## What It Creates

- Ubuntu 24.04 LTS VM with a system-assigned managed identity.
- Private VNet/subnet with no public IP on the VM NIC.
- Standard NAT Gateway so cloud-init can install packages without exposing the
  VM inbound to the internet.
- NSG rules allowing SSH and MySQL only from the VNet.
- Managed data disk mounted at `/var/lib/mysql`.
- MySQL Server with an initial `stride` database and `stride_app` user.
- VM-local generated passwords in `/etc/stride/mysql.env` and a root socket
  client file at `/etc/stride/mysql-client.cnf`.

The app user is created with `REQUIRE SSL`, and `mysqld` has
`require_secure_transport = ON`.

## Manual Deployment

Use the GitHub Actions workflow when possible:

1. Open **Actions > MySQL VM Infrastructure**.
2. Run `validate` first.
3. Run `what-if` and inspect the resource diff.
4. Run `deploy` after the diff looks right.

The workflow uses the same OIDC Azure login variables as the main deploy flow:
`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and `AZURE_SUBSCRIPTION_ID`.

The default target is `rg-running-prod` in `southeastasia`, with resource names
prefixed by `stride-mysql`.

## Local Commands

Compile the template:

```bash
az bicep build --file infra/mysql-vm/main.bicep
```

Validate without creating resources:

```bash
az deployment group validate \
  --resource-group rg-running-prod \
  --template-file infra/mysql-vm/main.bicep \
  --parameters \
    location=southeastasia \
    adminSshPublicKey="$(cat ~/.ssh/id_rsa.pub)"
```

Preview the diff:

```bash
az deployment group what-if \
  --resource-group rg-running-prod \
  --template-file infra/mysql-vm/main.bicep \
  --parameters \
    location=southeastasia \
    adminSshPublicKey="$(cat ~/.ssh/id_rsa.pub)"
```

Deploy:

```bash
az deployment group create \
  --resource-group rg-running-prod \
  --name mysql-vm-manual \
  --template-file infra/mysql-vm/main.bicep \
  --parameters \
    location=southeastasia \
    adminSshPublicKey="$(cat ~/.ssh/id_rsa.pub)"
```

## Smoke Test

After deployment, wait for cloud-init and check MySQL through Azure Run Command:

```bash
az vm run-command invoke \
  --resource-group rg-running-prod \
  --name stride-mysql-vm \
  --command-id RunShellScript \
  --scripts '
    set -euo pipefail
    cloud-init status --wait --long
    systemctl is-active --quiet mysql
    sudo mysql --defaults-extra-file=/etc/stride/mysql-client.cnf \
      -e "SELECT VERSION() AS mysql_version, @@require_secure_transport AS require_secure_transport;"
  ' \
  --query "value[0].message" \
  -o tsv
```

## Retrieving Connection Material

Connection secrets are intentionally generated on the VM, not passed through
GitHub Actions logs. To inspect them through Run Command:

```bash
az vm run-command invoke \
  --resource-group rg-running-prod \
  --name stride-mysql-vm \
  --command-id RunShellScript \
  --scripts 'sudo cat /etc/stride/mysql.env' \
  --query "value[0].message" \
  -o tsv
```

Move those values into Key Vault before wiring application connection strings.
Do not commit or paste them into PR comments.

## Migration Boundary

This infrastructure does not move any SQLite data. The follow-up migration work
should add a MySQL-backed storage implementation under `src/stride_storage/`,
dual-write or backfill plans, and application configuration for selecting the
database backend.
