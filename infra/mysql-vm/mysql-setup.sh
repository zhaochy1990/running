#!/usr/bin/env bash
set -Eeuo pipefail

export DEBIAN_FRONTEND=noninteractive

MYSQL_DATABASE=$(printf '%s' '__MYSQL_DATABASE_B64__' | base64 --decode)
MYSQL_APP_USER=$(printf '%s' '__MYSQL_APP_USER_B64__' | base64 --decode)
MYSQL_ALLOWED_HOST=$(printf '%s' '__MYSQL_ALLOWED_HOST_B64__' | base64 --decode)
MYSQL_ALLOWED_CIDR=$(printf '%s' '__MYSQL_ALLOWED_CIDR_B64__' | base64 --decode)
LOG_FILE=/var/log/stride-mysql-setup.log
SECRETS_FILE=/etc/stride/mysql.env
MYSQL_DATA_DIR=/var/lib/mysql

exec > >(tee -a "$LOG_FILE") 2>&1

echo "[$(date --iso-8601=seconds)] starting STRIDE MySQL bootstrap"

if [[ ! "$MYSQL_DATABASE" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "MYSQL_DATABASE must contain only letters, digits, and underscores"
  exit 1
fi

if [[ ! "$MYSQL_APP_USER" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "MYSQL_APP_USER must contain only letters, digits, and underscores"
  exit 1
fi

if [[ ! "$MYSQL_ALLOWED_HOST" =~ ^[A-Za-z0-9_.:%-]+$ ]]; then
  echo "MYSQL_ALLOWED_HOST contains unsupported characters"
  exit 1
fi

apt-get update
apt-get install -y --no-install-recommends ca-certificates curl jq mysql-server openssl rsync ufw

if ! findmnt --mountpoint "$MYSQL_DATA_DIR" >/dev/null 2>&1; then
  device_path=''
  for _ in $(seq 1 60); do
    device_path=$(readlink -f /dev/disk/azure/scsi1/lun0 2>/dev/null || true)
    if [[ -n "$device_path" && -b "$device_path" ]]; then
      break
    fi
    sleep 2
  done

  if [[ -z "$device_path" || ! -b "$device_path" ]]; then
    echo "managed data disk /dev/disk/azure/scsi1/lun0 was not found"
    exit 1
  fi

  systemctl stop mysql || true

  if ! blkid "$device_path" >/dev/null 2>&1; then
    mkfs.ext4 -F "$device_path"
  fi

  mkdir -p /mnt/stride-mysql-data
  mount "$device_path" /mnt/stride-mysql-data
  rsync -aHAX --delete "$MYSQL_DATA_DIR"/ /mnt/stride-mysql-data/
  umount /mnt/stride-mysql-data

  uuid=$(blkid -s UUID -o value "$device_path")
  if ! grep -q "$uuid" /etc/fstab; then
    echo "UUID=$uuid $MYSQL_DATA_DIR ext4 defaults,nofail,discard 0 2" >> /etc/fstab
  fi

  mount "$MYSQL_DATA_DIR"
  chown -R mysql:mysql "$MYSQL_DATA_DIR"
fi

install -d -m 0750 -o root -g mysql /etc/stride

if [[ ! -f "$SECRETS_FILE" ]]; then
  root_password=$(openssl rand -base64 48 | tr -d '\n')
  app_password=$(openssl rand -base64 48 | tr -d '\n')
  {
    printf 'MYSQL_ROOT_PASSWORD=%q\n' "$root_password"
    printf 'MYSQL_APP_PASSWORD=%q\n' "$app_password"
  } > "$SECRETS_FILE"
  chmod 0640 "$SECRETS_FILE"
  chown root:mysql "$SECRETS_FILE"
fi

# shellcheck disable=SC1090
source "$SECRETS_FILE"

cat >/etc/stride/mysql-client.cnf <<CLIENTCNF
[client]
user=root
password=${MYSQL_ROOT_PASSWORD}
protocol=socket
CLIENTCNF
chmod 0640 /etc/stride/mysql-client.cnf
chown root:mysql /etc/stride/mysql-client.cnf

install -d -m 0755 /etc/systemd/system/mysql.service.d
cat >/etc/systemd/system/mysql.service.d/override.conf <<'SYSTEMD'
[Service]
LimitNOFILE=65535
SYSTEMD

cat >/etc/mysql/mysql.conf.d/stride.cnf <<MYSQLCNF
[mysqld]
bind-address = 0.0.0.0
mysqlx-bind-address = 127.0.0.1
require_secure_transport = ON
local_infile = OFF
skip_name_resolve = ON
max_connections = 200
innodb_buffer_pool_size = 512M
innodb_flush_method = O_DIRECT
server_id = 1
log_bin = mysql-bin
binlog_expire_logs_seconds = 604800
MYSQLCNF

systemctl daemon-reload
systemctl enable mysql
systemctl restart mysql

mysql_root_args=(--protocol=socket)
if mysql --defaults-extra-file=/etc/stride/mysql-client.cnf -e "SELECT 1" >/dev/null 2>&1; then
  mysql_root_args=(--defaults-extra-file=/etc/stride/mysql-client.cnf)
fi

mysql "${mysql_root_args[@]}" <<SQL
ALTER USER 'root'@'localhost' IDENTIFIED WITH caching_sha2_password BY '${MYSQL_ROOT_PASSWORD}';
CREATE DATABASE IF NOT EXISTS \`${MYSQL_DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER IF NOT EXISTS '${MYSQL_APP_USER}'@'${MYSQL_ALLOWED_HOST}' IDENTIFIED WITH caching_sha2_password BY '${MYSQL_APP_PASSWORD}' REQUIRE SSL;
ALTER USER '${MYSQL_APP_USER}'@'${MYSQL_ALLOWED_HOST}' IDENTIFIED WITH caching_sha2_password BY '${MYSQL_APP_PASSWORD}' REQUIRE SSL;
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES, CREATE TEMPORARY TABLES, LOCK TABLES, EXECUTE ON \`${MYSQL_DATABASE}\`.* TO '${MYSQL_APP_USER}'@'${MYSQL_ALLOWED_HOST}';
DELETE FROM mysql.user WHERE User = '';
DROP DATABASE IF EXISTS test;
FLUSH PRIVILEGES;
SQL

tmp_app_client=$(mktemp)
cat >"$tmp_app_client" <<APPCLIENT
[client]
user=${MYSQL_APP_USER}
password=${MYSQL_APP_PASSWORD}
host=$(hostname -I | awk '{print $1}')
database=${MYSQL_DATABASE}
ssl-mode=REQUIRED
APPCLIENT
chmod 0600 "$tmp_app_client"
mysql --defaults-extra-file="$tmp_app_client" -e "SELECT 1 AS app_user_can_connect;"
rm -f "$tmp_app_client"

ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow from "$MYSQL_ALLOWED_CIDR" to any port 22 proto tcp
ufw allow from "$MYSQL_ALLOWED_CIDR" to any port 3306 proto tcp
ufw --force enable

mysql --defaults-extra-file=/etc/stride/mysql-client.cnf -e "SELECT VERSION() AS mysql_version, @@require_secure_transport AS require_secure_transport;"
systemctl --no-pager --full status mysql | head -40

echo "[$(date --iso-8601=seconds)] STRIDE MySQL bootstrap completed"
