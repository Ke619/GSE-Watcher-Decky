"""
GSE Watcher - Decky Plugin Backend

Monitors Proton game achievements and triggers Steam notifications via SAM.
Ported from the GSE_WATCHER bash script to Python for the Decky plugin system.

Uses inotify_simple (bundled in defaults/) for file watching — no external
binary required.
"""

import asyncio
import json
import os
import sys
from typing import Optional

import decky
from settings import SettingsManager

# Add defaults/ to import path so inotify_simple is found
_defaults_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "defaults")
if _defaults_dir not in sys.path:
    sys.path.insert(0, _defaults_dir)

from inotify_simple import INotify, flags  # noqa: E402


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

COMPATDATA_DIR = os.path.expanduser(
    "~/.steam/steam/steamapps/compatdata"
)
ACHIEVEMENTS_SUBPATH = (
    "pfx/drive_c/users/steamuser/AppData/Roaming/GSE Saves"
)


def get_achievements_path(appid: str) -> str:
    """Return the full path to achievements.json for *appid*."""
    return os.path.join(
        COMPATDATA_DIR, appid, ACHIEVEMENTS_SUBPATH, appid, "achievements.json"
    )


def ensure_achievements_file(path: str) -> None:
    """Create the achievements directory and file if they don't exist."""
    dirpath = os.path.dirname(path)
    os.makedirs(dirpath, exist_ok=True)
    if not os.path.exists(path):
        with open(path, "w", encoding="utf-8") as fh:
            json.dump({}, fh)


