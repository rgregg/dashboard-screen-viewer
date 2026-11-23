# Dashboard Screen Viewer

Shows dashboard screenshots full screen on a wall-mounted display, in filename order, and keeps them current without anyone touching the device. Built for an old Intel NUC, a Raspberry Pi or a Mac.

```text
Screenshot machine ──(publisher token)──► Gateway ──(managed identity)──► Private Blob container
Wall display ◄─────(device token)──────── Gateway
```

- **Gateway** (Azure Container Apps): the only thing that can reach storage, using its managed identity. Displays may list and download images; publishers may also upload and delete. The storage account has shared-key access turned off, so there are no account keys or SAS URLs to leak or expire.
- **Tokens**: each display and publisher gets its own long-lived token, stored only as a SHA-256 hash in the gateway. Revoke one by removing its hash and redeploying; the others keep working.
- **Display**: polls the gateway every 60 seconds, downloads only changed images, and swaps the new set in atomically. If the network or gateway is down, the last good images keep showing, including after a restart, with a status line explaining the problem.

## 1. Create tokens

Create one token per display and one for each machine that publishes screenshots:

```bash
npx tsx scripts/create-device.ts --device-id=office-display --token-file=$HOME/secure/office-display.token
npx tsx scripts/create-device.ts --device-id=screenshot-publisher --token-file=$HOME/secure/screenshot-publisher.token
```

Each command writes the secret token (mode 600) and a `.registry.json` file holding only its hash. Never overwrite an existing file. Merge the display hashes into one JSON file (for example `displays.json`) and the publisher hashes into another (`publishers.json`); the gateway deployment reads these. Copy each token file only to the machine that uses it.

## 2. Deploy the gateway

Build the gateway image and push it somewhere Container Apps can pull from, such as a public GitHub Container Registry image. The image contains no secrets.

```bash
docker build -f deploy/gateway.Dockerfile -t ghcr.io/OWNER/dashboard-screen-viewer-gateway:TAG .
docker push ghcr.io/OWNER/dashboard-screen-viewer-gateway:TAG
```

Then provision or update everything with one idempotent script (requires the Azure CLI with the `containerapp` extension, signed in with rights to create resources and role assignments):

```bash
AZURE_SUBSCRIPTION="My subscription" AZURE_RESOURCE_GROUP=dashboard-viewer AZURE_LOCATION=westus2 \
STORAGE_ACCOUNT_NAME=uniquestoragename GATEWAY_IMAGE=ghcr.io/OWNER/dashboard-screen-viewer-gateway:TAG \
GATEWAY_DEVICE_TOKENS_FILE=displays.json GATEWAY_PUBLISHER_TOKENS_FILE=publishers.json \
  scripts/deploy-gateway.sh
```

It creates a private storage container (shared-key and public access disabled), a managed identity limited to that container, and a Container Apps consumption environment and app (0.25 vCPU, 0.5 GiB, logs off), then prints the gateway URL. Rerun it to add or revoke tokens, or to roll out a new image. Expect roughly $4–5 a month: the display's polling keeps one small replica running at Azure's idle rate, and storage costs pennies.

## 3. Publish screenshots

On the machine that produces the screenshots (Node.js 20+):

```bash
npm install
export GATEWAY_URL=https://YOUR-GATEWAY PUBLISHER_TOKEN_FILE=$HOME/secure/screenshot-publisher.token
npm run publish -- --source-dir=/path/to/screenshots
```

This uploads (replacing) the JPEG, PNG, GIF and WebP files in the folder root. Subfolders, symlinks and other files are ignored; images must be nonempty and at most 50 MiB. Run it after each capture, or on a schedule. Capture to temporary names and rename into place, and don't run two publishers at once.

Remote images aren't deleted unless you add `--delete`, which removes images missing from the folder after all uploads succeed. It refuses to run on an empty folder, and it keeps an image that someone replaced since the listing. Publishing a folder isn't a single transaction, so a display polling mid-publish can briefly show a mix of old and new screenshots.

## 4. Set up the display

### Debian 13 appliance (recommended)

Copy the repository to a staging folder on the device and run `sudo bash scripts/setup-debian-kiosk.sh` once. It:

