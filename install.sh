#!/usr/bin/env bash
set -euo pipefail

PLUGIN_NAME="GSE-Watcher-Decky"
DEST="$HOME/homebrew/plugins/$PLUGIN_NAME"
REPO_URL="${REPO_URL:-https://github.com/Ke619/GSE-Watcher-Decky}"
BRANCH="${BRANCH:-main}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "==> $PLUGIN_NAME installer"
echo "    Source: $REPO_URL ($BRANCH)"
echo "    Target: $DEST"

# --- Decky Loader check -----------------------------------------------------
decky_found=0
if [ -d "$HOME/homebrew/plugins" ] || systemctl list-unit-files 2>/dev/null | grep -q '^plugin_loader'; then
    decky_found=1
fi

if [ "$decky_found" -eq 0 ]; then
    echo "Decky Loader was not detected on this system."
    read -r -p "Install Decky Loader now? [y/N] " answer
    case "$answer" in
        [yY]*)
            echo "==> Installing Decky Loader..."
            curl -L https://github.com/SteamDeckHomebrew/decky-installer/releases/latest/download/install_release.sh | sh
            ;;
        *)
            echo "Aborting: Decky Loader is required for $PLUGIN_NAME."
            exit 1
            ;;
    esac
fi

# --- Download plugin --------------------------------------------------------
echo "==> Downloading $PLUGIN_NAME"
curl -L "$REPO_URL/archive/refs/heads/$BRANCH.tar.gz" -o "$TMP/plugin.tar.gz"
if ! tar -tzf "$TMP/plugin.tar.gz" >/dev/null 2>&1; then
    echo "Error: downloaded file is not a valid tarball."
    echo "Is the repository public? Private repos require authentication."
    exit 1
fi

tar -xzf "$TMP/plugin.tar.gz" -C "$TMP"
SRC="$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -1)"

# --- Build frontend if dist/ is not shipped ----------------------------------
if [ ! -d "$SRC/dist" ]; then
    echo "==> Building frontend (dist/ not present in source)"
    if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
        echo "Error: node and npm are required to build the plugin frontend."
        echo "Install Node.js on this machine, or ship a release with a prebuilt dist/."
        exit 1
    fi
    (cd "$SRC" && npm ci && npm run build)
fi

# --- Install plugin ----------------------------------------------------------
echo "==> Copying plugin to $DEST"
mkdir -p "$HOME/homebrew"
sudo mkdir -p "$HOME/homebrew/plugins"
sudo rm -rf "$DEST"
sudo mkdir -p "$DEST"
# node_modules is only needed for building, not for running under Decky
sudo cp -r "$SRC"/main.py "$SRC"/dist "$SRC"/plugin.json "$SRC"/package.json "$DEST"/

# --- Restart plugin loader ---------------------------------------------------
#echo "==> Restarting plugin_loader"
#sudo systemctl restart plugin_loader

echo "==> Done. $PLUGIN_NAME installed at $DEST"
