# Dashboard Screen Viewer

Shows dashboard screenshots full screen on a wall-mounted display, in filename order, and keeps them current without anyone touching the device. Built for an old Intel NUC, a Raspberry Pi or a Mac.

```text
                         publisher token                      managed identity
Screenshot machine ─────── PUT/DELETE ──────►  Gateway  ──────────────────────►  Private Blob container
                                               (Azure Container Apps)
Wall display  ◄──────────── GET ────────────
                         device token
```

There are three parts:

| Part | What it does | Runs on |
|---|---|---|
| **Gateway** | The only component that can reach storage. Lets displays list and download images, and lets publishers also upload and delete them. | Azure Container Apps |
| **Publisher** | `npm run publish` uploads a folder of screenshots through the gateway. | Whatever machine produces the screenshots |
| **Display** | Polls the gateway every 60 seconds, downloads only changed images, and shows them full screen. Keeps showing the last good set when offline, including after a restart. | Debian kiosk appliance (or any machine with Node.js and a browser) |

## How authentication works

**Clients → gateway: bearer tokens.** Each display and each publisher has its own token, a random 256-bit secret in the form `ID.SECRET` (for example `office-display.` followed by 43 base64url characters). The client reads it from a file before each request, so you can replace the file without restarting the client, and sends it over HTTPS:

```http
Authorization: Bearer office-display.0bE5...
```

The gateway never stores tokens, only a SHA-256 hash of each, in two lists:

- **Device tokens** (`GATEWAY_DEVICE_TOKENS`): may list and download images (`GET`). Writes are refused with `403`.
- **Publisher tokens** (`GATEWAY_PUBLISHER_TOKENS`): may also upload (`PUT`) and delete (`DELETE`) images.

