#!/usr/bin/env python3
"""On-screen Wi-Fi setup for the dashboard kiosk.

Shown by nuc-kiosk.sh when the display has been offline for a while. Talks to NetworkManager
directly (no terminal, no shell), saves the chosen network as a system profile that reconnects
automatically, and exits 0 once connected or 1 if closed.
"""
import sys

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("NM", "1.0")
from gi.repository import GLib, Gdk, Gtk, NM  # noqa: E402

AP_FLAGS = getattr(NM, "80211ApFlags")
AP_SEC = getattr(NM, "80211ApSecurityFlags")
CONNECT_TIMEOUT_S = 45
OTHER = object()

CSS = b"""
window { background: #101820; }
label { color: #eef4fa; font-size: 22px; }
.title { font-size: 44px; font-weight: bold; }
.subtitle { color: #bdcbd8; }
.status { color: #66d9a8; }
.error { color: #ff8a80; }
list { background: #1b2733; }
list row { padding: 12px 16px; }
list row:selected { background: #2e5b8a; }
entry { font-size: 24px; min-height: 48px; }
button { font-size: 22px; padding: 8px 28px; background-image: none; background-color: #2b3a4a; border: 1px solid #45586b; }
button label { color: #ffffff; }
button:disabled { background-color: #1b2733; }
button:disabled label { color: #6f8091; }
button.suggested-action { background-color: #1f7a55; border-color: #2a9d6e; }
checkbutton label { font-size: 20px; }
"""


def ssid_of(ap):
    raw = ap.get_ssid()
    data = raw.get_data() if raw is not None else None
    return NM.utils_ssid_to_utf8(data) if data else None


def security_of(ap):
    """(kind, key_mgmt) where kind is open, secured, enterprise or unsupported."""
    wpa, rsn = ap.get_wpa_flags(), ap.get_rsn_flags()
    sec = wpa | rsn
    if sec & AP_SEC.KEY_MGMT_802_1X:
        return "enterprise", None
    if sec & AP_SEC.KEY_MGMT_PSK:
        return "secured", "wpa-psk"
    if rsn & AP_SEC.KEY_MGMT_SAE:
        return "secured", "sae"
    if rsn & AP_SEC.KEY_MGMT_OWE:
        return "open", "owe"
    if ap.get_flags() & AP_FLAGS.PRIVACY:
        return "unsupported", None
    return "open", None


def valid_psk(password):
    if 8 <= len(password) <= 63:
        return True
    return len(password) == 64 and all(c in "0123456789abcdefABCDEF" for c in password)