def parse_earned_achievements(path: str) -> list[str]:
    """Read achievements.json and return list of earned achievement IDs."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (json.JSONDecodeError, OSError):
        return []

    earned: list[str] = []
    if isinstance(data, dict):
        for key, value in data.items():
            if isinstance(value, dict) and value.get("earned") is True:
                earned.append(key)
    return earned


# ---------------------------------------------------------------------------
# SAM integration
# ---------------------------------------------------------------------------

def get_sam_path() -> str:
    """Return the path to the samrewritten-cli binary.

    Checks in order:
    1. Plugin's bin/ directory (bundled)
    2. Legacy GSE_WATCHER location
    3. PATH fallback
    """
    plugin_bin = os.path.join(decky.DECKY_PLUGIN_DIR, "bin", "samrewritten-cli")
    if os.path.isfile(plugin_bin) and os.access(plugin_bin, os.X_OK):
        return plugin_bin

    # Check for AppImage variant
    plugin_bin_appimage = os.path.join(
        decky.DECKY_PLUGIN_DIR, "bin", "samrewritten-cli.appimage"
    )
    if os.path.isfile(plugin_bin_appimage):
        # Ensure execute permission (zip extraction may strip it)
        if not os.access(plugin_bin_appimage, os.X_OK):
            try:
                os.chmod(plugin_bin_appimage, 0o755)
                decky.logger.info("Fixed execute permission on SAM AppImage")
            except OSError as e:
                decky.logger.warning(f"Could not chmod SAM AppImage: {e}")
        if os.access(plugin_bin_appimage, os.X_OK):
            return plugin_bin_appimage

    # Legacy location
    legacy = os.path.expanduser(
        "~/.cr0wbar/Runtime/Programs/GSE_WATCHER/bin/samrewritten-cli.appimage"
    )
    if os.path.isfile(legacy) and os.access(legacy, os.X_OK):
        return legacy

    # Fallback to PATH
    return "samrewritten-cli"


async def unlock_achievement(appid: str, achievement_id: str) -> bool:
    """Call SAM to trigger the achievement notification in Steam."""
    sam = get_sam_path()
    proc = None
    try:
        proc = await asyncio.create_subprocess_exec(
            sam, "unlock", appid, achievement_id,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.wait_for(proc.communicate(), timeout=10.0)
        return proc.returncode == 0
    except asyncio.TimeoutError:
        if proc:
            proc.kill()
            await proc.wait()
        decky.logger.warning(f"SAM timed out for achievement {achievement_id}")
        return False
    except asyncio.CancelledError:
        if proc:
            proc.kill()
            await proc.wait()
        raise
    except Exception as e:
        decky.logger.error(f"Error unlocking achievement {achievement_id}: {e}")
        return False


# ---------------------------------------------------------------------------
# Achievement processing (shared between watchers)
# ---------------------------------------------------------------------------

async def process_new_achievements(
    appid: str,
    ach_path: str,
    already_earned: set[str],
) -> None:
    """Read achievements.json, find new earned ones, notify via SAM."""
    earned = parse_earned_achievements(ach_path)
    new_achievements = [a for a in earned if a not in already_earned]

    for ach_id in new_achievements:
        already_earned.add(ach_id)
        decky.logger.info(f"Achievement earned: {ach_id}")

        success = await unlock_achievement(appid, ach_id)

        await decky.emit(
            "achievement_unlocked",
            ach_id,
            appid,
            success,
        )


# ---------------------------------------------------------------------------
# inotify-based file watcher (using inotify_simple — pure Python)
# ---------------------------------------------------------------------------

async def watch_achievements(
    appid: str,
    ach_path: str,
    stop_event: asyncio.Event,
    already_earned: set[str],
) -> None:
    """Watch *ach_path* for modifications using inotify (pure Python).

    Uses inotify_simple (bundled in defaults/) which calls the Linux
    kernel's inotify syscall via ctypes — no external binary needed.
    """
    inotify: Optional[INotify] = None
    try:
        inotify = INotify()
        watch_flags = flags.CLOSE_WRITE | flags.DELETE_SELF
        assert inotify is not None  # for type checker
        wd = inotify.add_watch(ach_path, watch_flags)

        # Run blocking inotify.read() in a thread pool to keep it async
        loop = asyncio.get_running_loop()

        while not stop_event.is_set():
            # Poll with timeout — read returns after ~1s or on event
            try:
                events = await asyncio.wait_for(
                    loop.run_in_executor(None, lambda: inotify.read(timeout=1000)),  # type: ignore[union-attr]
                    timeout=2.0,
                )
            except asyncio.TimeoutError:
                continue
            except asyncio.CancelledError:
                break

            if not events:
                continue

            for event in events:
                if event.wd != wd:
                    continue
                if event.mask & flags.DELETE_SELF:
                    # File was deleted — stop watching
                    decky.logger.info("achievements.json deleted, stopping watcher")
                    return

                if event.mask & flags.CLOSE_WRITE:
                    await process_new_achievements(appid, ach_path, already_earned)

    except asyncio.CancelledError:
        pass
    except Exception as e:
        decky.logger.error(f"Error in inotify watcher: {e}")
    finally:
        if inotify is not None:
            try:
                inotify.close()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Polling fallback (only used if explicitly selected)
# ---------------------------------------------------------------------------

async def poll_achievements(
    appid: str,
    ach_path: str,
    stop_event: asyncio.Event,
    already_earned: set[str],
    interval: float = 2.0,
) -> None:
    """Poll achievements.json periodically as a fallback."""
    last_mtime: float = 0.0

    while not stop_event.is_set():
        try:
            current_mtime = os.path.getmtime(ach_path)
        except OSError:
            await asyncio.sleep(interval)
            continue

        if current_mtime != last_mtime:
            last_mtime = current_mtime
            await process_new_achievements(appid, ach_path, already_earned)

        await asyncio.sleep(interval)


# ---------------------------------------------------------------------------
# Plugin class
# ---------------------------------------------------------------------------

class Plugin:
    """Decky plugin entry point for GSE Watcher."""

    async def _main(self) -> None:
        """Called when the plugin loads."""
        self.loop = asyncio.get_running_loop()
        self.stop_event = asyncio.Event()
        self.watch_task: Optional[asyncio.Task] = None
        self.current_appid: Optional[str] = None
        self.current_game: Optional[str] = None
        self.already_earned: set[str] = set()
        self.watcher_mode: str = "auto"  # "auto", "inotify", "poll"
        self._watch_lock = asyncio.Lock()

        # Settings
        settings_dir = os.environ.get(
            "DECKY_PLUGIN_SETTINGS_DIR",
            os.path.join(decky.DECKY_HOME, "settings", "gse-watcher"),
        )
        self.settings = SettingsManager(
            name="gse-watcher-settings",
            settings_directory=settings_dir,
        )
        self.settings.read()

        self.watcher_mode = self.settings.getSetting("watcher_mode", "auto")

        decky.logger.info(f"GSE Watcher loaded (mode: {self.watcher_mode})")

        # Auto-detect is handled by the frontend via Steam Router
        auto_detect = self.settings.getSetting("auto_detect", True)
        if auto_detect:
            decky.logger.info("Auto-detect enabled — frontend will start watching via Steam Router")

    async def start_watching(self, appid: str, game_name: str = "") -> dict:
        """Begin watching for achievements on *appid*.

        Callable from the frontend via ``callable("start_watching", appid, game_name)``.
        Game name is provided by the frontend via Steam's Router/MainRunningApp.
        """
        # Validate appid is numeric (all Steam AppIDs are numbers)
        if not appid.strip().isdigit():
            raise ValueError(f"AppID must be a numeric Steam AppID, got: {appid}")

        async with self._watch_lock:
            # Stop any existing watch first
            await self.stop_watching()

            self.current_appid = appid
            self.current_game = game_name or f"Unknown (appid {appid})"

            ach_path = get_achievements_path(appid)
            ensure_achievements_file(ach_path)

            # Snapshot currently earned so we only report new ones
            self.already_earned = set(parse_earned_achievements(ach_path))

            decky.logger.info(
                f"Watching: {self.current_game} (appid={appid}), "
                f"{len(self.already_earned)} already earned"
            )

            # Emit status to frontend
            await decky.emit(
                "watching_started",
                appid,
                self.current_game,
                len(self.already_earned),
            )

            # Choose watcher mode
            # inotify is always available via inotify_simple (bundled pure Python)
            use_inotify = self.watcher_mode != "poll"

            if use_inotify:
                self.watch_task = self.loop.create_task(
                    watch_achievements(
                        appid, ach_path, self.stop_event, self.already_earned
                    )
                )
            else:
                self.watch_task = self.loop.create_task(
                    poll_achievements(
                        appid, ach_path, self.stop_event, self.already_earned
                    )
                )

            return {
                "appid": appid,
                "game": self.current_game,
                "achievements_path": ach_path,
                "already_earned": len(self.already_earned),
                "mode": "inotify" if use_inotify else "poll",
            }

    async def stop_watching(self) -> dict:
        """Stop the current achievement watch.

        Callable from the frontend via ``callable("stop_watching")``.
        """
        self.stop_event.set()

        # Snapshot and clear ALL state BEFORE any await to avoid races
        task_to_wait = None
        if self.watch_task:
            self.watch_task.cancel()
            task_to_wait = self.watch_task
            self.watch_task = None

        appid = self.current_appid
        game = self.current_game
        self.current_appid = None
        self.current_game = None
        self.already_earned.clear()

        # Now await the old task without holding shared state
        if task_to_wait:
            try:
                await asyncio.wait_for(task_to_wait, timeout=5.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass

        await decky.emit("watching_stopped", appid, game)

        self.stop_event.clear()
        return {"stopped": True, "appid": appid, "game": game}

    async def get_status(self) -> dict:
        """Return current watcher status. Callable from frontend."""
        return {
            "watching": self.current_appid is not None,
            "appid": self.current_appid,
            "game": self.current_game,
            "earned_count": len(self.already_earned),
            "mode": self.watcher_mode,
        }

    async def set_watcher_mode(self, mode: str) -> dict:
        """Set the watcher mode: 'auto', 'inotify', or 'poll'.

        Callable from frontend. If currently watching, restarts with new mode.
        """
        if mode not in ("auto", "inotify", "poll"):
            return {"error": f"Invalid mode: {mode}"}

        self.watcher_mode = mode
        self.settings.setSetting("watcher_mode", mode)
        self.settings.commit()

        # Restart watching if active
        if self.current_appid:
            appid = self.current_appid
            game = self.current_game
            await self.stop_watching()
            await self.start_watching(appid, game or "")

        return {"mode": mode}

    async def set_auto_detect(self, enabled: bool) -> dict:
        """Persist auto-detect on startup setting. Callable from frontend."""
        self.settings.setSetting("auto_detect", enabled)
        self.settings.commit()
        return {"auto_detect": enabled}

    async def get_auto_detect(self) -> dict:
        """Return current auto-detect setting. Callable from frontend."""
        return {"auto_detect": self.settings.getSetting("auto_detect", True)}

    # -------------------------------------------------------------------
    # Whitelist
    # -------------------------------------------------------------------

    async def get_whitelist(self) -> dict:
        """Return the whitelist. Callable from frontend."""
        return {"whitelist": self.settings.getSetting("whitelist", [])}

    async def add_to_whitelist(self, appid: str, name: str = "") -> dict:
        """Add a game to the whitelist. Callable from frontend."""
        if not appid.strip().isdigit():
            raise ValueError(f"AppID must be numeric, got: {appid}")

        whitelist: list[dict] = self.settings.getSetting("whitelist", [])

        # Avoid duplicates
        if any(entry.get("appid") == appid for entry in whitelist):
            return {"error": "already_in_whitelist", "appid": appid}

        whitelist.append({"appid": appid, "name": name or f"App {appid}"})
        self.settings.setSetting("whitelist", whitelist)
        self.settings.commit()
        decky.logger.info(f"Added to whitelist: {name or appid} ({appid})")
        return {"whitelist": whitelist}

    async def remove_from_whitelist(self, appid: str) -> dict:
        """Remove a game from the whitelist. Callable from frontend."""
        whitelist: list[dict] = self.settings.getSetting("whitelist", [])
        whitelist = [e for e in whitelist if e.get("appid") != appid]
        self.settings.setSetting("whitelist", whitelist)
        self.settings.commit()
        decky.logger.info(f"Removed from whitelist: {appid}")
        return {"whitelist": whitelist}

    async def _unload(self) -> None:
        """Called when the plugin is stopped (not uninstalled)."""
        decky.logger.info("GSE Watcher unloading")
        await self.stop_watching()

    async def _uninstall(self) -> None:
        """Called when the plugin is uninstalled."""
        decky.logger.info("GSE Watcher uninstalling")
