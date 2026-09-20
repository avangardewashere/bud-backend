#!/usr/bin/env bash
#
# Nightly database backup, off the box.
#
#   ./infra/backup.sh
#   0 3 * * *  cd /srv/bud && ./infra/backup.sh >> /var/log/bud-backup.log 2>&1
#
# A dump sitting on the same disk as the database is not a backup — it dies with
# the machine. This takes the dump with pg_dump (in the postgres image, which
# already has the matching client version) and pushes it to object storage with
# mc (which speaks S3, so it works against R2 as well as MinIO). Two images
# because neither tool is in the other's.
#
# THIS IS HALF A BACKUP STRATEGY. The other half is restoring one, on purpose,
# before you need to. `pg_restore` against a scratch database, once, beats
# discovering the dumps were empty at the worst possible moment.

set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f .env ]; then
	set -a
	# shellcheck disable=SC1091
	. ./.env
	set +a
fi

: "${POSTGRES_USER:=bud}"
: "${POSTGRES_DB:=bud}"
: "${BACKUP_PREFIX:=backups/postgres}"
: "${BACKUP_KEEP_DAYS:=30}"
: "${S3_BUCKET:?S3_BUCKET must be set}"
: "${S3_ENDPOINT:?S3_ENDPOINT must be set}"
: "${S3_ACCESS_KEY_ID:?S3_ACCESS_KEY_ID must be set}"
: "${S3_SECRET_ACCESS_KEY:?S3_SECRET_ACCESS_KEY must be set}"

STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
FILE="bud-${STAMP}.sql.gz"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "==> Dumping ${POSTGRES_DB}"
# -T so compose does not allocate a TTY and corrupt the stream with control
# characters. --clean --if-exists so the dump can be restored over a database
# that already has objects.
docker compose -f compose.prod.yaml exec -T postgres \
	pg_dump --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --clean --if-exists \
	| gzip -9 > "${TMP}/${FILE}"

SIZE="$(wc -c < "${TMP}/${FILE}")"
echo "    ${FILE} — ${SIZE} bytes"

# A dump that is suspiciously small is usually an error message that got gzipped.
if [ "$SIZE" -lt 1024 ]; then
	echo "!!! Dump is under 1 KB. Refusing to upload it and overwrite a good one." >&2
	exit 1
fi

echo "==> Uploading to ${S3_BUCKET}/${BACKUP_PREFIX}/"
docker run --rm \
	-v "${TMP}:/backup:ro" \
	-e MC_HOST_target="https://${S3_ACCESS_KEY_ID}:${S3_SECRET_ACCESS_KEY}@${S3_ENDPOINT#https://}" \
	"${MINIO_MC_IMAGE:-quay.io/minio/mc:latest}" \
	cp "/backup/${FILE}" "target/${S3_BUCKET}/${BACKUP_PREFIX}/${FILE}"

echo "==> Pruning backups older than ${BACKUP_KEEP_DAYS} days"
docker run --rm \
	-e MC_HOST_target="https://${S3_ACCESS_KEY_ID}:${S3_SECRET_ACCESS_KEY}@${S3_ENDPOINT#https://}" \
	"${MINIO_MC_IMAGE:-quay.io/minio/mc:latest}" \
	rm --recursive --force --older-than "${BACKUP_KEEP_DAYS}d" \
	"target/${S3_BUCKET}/${BACKUP_PREFIX}/"

echo "==> Done: ${FILE}"
