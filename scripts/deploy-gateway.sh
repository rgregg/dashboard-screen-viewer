#!/usr/bin/env bash
# Provisions (or updates) everything the gateway needs. Idempotent; safe to rerun.
#
# Required:
#   AZURE_SUBSCRIPTION              subscription name or ID
#   AZURE_RESOURCE_GROUP            resource group (created if missing)
#   AZURE_LOCATION                  region, for example westus2
#   STORAGE_ACCOUNT_NAME            globally unique, 3-24 lowercase letters and digits
#   GATEWAY_IMAGE                   container image, for example ghcr.io/OWNER/dashboard-screen-viewer-gateway:TAG
#   GATEWAY_DEVICE_TOKENS_FILE      JSON registry of display token hashes (scripts/create-device.ts output)
# Optional:
#   GATEWAY_PUBLISHER_TOKENS_FILE   JSON registry of publisher token hashes (default: no publishers)
#   STORAGE_CONTAINER_NAME          default: screenshots
#   GATEWAY_NAME                    default: dashboard-gateway
set -euo pipefail

: "${AZURE_SUBSCRIPTION:?}" "${AZURE_RESOURCE_GROUP:?}" "${AZURE_LOCATION:?}" "${STORAGE_ACCOUNT_NAME:?}" "${GATEWAY_IMAGE:?}" "${GATEWAY_DEVICE_TOKENS_FILE:?}"
export STORAGE_CONTAINER_NAME="${STORAGE_CONTAINER_NAME:-screenshots}"
export GATEWAY_NAME="${GATEWAY_NAME:-dashboard-gateway}"
export GATEWAY_ENVIRONMENT_NAME="${GATEWAY_ENVIRONMENT_NAME:-$GATEWAY_NAME-env}"
export GATEWAY_IDENTITY_NAME="${GATEWAY_IDENTITY_NAME:-$GATEWAY_NAME-identity}"
export GATEWAY_DEVICE_TOKENS_FILE GATEWAY_IMAGE AZURE_LOCATION
export GATEWAY_PUBLISHER_TOKENS_FILE="${GATEWAY_PUBLISHER_TOKENS_FILE:-}"

if [[ ! -f package.json || ! -d src ]]; then
  echo "Run this script from the repository root." >&2
  exit 1
fi

export AZURE_EXTENSION_USE_DYNAMIC_INSTALL=no
az account set --subscription "$AZURE_SUBSCRIPTION"
az containerapp create --help >/dev/null
npm run build >/dev/null
# Validate both registries before changing anything.
node --input-type=module <<'JS'
import { readFileSync } from "node:fs";
import { parseDeviceHashes } from "./dist/src/device-auth.js";
parseDeviceHashes(readFileSync(process.env.GATEWAY_DEVICE_TOKENS_FILE, "utf8"));
if (process.env.GATEWAY_PUBLISHER_TOKENS_FILE) {
  parseDeviceHashes(readFileSync(process.env.GATEWAY_PUBLISHER_TOKENS_FILE, "utf8"), "GATEWAY_PUBLISHER_TOKENS");
}
JS

az group create --name "$AZURE_RESOURCE_GROUP" --location "$AZURE_LOCATION" --output none
for provider in Microsoft.App Microsoft.ManagedIdentity Microsoft.Storage; do
  az provider register --namespace "$provider" --wait --output none
done

# Storage: private, Entra-only (no account keys or SAS), reachable only through the gateway's identity.
if ! az storage account show --name "$STORAGE_ACCOUNT_NAME" --resource-group "$AZURE_RESOURCE_GROUP" --output none 2>/dev/null; then
  az storage account create --name "$STORAGE_ACCOUNT_NAME" --resource-group "$AZURE_RESOURCE_GROUP" \
    --location "$AZURE_LOCATION" --sku Standard_LRS --kind StorageV2 --https-only true --min-tls-version TLS1_2 \
    --allow-blob-public-access false --allow-shared-key-access false --output none
fi
az storage account update --name "$STORAGE_ACCOUNT_NAME" --resource-group "$AZURE_RESOURCE_GROUP" \
  --allow-blob-public-access false --allow-shared-key-access false --https-only true --min-tls-version TLS1_2 --output none
az storage container-rm create --storage-account "$STORAGE_ACCOUNT_NAME" --resource-group "$AZURE_RESOURCE_GROUP" \
  --name "$STORAGE_CONTAINER_NAME" --public-access off --output none
storage_id="$(az storage account show --name "$STORAGE_ACCOUNT_NAME" --resource-group "$AZURE_RESOURCE_GROUP" --query id --output tsv)"
storage_endpoint="$(az storage account show --name "$STORAGE_ACCOUNT_NAME" --resource-group "$AZURE_RESOURCE_GROUP" --query primaryEndpoints.blob --output tsv)"
export STORAGE_CONTAINER_URL="${storage_endpoint%/}/$STORAGE_CONTAINER_NAME"