class WifiSetup:
    def __init__(self):
        self.result = 1
        self.client = NM.Client.new(None)
        self.device = next((d for d in self.client.get_devices() if d.get_device_type() == NM.DeviceType.WIFI), None)
        self.networks = {}
        self.busy = False
        self.pending = None

        provider = Gtk.CssProvider()
        provider.load_from_data(CSS)
        Gtk.StyleContext.add_provider_for_screen(Gdk.Screen.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)

        self.window = Gtk.Window(title="Wi-Fi setup")
        self.window.set_decorated(False)
        self.window.set_keep_above(True)
        self.window.connect("delete-event", lambda *_: True)

        outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=18, margin=80)
        self.window.add(outer)
        title = Gtk.Label(label="Wi-Fi setup", xalign=0)
        title.get_style_context().add_class("title")
        subtitle = Gtk.Label(xalign=0, wrap=True, label=(
            "This display can't reach a network. Choose the Wi-Fi network for this location and "
            "enter its password. It will reconnect automatically from now on."))
        subtitle.get_style_context().add_class("subtitle")
        outer.pack_start(title, False, False, 0)
        outer.pack_start(subtitle, False, False, 0)

        self.listbox = Gtk.ListBox()
        self.listbox.set_selection_mode(Gtk.SelectionMode.SINGLE)
        self.listbox.connect("row-selected", self.on_selected)
        scroller = Gtk.ScrolledWindow(hscrollbar_policy=Gtk.PolicyType.NEVER)
        scroller.add(self.listbox)
        outer.pack_start(scroller, True, True, 0)

        form = Gtk.Grid(column_spacing=16, row_spacing=12)
        self.ssid_label = Gtk.Label(label="Network name", xalign=0)
        self.ssid_entry = Gtk.Entry(hexpand=True, max_length=32)
        self.password_entry = Gtk.Entry(hexpand=True, visibility=False, max_length=64)
        self.password_entry.set_input_purpose(Gtk.InputPurpose.PASSWORD)
        self.password_entry.connect("activate", lambda *_: self.on_connect())
        self.ssid_entry.connect("activate", lambda *_: self.password_entry.grab_focus())
        show = Gtk.CheckButton(label="Show password")
        show.connect("toggled", lambda b: self.password_entry.set_visibility(b.get_active()))
        form.attach(self.ssid_label, 0, 0, 1, 1)
        form.attach(self.ssid_entry, 1, 0, 1, 1)
        form.attach(Gtk.Label(label="Password", xalign=0), 0, 1, 1, 1)
        form.attach(self.password_entry, 1, 1, 1, 1)
        form.attach(show, 1, 2, 1, 1)
        outer.pack_start(form, False, False, 0)

        self.status = Gtk.Label(xalign=0, wrap=True)
        outer.pack_start(self.status, False, False, 0)

        buttons = Gtk.Box(spacing=16)
        self.close_button = Gtk.Button(label="Close")
        self.close_button.connect("clicked", lambda *_: self.quit(1))
        self.rescan_button = Gtk.Button(label="Rescan")
        self.rescan_button.connect("clicked", lambda *_: self.scan())
        self.connect_button = Gtk.Button(label="Connect")
        self.connect_button.get_style_context().add_class("suggested-action")
        self.connect_button.connect("clicked", lambda *_: self.on_connect())
        buttons.pack_start(self.close_button, False, False, 0)
        buttons.pack_end(self.connect_button, False, False, 0)
        buttons.pack_end(self.rescan_button, False, False, 0)
        outer.pack_start(buttons, False, False, 0)

        self.window.show_all()
        self.window.fullscreen()
        self.show_form(None)

        if self.device is None:
            self.set_status("No Wi-Fi adapter found. Connect a network cable or a Wi-Fi adapter.", error=True)
            for widget in (self.rescan_button, self.connect_button):
                widget.set_sensitive(False)
            return
        self.device.connect("access-point-added", lambda *_: self.refresh())
        self.device.connect("access-point-removed", lambda *_: self.refresh())
        self.refresh()
        self.scan()
        GLib.timeout_add_seconds(15, self.periodic)

    def set_status(self, text, error=False):
        self.status.set_text(text)
        context = self.status.get_style_context()
        context.remove_class("error" if not error else "status")
        context.add_class("error" if error else "status")

    def periodic(self):
        if not self.busy:
            self.refresh()
        return True

    def scan(self):
        self.set_status("Searching for networks…")

        def done(device, result):
            try:
                device.request_scan_finish(result)
            except GLib.Error:
                pass  # NetworkManager rate-limits scans; the current results stay valid.
            self.refresh()
            if not self.busy:
                self.set_status("Select a network." if self.networks else "No networks found yet. Try Rescan.")

        self.device.request_scan_async(None, done)

    def refresh(self):
        best = {}
        for ap in self.device.get_access_points():
            ssid = ssid_of(ap)
            if ssid and (ssid not in best or ap.get_strength() > best[ssid].get_strength()):
                best[ssid] = ap
        selected = self.selected_key()
        self.networks = best
        for row in self.listbox.get_children():
            self.listbox.remove(row)
        ordered = sorted(best.items(), key=lambda item: -item[1].get_strength())
        for ssid, ap in ordered:
            kind, _ = security_of(ap)
            note = {"open": "Open", "secured": "Secured", "enterprise": "Enterprise (not supported)",
                    "unsupported": "WEP (not supported)"}[kind]
            self.add_row(ssid, f"{ssid}    —    {note}, signal {ap.get_strength()}%")
        self.add_row(OTHER, "Other (hidden) network…")
        self.listbox.show_all()
        for row in self.listbox.get_children():
            if row.key == selected:
                self.listbox.select_row(row)

    def add_row(self, key, text):
        row = Gtk.ListBoxRow()
        row.key = key
        row.add(Gtk.Label(label=text, xalign=0))
        self.listbox.add(row)

    def selected_key(self):
        row = self.listbox.get_selected_row()
        return row.key if row is not None else None

    def on_selected(self, _listbox, row):
        self.show_form(row.key if row is not None else None)

    def show_form(self, key):
        hidden = key is OTHER
        self.ssid_label.set_visible(hidden)
        self.ssid_entry.set_visible(hidden)
        needs_password = hidden or (key in self.networks and security_of(self.networks[key])[0] == "secured")
        self.password_entry.set_sensitive(needs_password)
        if hidden:
            self.ssid_entry.grab_focus()
        elif needs_password:
            self.password_entry.grab_focus()

    def on_connect(self):
        if self.busy or self.device is None:
            return
        key = self.selected_key()
        if key is None:
            self.set_status("Select a network first.", error=True)
            return
        password = self.password_entry.get_text()
        ap = None
        if key is OTHER:
            ssid = self.ssid_entry.get_text().strip()
            if not ssid:
                self.set_status("Enter the network name.", error=True)
                return
            key_mgmt = "wpa-psk" if password else None
        else:
            ssid, ap = key, self.networks.get(key)
            if ap is None:
                self.set_status("That network is no longer visible. Try Rescan.", error=True)
                return
            kind, key_mgmt = security_of(ap)
            if kind in ("enterprise", "unsupported"):
                self.set_status("This network type isn't supported. Choose a password-protected (WPA) or open network.", error=True)
                return
        if key_mgmt in ("wpa-psk", "sae") and not valid_psk(password):
            self.set_status("Wi-Fi passwords are 8 to 63 characters.", error=True)
            return

        connection = NM.SimpleConnection.new()
        s_con = NM.SettingConnection.new()
        s_con.set_property(NM.SETTING_CONNECTION_ID, ssid)
        s_con.set_property(NM.SETTING_CONNECTION_UUID, NM.utils_uuid_generate())
        s_con.set_property(NM.SETTING_CONNECTION_TYPE, "802-11-wireless")
        s_con.set_property(NM.SETTING_CONNECTION_AUTOCONNECT, True)
        connection.add_setting(s_con)
        s_wifi = NM.SettingWireless.new()
        s_wifi.set_property(NM.SETTING_WIRELESS_SSID, GLib.Bytes.new(ssid.encode("utf-8")))
        s_wifi.set_property(NM.SETTING_WIRELESS_MODE, "infrastructure")
        s_wifi.set_property(NM.SETTING_WIRELESS_HIDDEN, key is OTHER)
        connection.add_setting(s_wifi)
        if key_mgmt:
            s_sec = NM.SettingWirelessSecurity.new()
            s_sec.set_property(NM.SETTING_WIRELESS_SECURITY_KEY_MGMT, key_mgmt)
            if key_mgmt != "owe":
                s_sec.set_property(NM.SETTING_WIRELESS_SECURITY_PSK, password)
            connection.add_setting(s_sec)

        self.set_busy(True)
        self.set_status(f"Connecting to {ssid}…")
        specific = ap.get_path() if ap is not None else None
        self.client.add_and_activate_connection_async(connection, self.device, specific, None, self.on_added, ssid)

    def set_busy(self, busy):
        self.busy = busy
        for widget in (self.connect_button, self.rescan_button, self.listbox, self.password_entry, self.ssid_entry):
            widget.set_sensitive(not busy)
        if not busy:
            self.show_form(self.selected_key())

    def on_added(self, client, result, ssid):
        try:
            active = client.add_and_activate_connection_finish(result)
        except GLib.Error:
            self.fail("Couldn't start the connection. Check that this display may manage Wi-Fi.")
            return
        self.pending = (active, active.get_connection(), ssid)
        active.connect("notify::state", lambda *_: self.check_state())
        GLib.timeout_add_seconds(CONNECT_TIMEOUT_S, self.on_timeout, active)
        self.check_state()

    def check_state(self):
        if self.pending is None:
            return
        active, remote, ssid = self.pending
        state = active.get_state()
        if state == NM.ActiveConnectionState.ACTIVATED:
            self.pending = None
            self.remove_older_profiles(ssid, remote)
            self.set_status(f"Connected to {ssid}. Returning to the dashboard…")
            GLib.timeout_add_seconds(3, lambda: self.quit(0))
        elif state in (NM.ActiveConnectionState.DEACTIVATING, NM.ActiveConnectionState.DEACTIVATED):
            reason = active.get_state_reason()
            wrong_password = reason in (NM.ActiveConnectionStateReason.NO_SECRETS, NM.ActiveConnectionStateReason.LOGIN_FAILED)
            self.discard(remote)
            self.fail("Couldn't connect — check the password." if wrong_password else "Couldn't connect to that network. Try again or choose another.")

    def on_timeout(self, active):
        if self.pending is not None and self.pending[0] is active:
            remote = self.pending[1]
            self.client.deactivate_connection_async(active, None, None)
            self.discard(remote)
            self.fail("Connecting took too long. Check the password and signal, then try again.")
        return False

    def discard(self, remote):
        # Don't keep a profile with a wrong password: it would keep failing to autoconnect.
        self.pending = None
        if remote is not None:
            remote.delete_async(None, None)

    def remove_older_profiles(self, ssid, keep):
        keep_uuid = keep.get_uuid() if keep is not None else None
        for connection in self.client.get_connections():
            wireless = connection.get_setting_wireless()
            if connection.get_uuid() == keep_uuid or wireless is None or wireless.get_ssid() is None:
                continue
            if NM.utils_ssid_to_utf8(wireless.get_ssid().get_data()) == ssid:
                connection.delete_async(None, None)

    def fail(self, message):
        self.set_busy(False)
        self.set_status(message, error=True)

    def quit(self, code):
        self.result = code
        Gtk.main_quit()
        return False


def main():
    app = WifiSetup()
    Gtk.main()
    return app.result


if __name__ == "__main__":
    sys.exit(main())