- creates a non-admin `dashboard` account that logs in automatically;
- installs the viewer to `/opt/dashboard-screen-viewer` as a restarting systemd service, with its cache in `/var/lib/dashboard-viewer`;
- shows screenshots full screen with the lightweight `feh` image viewer (no browser), in filename order, without cropping.

To start syncing, install the display's token and point the viewer at the gateway:

```bash
sudo install -m 640 -o root -g dashboard office-display.token /etc/dashboard-viewer.token
printf 'GATEWAY_URL=https://YOUR-GATEWAY\nDEVICE_TOKEN_FILE=/etc/dashboard-viewer.token\n' | sudo tee /etc/dashboard-viewer.env >/dev/null
sudo chmod 600 /etc/dashboard-viewer.env
sudo systemctl restart dashboard-viewer
```

Until then, a placeholder image appears. Set the seconds per image in `/etc/default/dashboard-kiosk` (`ROTATION_SECONDS`, default 15).

Problems appear as a text line over the image while cached screenshots keep showing:

- **Wi-Fi disconnected since ... - check the network:** the device has no working network connection (Wi-Fi or Ethernet). This takes priority over other messages. Devices without Wi-Fi show "Network disconnected ... - check the cable" instead.
- **No connection since ...:** the network is up but the gateway can't be reached. The viewer retries with backoff, up to every five minutes.
- **Can't access download gateway - check the device credential:** the token is missing, malformed or revoked.

The message clears automatically once things recover.

**Setting up Wi-Fi at a new location:** if the display has no network for 60 seconds, a full-screen Wi-Fi setup window opens over the slideshow. Plug in a USB keyboard and mouse, pick the network (or "Other (hidden) network…"), enter the password and choose **Connect**. The window closes once connected, and the network is saved, so the display reconnects automatically after power cuts. Saved networks from earlier locations are kept, so the display joins whichever one is in range.

- Password-protected (WPA2/WPA3 personal) and open networks are supported. Enterprise sign-in (802.1X) and hotel-style login pages are not.
- A wrong password isn't saved; the window says so and lets you retry.
- **Close** dismisses the window. If the display is still offline, the window returns after 5 minutes.
- To open the window while online, for example to switch networks before a move, run `sudo touch /run/dashboard-wifi-setup` over SSH.
- Only the kiosk account can do this, and only Wi-Fi changes are allowed (`deploy/polkit/50-dashboard-wifi.rules`).

The kiosk session is locked down so a keyboard or mouse can't leave it. All Openbox shortcuts and desktop menus are removed (`deploy/openbox/`), and `feh` has no menus or key and mouse bindings (`deploy/feh/`), so it can't be quit and images can't be deleted. These configs are root-owned. Don't install a terminal or browser on the appliance. Text consoles (Ctrl+Alt+F1–F6) still require a password, and anyone who can reboot the device can still change how it boots unless you set firmware and GRUB passwords.

### Other platforms

The viewer can also run anywhere with Node.js 20+ and show a fading slideshow in a kiosk browser:

| Setting | Env var | CLI flag (`--key=value`) | Default |
|---|---|---|---|
| Gateway URL | `GATEWAY_URL` | `--gateway-url` | required (or a SAS URL below) |
| Device token file | `DEVICE_TOKEN_FILE` | `--device-token-file` | required with a gateway |
| Read/list container SAS URL, instead of a gateway | `BLOB_CONTAINER_URL` | `--blob-container-url` | — |
| Seconds per image | `ROTATION_SECONDS` | `--rotation-seconds` | 15 |
| Poll interval (seconds, min 30) | `POLL_SECONDS` | `--poll-seconds` | 60 |
| Data directory | `DATA_DIR` | `--data-dir` | `./data` |
| Port | `PORT` | `--port` | 8080 |

```bash
npm install
GATEWAY_URL=https://YOUR-GATEWAY DEVICE_TOKEN_FILE=/secure/display.token npm start
```

`scripts/kiosk.sh [port]` opens Chromium (Linux) or Chrome (macOS) full screen on the viewer's local page (`http://127.0.0.1:8080`). For autostart, adapt `deploy/dashboard.service` (systemd) or `deploy/macos-launchagent.plist` (macOS), keeping the token and settings readable only by the service account.

## Development

`npm test` runs unit and local HTTP protocol tests, including a full publish → gateway → Blob → display round trip against local fakes (no Azure credentials needed). `npm run build` checks TypeScript and emits into `dist/`.