az identity create --name "$GATEWAY_IDENTITY_NAME" --resource-group "$AZURE_RESOURCE_GROUP" --location "$AZURE_LOCATION" --output none
export IDENTITY_ID IDENTITY_CLIENT_ID
IDENTITY_ID="$(az identity show --name "$GATEWAY_IDENTITY_NAME" --resource-group "$AZURE_RESOURCE_GROUP" --query id --output tsv)"
IDENTITY_CLIENT_ID="$(az identity show --name "$GATEWAY_IDENTITY_NAME" --resource-group "$AZURE_RESOURCE_GROUP" --query clientId --output tsv)"
principal_id="$(az identity show --name "$GATEWAY_IDENTITY_NAME" --resource-group "$AZURE_RESOURCE_GROUP" --query principalId --output tsv)"
# Storage Blob Data Contributor, on this one container only.
container_scope="$storage_id/blobServices/default/containers/$STORAGE_CONTAINER_NAME"
role="ba92f5b4-2d11-453d-a403-e96b0029c9fe"
if [[ -z "$(az role assignment list --scope "$container_scope" --assignee "$principal_id" --role "$role" --query '[0].id' --output tsv)" ]]; then
  for attempt in 1 2 3 4 5 6; do
    # A new identity can take a minute to replicate before it can be assigned a role.
    az role assignment create --assignee-object-id "$principal_id" --assignee-principal-type ServicePrincipal \
      --role "$role" --scope "$container_scope" --output none && break
    sleep 10
  done
fi

if ! az containerapp env show --name "$GATEWAY_ENVIRONMENT_NAME" --resource-group "$AZURE_RESOURCE_GROUP" --output none 2>/dev/null; then
  az containerapp env create --name "$GATEWAY_ENVIRONMENT_NAME" --resource-group "$AZURE_RESOURCE_GROUP" \
    --location "$AZURE_LOCATION" --logs-destination none --output none
fi
export ENVIRONMENT_ID
ENVIRONMENT_ID="$(az containerapp env show --name "$GATEWAY_ENVIRONMENT_NAME" --resource-group "$AZURE_RESOURCE_GROUP" --query id --output tsv)"

umask 077
config_file="$(mktemp)"
trap 'rm -f "$config_file"' EXIT
node --input-type=module >"$config_file" <<'JS'
import { readFileSync } from "node:fs";
const env = process.env;
const read = (file) => (file ? JSON.stringify(JSON.parse(readFileSync(file, "utf8"))) : "{}");
console.log(JSON.stringify({
  location: env.AZURE_LOCATION,
  identity: { type: "UserAssigned", userAssignedIdentities: { [env.IDENTITY_ID]: {} } },
  properties: {
    environmentId: env.ENVIRONMENT_ID,
    configuration: {
      activeRevisionsMode: "Single",
      secrets: [
        { name: "device-hashes", value: read(env.GATEWAY_DEVICE_TOKENS_FILE) },
        { name: "publisher-hashes", value: read(env.GATEWAY_PUBLISHER_TOKENS_FILE) },
      ],
      ingress: { external: true, targetPort: 8080, transport: "http", allowInsecure: false, traffic: [{ latestRevision: true, weight: 100 }] },
    },
    template: {
      containers: [{
        name: "gateway",
        image: env.GATEWAY_IMAGE,
        resources: { cpu: 0.25, memory: "0.5Gi" },
        env: [
          { name: "STORAGE_CONTAINER_URL", value: env.STORAGE_CONTAINER_URL },
          { name: "AZURE_CLIENT_ID", value: env.IDENTITY_CLIENT_ID },
          { name: "GATEWAY_DEVICE_TOKENS", secretRef: "device-hashes" },
          { name: "GATEWAY_PUBLISHER_TOKENS", secretRef: "publisher-hashes" },
        ],
        probes: [
          { type: "Liveness", httpGet: { path: "/healthz", port: 8080 }, initialDelaySeconds: 10, periodSeconds: 30 },
          { type: "Readiness", httpGet: { path: "/healthz", port: 8080 }, initialDelaySeconds: 3, periodSeconds: 10 },
        ],
      }],
      scale: { minReplicas: 0, maxReplicas: 1, rules: [{ name: "http", http: { metadata: { concurrentRequests: "4" } } }] },
    },
  },
}));
JS
operation=create
if az containerapp show --name "$GATEWAY_NAME" --resource-group "$AZURE_RESOURCE_GROUP" --output none 2>/dev/null; then
  operation=update
fi
az containerapp "$operation" --name "$GATEWAY_NAME" --resource-group "$AZURE_RESOURCE_GROUP" --yaml "$config_file" --output none
fqdn="$(az containerapp show --name "$GATEWAY_NAME" --resource-group "$AZURE_RESOURCE_GROUP" --query properties.configuration.ingress.fqdn --output tsv)"
curl --fail --silent --show-error --retry 12 --retry-all-errors --retry-delay 5 --connect-timeout 10 --max-time 60 "https://$fqdn/healthz" >/dev/null
printf 'Gateway deployed: https://%s\n' "$fqdn"