On each request, the gateway looks up the token's ID, hashes the token, and compares it with the stored hash in constant time. A missing, malformed or unknown token gets `401`. Tokens don't expire. To revoke one, delete its entry from the list and redeploy (see [Operations](#operations)); other clients keep working. Tokens are only accepted in the `Authorization` header, never in URLs. Container Apps terminates HTTPS and refuses plain HTTP.

**Gateway → storage: managed identity.** The gateway gets short-lived Microsoft Entra tokens for its user-assigned managed identity automatically. That identity has **Storage Blob Data Contributor** on the one `screenshots` container and nothing else. Shared-key access is disabled on the storage account, so there are no account keys or SAS URLs to leak, rotate or expire.

## Quick start

The whole setup is scripted, so a person or an agent can repeat it from scratch. From the repository root, on an admin machine with the [tools below](#what-you-need):

```bash
# 1. Tokens: one per display, one per publisher
mkdir -p -m 700 ~/secure
npx tsx scripts/create-device.ts --device-id=office-display --token-file=$HOME/secure/office-display.token
npx tsx scripts/create-device.ts --device-id=screenshot-publisher --token-file=$HOME/secure/screenshot-publisher.token
cp ~/secure/office-display.token.registry.json ~/secure/displays.json
cp ~/secure/screenshot-publisher.token.registry.json ~/secure/publishers.json

# 2. Gateway image: publish a GitHub release (see "Releases"), or build and push it yourself,
#    then make the package public in its GitHub settings
docker build -f deploy/gateway.Dockerfile -t ghcr.io/OWNER/dashboard-screen-viewer-gateway:TAG .
docker push ghcr.io/OWNER/dashboard-screen-viewer-gateway:TAG

# 3. Azure resources (infra/main.bicep), printing the gateway URL
AZURE_SUBSCRIPTION="My subscription" AZURE_RESOURCE_GROUP=dashboard-viewer AZURE_LOCATION=westus2 \
STORAGE_ACCOUNT_NAME=uniquestoragename GATEWAY_IMAGE=ghcr.io/OWNER/dashboard-screen-viewer-gateway:TAG \
GATEWAY_DEVICE_TOKENS_FILE=$HOME/secure/displays.json GATEWAY_PUBLISHER_TOKENS_FILE=$HOME/secure/publishers.json \
  scripts/deploy-gateway.sh

# 4. Check it end to end (publishes sample dashboards, replacing what's there)
GATEWAY_URL=https://YOUR-GATEWAY DEVICE_TOKEN_FILE=$HOME/secure/office-display.token \
PUBLISHER_TOKEN_FILE=$HOME/secure/screenshot-publisher.token scripts/smoke-test.sh
```

Then set up the display ([step 5](#5-set-up-the-display)) and the publishing machine ([step 4](#4-publish-screenshots)). The sections below explain each step.

## What you need

**Tools on your admin machine:**

- Azure CLI with the `containerapp` extension (`az extension add --name containerapp`), signed in to a subscription where you can create resources and role assignments (Owner, or Contributor plus Role Based Access Control Administrator)
- Docker, and a container registry that Container Apps can pull from. The deploy script assumes a **public** image, for example on GitHub Container Registry. It holds only this repository's code.
- Node.js 20+ (for creating tokens and running the deploy script's checks)
- Bicep, which `scripts/deploy-gateway.sh` installs through the Azure CLI if it's missing
- For `scripts/smoke-test.sh`: curl, and Python 3 with Pillow (`pip install pillow`)

**Azure resources:** all defined in [`infra/main.bicep`](infra/main.bicep), which `scripts/deploy-gateway.sh` deploys into one resource group:

| Resource | Settings |
|---|---|
| Storage account (StorageV2, Standard LRS) | Shared-key access off, public blob access off, HTTPS only, TLS 1.2 minimum |
| Blob container `screenshots` | Private |
| User-assigned managed identity | **Storage Blob Data Contributor** on the `screenshots` container only |
| Container Apps environment | Consumption plan, logging off |
| Container App `dashboard-gateway` | Your gateway image, 0.25 vCPU, 0.5 GiB, 0–1 replicas, external HTTPS ingress on port 8080; token hashes stored as app secrets |

Expect roughly **$4–5 a month**. The display's polling keeps one small replica running at Azure's idle rate, after Container Apps' monthly free grant. Storage costs pennies.

**Devices:** a display (see [Set up the display](#5-set-up-the-display)) and a machine that produces screenshots, with Node.js 20+.

## Setup

### 1. Create tokens

Create one token per display and one per publishing machine:

```bash
mkdir -p -m 700 ~/secure
npx tsx scripts/create-device.ts --device-id=office-display --token-file=$HOME/secure/office-display.token
npx tsx scripts/create-device.ts --device-id=screenshot-publisher --token-file=$HOME/secure/screenshot-publisher.token
```

Each command writes the secret token (mode 600) and a `.registry.json` file holding only its hash. It never overwrites an existing file. IDs are lowercase letters, digits and hyphens.

Combine the hashes into two lists, one for displays and one for publishers. With one of each, just copy the files:

```bash
cp ~/secure/office-display.token.registry.json ~/secure/displays.json
cp ~/secure/screenshot-publisher.token.registry.json ~/secure/publishers.json
```

With several, merge them into a single JSON object, for example `{"office-display": "…", "lobby-display": "…"}`. Copy each token file only to the machine that uses it.

### 2. Build and publish the gateway image

Publishing a GitHub release builds and pushes the image for you (see [Releases](#releases)). To build it yourself:

```bash
docker build -f deploy/gateway.Dockerfile -t ghcr.io/OWNER/dashboard-screen-viewer-gateway:TAG .
docker push ghcr.io/OWNER/dashboard-screen-viewer-gateway:TAG
```

New GitHub Container Registry packages are private. Make the package public in its **Package settings**, or the gateway can't pull the image.

### 3. Deploy the gateway

```bash
AZURE_SUBSCRIPTION="My subscription" \
AZURE_RESOURCE_GROUP=dashboard-viewer \
AZURE_LOCATION=westus2 \
STORAGE_ACCOUNT_NAME=uniquestoragename \
GATEWAY_IMAGE=ghcr.io/OWNER/dashboard-screen-viewer-gateway:TAG \
GATEWAY_DEVICE_TOKENS_FILE=$HOME/secure/displays.json \
GATEWAY_PUBLISHER_TOKENS_FILE=$HOME/secure/publishers.json \
  scripts/deploy-gateway.sh
```

The script checks both token lists, then deploys `infra/main.bicep`. It passes the token hashes in a temporary private parameters file, so they never appear on a command line. It's idempotent: it creates whatever is missing and updates the rest. It finishes by checking the gateway's health and printing its URL, for example `https://dashboard-gateway.<random>.westus2.azurecontainerapps.io`. Use that URL as `GATEWAY_URL` below.

| Variable | Required | Meaning |
|---|---|---|
| `AZURE_SUBSCRIPTION` | yes | Subscription name or ID |
| `AZURE_RESOURCE_GROUP` | yes | Resource group to create or use |
| `AZURE_LOCATION` | yes | Region, for example `westus2` |
| `STORAGE_ACCOUNT_NAME` | yes | Globally unique, 3–24 lowercase letters and digits |
| `GATEWAY_IMAGE` | yes | The image you pushed |
| `GATEWAY_DEVICE_TOKENS_FILE` | yes | Display hash list (JSON) |
| `GATEWAY_PUBLISHER_TOKENS_FILE` | no | Publisher hash list (JSON). Without it, nothing can publish. |
| `STORAGE_CONTAINER_NAME` | no | Default `screenshots` |
| `GATEWAY_NAME` | no | Default `dashboard-gateway`. The environment and identity are named after it. |

A newly created role assignment can take a few minutes to apply. Until then, the gateway answers `503` and clients retry.

### 4. Publish screenshots

On the machine that produces the screenshots, with a copy of this repository and its publisher token:

```bash
npm install
export GATEWAY_URL=https://YOUR-GATEWAY
export PUBLISHER_TOKEN_FILE=$HOME/secure/screenshot-publisher.token
npm run publish -- --source-dir=/path/to/screenshots
```

This uploads the JPEG, PNG, GIF and WebP files in the folder root, replacing images with the same name. Subfolders, symlinks and other files are ignored. Images must be nonempty and at most 50 MiB. Run it after each capture, or on a schedule (for example cron). Capture to temporary names and rename into place, and don't run two publishers at once.

Remote images aren't deleted unless you add `--delete`, which removes images that are no longer in the folder, after all uploads succeed. It refuses to run on an empty folder, and it keeps an image if someone replaced it after the listing. Publishing a folder isn't a single transaction, so a display that polls mid-publish can briefly show a mix of old and new screenshots.

### 5. Set up the display

On a Debian 13 machine (an old NUC works well), copy this repository to a staging folder and run the installer once:

```bash
sudo bash scripts/setup-debian-kiosk.sh
```

Then install the display's token and point the viewer at the gateway:

```bash
sudo install -m 640 -o root -g dashboard office-display.token /etc/dashboard-viewer.token
printf 'GATEWAY_URL=https://YOUR-GATEWAY\nDEVICE_TOKEN_FILE=/etc/dashboard-viewer.token\n' | sudo tee /etc/dashboard-viewer.env >/dev/null
sudo chmod 600 /etc/dashboard-viewer.env
sudo systemctl restart dashboard-viewer
```

Within a minute, the placeholder screen ("Waiting for dashboards") changes to your screenshots. See [The display appliance](#the-display-appliance) for what the installer sets up, the on-screen status messages, Wi-Fi setup and lockdown.

## Verify end to end

`scripts/smoke-test.sh` runs these checks against a deployed gateway and stops at the first failure. It needs `GATEWAY_URL`, `DEVICE_TOKEN_FILE` and `PUBLISHER_TOKEN_FILE`. It publishes sample dashboards with `--delete`, replacing whatever was published. To check by hand:

1. **Gateway is up:** `curl https://YOUR-GATEWAY/healthz` prints `ok`.
2. **Tokens are checked:**

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' https://YOUR-GATEWAY/v1/images
   curl -s -H "Authorization: Bearer $(cat ~/secure/office-display.token)" https://YOUR-GATEWAY/v1/images
   ```

   The first command prints `401`. The second prints a JSON list of images (`[]` before anything is published).
3. **Publish samples:** generate test screenshots (requires Pillow: `pip install pillow`) and publish them:

   ```bash
   python3 scripts/make-sample-dashboards.py /tmp/sample-dashboards
   npm run publish -- --source-dir=/tmp/sample-dashboards --delete
   ```

4. **Display shows them:** within about a minute, the display shows "Sample 1: Build health" and the rest, each stamped with the time it was generated. On the appliance, `/var/lib/dashboard-viewer/slides.txt` lists the synced files, and `/var/lib/dashboard-viewer/status.txt` is empty when everything is healthy.

## Configuration reference

**Gateway** (set by `infra/main.bicep`; listed for reference):

| Env var | Meaning |
|---|---|
| `STORAGE_CONTAINER_URL` | `https://ACCOUNT.blob.core.windows.net/screenshots`, with no SAS |
| `AZURE_CLIENT_ID` | Client ID of the managed identity |
| `GATEWAY_DEVICE_TOKENS` | JSON `{"id": "sha256-hex", …}` of display tokens (app secret) |
| `GATEWAY_PUBLISHER_TOKENS` | Same format, for publishers (app secret) |
| `TOKEN_LISTS_VERSION` | Fingerprint of the token lists. It isn't read by the code; changing it forces a new revision. |
| `PORT` | Default 8080 |

**Publisher:**

| Env var | CLI flag | Meaning |
|---|---|---|
| `GATEWAY_URL` | `--gateway-url` | Gateway HTTPS URL |
| `PUBLISHER_TOKEN_FILE` | `--token-file` | Path to the publisher token |
| `SCREENSHOT_DIR` | `--source-dir` | Folder to publish |
| — | `--delete` | Also delete remote images missing from the folder |

**Display viewer** (`/etc/dashboard-viewer.env` on the appliance, or environment / `--key=value` flags elsewhere):

| Env var | CLI flag | Default | Meaning |
|---|---|---|---|
| `GATEWAY_URL` | `--gateway-url` | — | Gateway HTTPS URL |
| `DEVICE_TOKEN_FILE` | `--device-token-file` | — | Path to the device token |
| `BLOB_CONTAINER_URL` | `--blob-container-url` | — | Alternative to a gateway: read directly with a read/list container SAS URL |
| `ROTATION_SECONDS` | `--rotation-seconds` | 15 | Seconds per image in the browser slideshow |
| `POLL_SECONDS` | `--poll-seconds` | 60 | How often to check for changes (minimum 30) |
| `DATA_DIR` | `--data-dir` | `./data` | Cache folder (the appliance uses `/var/lib/dashboard-viewer`) |
| `PORT` | `--port` | 8080 | Local web page and status, on 127.0.0.1 only |

**Kiosk appliance** (`/etc/default/dashboard-kiosk`): `ROTATION_SECONDS` (default 15) sets the seconds per image on screen.

## Operations

- **Revoke a token:** remove its entry from `displays.json` or `publishers.json` and rerun `scripts/deploy-gateway.sh`. The deployment includes a fingerprint of the token lists, so any change starts a new revision. That matters because changing a Container Apps secret alone doesn't restart running replicas. Requests with the revoked token get `401` within about a minute.
- **Rotate a token:** create a new token with the same ID, replace its hash in the list, redeploy, then replace the token file on the device. Clients reread the file on every request.
- **Add a display or publisher:** create a token, add its hash to the right list and redeploy.
- **Update the gateway:** build and push a new image tag, then rerun the deploy script with that `GATEWAY_IMAGE`.
- **Tear down:** `az group delete --name dashboard-viewer` removes everything the script created.

## The display appliance

`scripts/setup-debian-kiosk.sh` (Debian 13, run once as root from a staging copy of the repository):

- creates a non-admin `dashboard` account that logs in automatically;
- installs the viewer to `/opt/dashboard-screen-viewer` as a restarting systemd service (`dashboard-viewer`), with its cache in `/var/lib/dashboard-viewer`;
- shows screenshots full screen with the lightweight `feh` image viewer (no browser), in filename order, without cropping;
- shows a placeholder until `/etc/dashboard-viewer.env` is configured.

Rerun it after updating the repository to reinstall.

**Status messages** appear as a text line over the image, while the cached screenshots keep showing:

- **Wi-Fi disconnected since ... - check the network:** the device has no working network connection (Wi-Fi or Ethernet). This takes priority over other messages. Devices without Wi-Fi show "Network disconnected ... - check the cable" instead.
- **No connection since ...:** the network is up, but the gateway can't be reached. The viewer retries with backoff, up to every five minutes.
- **Can't access download gateway - check the device credential:** the token is missing, malformed or revoked.

Each message clears automatically once the problem is fixed.

**Setting up Wi-Fi at a new location:** if the display has no network for 60 seconds, a full-screen Wi-Fi setup window opens over the slideshow. Plug in a USB keyboard and mouse, pick the network (or "Other (hidden) network…"), enter the password and choose **Connect**. The window closes once connected. The network is saved, so the display reconnects automatically after power cuts. Saved networks from earlier locations are kept, so the display joins whichever one is in range.

- Password-protected (WPA2/WPA3 personal) and open networks are supported. Enterprise sign-in (802.1X) and hotel-style login pages are not.
- A wrong password isn't saved; the window says so and lets you retry.
- **Close** dismisses the window. If the display is still offline, the window returns after 5 minutes.
- To open the window while online, for example to switch networks before a move, run `sudo touch /run/dashboard-wifi-setup` over SSH.
- Only the kiosk account can do this, and only Wi-Fi changes are allowed (`deploy/polkit/50-dashboard-wifi.rules`).
- With working Ethernet, the window doesn't appear.

**Lockdown:** the kiosk session is locked down so a keyboard or mouse can't leave it. All Openbox shortcuts and desktop menus are removed (`deploy/openbox/`), and `feh` has no menus or key and mouse bindings (`deploy/feh/`), so it can't be quit and images can't be deleted. These configs are root-owned. Don't install a terminal or browser on the appliance. Text consoles (Ctrl+Alt+F1–F6) still require a password, and anyone who can reboot the device can still change how it boots unless you set firmware and GRUB passwords.

### Other platforms

The viewer runs anywhere with Node.js 20+ and serves a fading slideshow on `http://127.0.0.1:8080`:

```bash
npm install
GATEWAY_URL=https://YOUR-GATEWAY DEVICE_TOKEN_FILE=/secure/display.token npm start
```

`scripts/kiosk.sh [port]` opens Chromium (Linux) or Chrome (macOS) full screen on that page. For autostart, adapt `deploy/dashboard.service` (systemd) or `deploy/macos-launchagent.plist` (macOS), keeping the token and settings readable only by the service account.

## Releases

GitHub Actions run two workflows:

- **CI** (`.github/workflows/ci.yml`) runs on every push to `main` and every pull request. It builds the TypeScript, runs the tests, checks the shell scripts with ShellCheck, compile-checks the Python scripts, builds and lints the Bicep template, and test-builds the gateway image.
- **Release** (`.github/workflows/release.yml`) runs when a GitHub release is published. It runs CI first, then pushes the gateway image to `ghcr.io/OWNER/dashboard-screen-viewer-gateway`, tagged with the release version (`X.Y.Z`), `X.Y`, the commit's short SHA, and `latest` (`latest` only if the release isn't a prerelease).

To cut a release, publish one with a semantic version tag:

```bash
gh release create v1.2.3 --generate-notes
```

Then roll the new image out with `GATEWAY_IMAGE=ghcr.io/OWNER/dashboard-screen-viewer-gateway:1.2.3 scripts/deploy-gateway.sh`. Pin a version rather than `latest`, so a redeploy doesn't change the image unexpectedly.

The workflow pushes with the repository's built-in `GITHUB_TOKEN`. If the image package was first pushed from somewhere else, it isn't connected to the repository yet: in the package's **Package settings**, under **Manage Actions access**, add this repository with the **Write** role. A package created by the workflow is connected automatically, but starts out private, so make it public once so Container Apps can pull it.

## Development

`npm test` runs unit and local HTTP protocol tests, including a full publish → gateway → Blob → display round trip against local fakes (no Azure credentials needed). `npm run build` checks TypeScript and emits into `dist/`.
