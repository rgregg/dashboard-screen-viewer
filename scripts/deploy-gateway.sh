#!/usr/bin/env bash
# Provisions or updates the gateway and its storage from infra/main.bicep. Idempotent; rerun to
# add or revoke tokens or to roll out a new image.
#
# Required:
#   AZURE_SUBSCRIPTION              subscription name or ID
#   AZURE_RESOURCE_GROUP            resource group (created if missing)
#   AZURE_LOCATION                  region, for example westus2
#   STORAGE_ACCOUNT_NAME            globally unique, 3-24 lowercase letters and digits
#   GATEWAY_IMAGE                   public image, for example ghcr.io/OWNER/dashboard-screen-viewer-gateway:TAG
#   GATEWAY_DEVICE_TOKENS_FILE      JSON list of display token hashes (see scripts/create-device.ts)
# Optional:
#   GATEWAY_PUBLISHER_TOKENS_FILE   JSON list of publisher token hashes (default: none, so nothing can publish)
#   STORAGE_CONTAINER_NAME          default: screenshots
#   GATEWAY_NAME                    default: dashboard-gateway
#
# Prints the gateway URL on success.
set -euo pipefail

: "${AZURE_SUBSCRIPTION:?}" "${AZURE_RESOURCE_GROUP:?}" "${AZURE_LOCATION:?}" "${STORAGE_ACCOUNT_NAME:?}" "${GATEWAY_IMAGE:?}" "${GATEWAY_DEVICE_TOKENS_FILE:?}"
export GATEWAY_DEVICE_TOKENS_FILE GATEWAY_PUBLISHER_TOKENS_FILE="${GATEWAY_PUBLISHER_TOKENS_FILE:-}"
container_name="${STORAGE_CONTAINER_NAME:-screenshots}"
gateway_name="${GATEWAY_NAME:-dashboard-gateway}"

if [[ ! -f package.json || ! -f infra/main.bicep ]]; then
  echo "Run this script from the repository root." >&2
  exit 1
fi

az account set --subscription "$AZURE_SUBSCRIPTION"
az bicep install --only-show-errors >/dev/null 2>&1 || true
npm run build >/dev/null

umask 077
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
# Validate the token lists, then write them (and their fingerprint) to a private parameters file,
# so the hashes never appear on a command line.
node --input-type=module >"$work/parameters.json" <<'JS'
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseDeviceHashes } from "./dist/src/device-auth.js";
const read = (file, setting) => {
  if (!file) return "{}";
  const raw = readFileSync(file, "utf8");
  parseDeviceHashes(raw, setting);
  return JSON.stringify(JSON.parse(raw));
};
const devices = read(process.env.GATEWAY_DEVICE_TOKENS_FILE, "GATEWAY_DEVICE_TOKENS");
const publishers = read(process.env.GATEWAY_PUBLISHER_TOKENS_FILE, "GATEWAY_PUBLISHER_TOKENS");
const version = createHash("sha256").update(devices).update("\n").update(publishers).digest("hex").slice(0, 16);
console.log(JSON.stringify({
  $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
  contentVersion: "1.0.0.0",
  parameters: {
    deviceTokenHashes: { value: devices },
    publisherTokenHashes: { value: publishers },
    tokenListsVersion: { value: version },
  },
}));
JS

az group create --name "$AZURE_RESOURCE_GROUP" --location "$AZURE_LOCATION" --output none
for provider in Microsoft.App Microsoft.ManagedIdentity Microsoft.Storage; do
  az provider register --namespace "$provider" --wait --output none
done

# Azure rejects a second identical role assignment under a different name, so skip creating it if
# the identity already has the role on the container (for example from an earlier deployment).
assign_role=true
principal_id="$(az identity show --name "$gateway_name-identity" --resource-group "$AZURE_RESOURCE_GROUP" --query principalId --output tsv 2>/dev/null || true)"
storage_id="$(az storage account show --name "$STORAGE_ACCOUNT_NAME" --resource-group "$AZURE_RESOURCE_GROUP" --query id --output tsv 2>/dev/null || true)"
if [[ -n "$principal_id" && -n "$storage_id" ]]; then
  existing="$(az role assignment list --assignee "$principal_id" --role ba92f5b4-2d11-453d-a403-e96b0029c9fe \
    --scope "$storage_id/blobServices/default/containers/$container_name" --query '[0].name' --output tsv)"
  if [[ -n "$existing" ]]; then assign_role=false; fi
fi

deployment="dashboard-gateway-$(date -u +%Y%m%d%H%M%S)"
url="$(az deployment group create --name "$deployment" --resource-group "$AZURE_RESOURCE_GROUP" \
  --template-file infra/main.bicep \
  --parameters @"$work/parameters.json" \
  --parameters location="$AZURE_LOCATION" storageAccountName="$STORAGE_ACCOUNT_NAME" containerName="$container_name" \
    gatewayName="$gateway_name" gatewayImage="$GATEWAY_IMAGE" assignBlobRole="$assign_role" \
  --query properties.outputs.gatewayUrl.value --output tsv --only-show-errors)"

curl --fail --silent --show-error --retry 12 --retry-all-errors --retry-delay 5 --connect-timeout 10 --max-time 60 "$url/healthz" >/dev/null
printf 'Gateway deployed: %s\n' "$url"
