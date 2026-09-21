const manifest = {"name":"GSE Watcher"};
const API_VERSION = 2;
const internalAPIConnection = window.__DECKY_SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED_deckyLoaderAPIInit;
if (!internalAPIConnection) {
    throw new Error('[@decky/api]: Failed to connect to the loader as as the loader API was not initialized. This is likely a bug in Decky Loader.');
}
let api;
try {
    api = internalAPIConnection.connect(API_VERSION, manifest.name);
}
catch {
    api = internalAPIConnection.connect(1, manifest.name);
    console.warn(`[@decky/api] Requested API version ${API_VERSION} but the running loader only supports version 1. Some features may not work.`);
}
if (api._version != API_VERSION) {
    console.warn(`[@decky/api] Requested API version ${API_VERSION} but the running loader only supports version ${api._version}. Some features may not work.`);
}
const callable = api.callable;
const addEventListener = api.addEventListener;
const removeEventListener = api.removeEventListener;
const definePlugin = (fn) => {
    return (...args) => {
        return fn(...args);
    };
};

const startWatching = callable("start_watching");
const stopWatching = callable("stop_watching");
const getStatus = callable("get_status");
const setWatcherMode = callable("set_watcher_mode");
const setAutoDetect = callable("set_auto_detect");
const getAutoDetect = callable("get_auto_detect");
const getWhitelist = callable("get_whitelist");
const addToWhitelist = callable("add_to_whitelist");
const removeFromWhitelist = callable("remove_from_whitelist");
// ---------------------------------------------------------------------------
// Achievement icon (inline SVG to avoid bundling icon libraries)
// ---------------------------------------------------------------------------
const TrophyIcon = () => (SP_JSX.jsx("svg", { viewBox: "0 0 24 24", width: "24", height: "24", fill: "currentColor", className: DFL.staticClasses.PanelSectionTitle, children: SP_JSX.jsx("path", { d: "M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94A5.01 5.01 0 0012 15.9V19H8v2h8v-2h-4v-3.1a5.01 5.01 0 004.61-2.96C19.08 10.63 21 8.55 21 6V7c0-1.1-.9-2-2-2zM5 7V6h2v3.83C5.84 9.28 5 8.17 5 7zm14 0c0 1.17-.84 2.28-2 2.83V6h2v1z" }) }));
// ---------------------------------------------------------------------------
// Steam API helpers
// ---------------------------------------------------------------------------
function getRunningGameAppId() {
    return DFL.Router.MainRunningApp?.appid != null ? String(DFL.Router.MainRunningApp.appid) : null;
}
function getRunningGameName() {
    return DFL.Router.MainRunningApp?.display_name ?? null;
}
// ---------------------------------------------------------------------------
// Shared input styles
// ---------------------------------------------------------------------------
const inputStyle = {
    width: "100%",
    padding: "4px 8px",
    borderRadius: "4px",
    border: "1px solid rgba(255,255,255,0.15)",
    background: "rgba(255,255,255,0.05)",
    color: "#fff",
    fontSize: "13px",
    boxSizing: "border-box",
};
// ---------------------------------------------------------------------------
// Main content component
// ---------------------------------------------------------------------------
const GSEWatcherContent = () => {
    const [status, setStatus] = SP_REACT.useState({
        watching: false,
        appid: null,
        game: null,
        earned_count: 0,
        mode: "auto",
    });
    const [achievements, setAchievements] = SP_REACT.useState([]);
    const [manualAppid, setManualAppid] = SP_REACT.useState("");
    const [autoDetect, setAutoDetectState] = SP_REACT.useState(true);
    const [starting, setStarting] = SP_REACT.useState(false);
    const [whitelist, setWhitelist] = SP_REACT.useState([]);
    const [addAppidInput, setAddAppidInput] = SP_REACT.useState("");
    const [addNameInput, setAddNameInput] = SP_REACT.useState("");
    const feedRef = SP_REACT.useRef(null);
    const statusRef = SP_REACT.useRef(status);
    statusRef.current = status;
    // Dropdown options (memoised to avoid re-renders)
    const modeOptions = SP_REACT.useMemo(() => [
        { data: "auto", label: "Auto (inotify)" },
        { data: "poll", label: "Polling" },
    ], []);
    // -----------------------------------------------------------------------
    // Event listeners + Steam game session monitoring
    // Uses addEventListener/removeEventListener from @decky/api
    // (NOT serverAPI.on — that was the old API)
    // -----------------------------------------------------------------------
    SP_REACT.useEffect(() => {
        // Load initial state
        getStatus().then(setStatus).catch(() => { });
        getAutoDetect().then((res) => setAutoDetectState(res.auto_detect)).catch(() => { });
        getWhitelist().then((res) => setWhitelist(res.whitelist)).catch(() => { });
        // Backend event listeners via addEventListener
        const unlockedListener = addEventListener("achievement_unlocked", (id, appid, success) => {
            setAchievements((prev) => [
                { id, appid, success, timestamp: Date.now() },
                ...prev.slice(0, 49),
            ]);
            setStatus((prev) => ({ ...prev, earned_count: prev.earned_count + 1 }));
        });
        const startedListener = addEventListener("watching_started", (appid, game, earned) => {
            setStatus((prev) => ({ watching: true, appid, game, earned_count: earned, mode: prev.mode }));
            setStarting(false);
        });
        const stoppedListener = addEventListener("watching_stopped", () => {
            setStatus((prev) => ({ watching: false, appid: null, game: null, earned_count: 0, mode: prev.mode }));
        });
        // Steam game session listener — handles auto-watch on launch and auto-stop on exit
        let sessionUnregister = null;
        try {
            sessionUnregister = SteamClient.GameSessions.RegisterForAppLifetimeNotifications((notif) => {
                const appId = String(notif.unAppID);
                const current = statusRef.current;
                if (notif.bRunning) {
                    // Game launched — auto-switch to it if enabled and whitelisted
                    getAutoDetect().then((autoRes) => {
                        if (!autoRes.auto_detect)
                            return;
                        getWhitelist().then(async (wlRes) => {
                            const isWl = wlRes.whitelist.some((e) => e.appid === appId);
                            if (!isWl)
                                return;
                            // Stop current watch if any, then start new one
                            if (statusRef.current.watching) {
                                await stopWatching();
                                setStatus((prev) => ({ watching: false, appid: null, game: null, earned_count: 0, mode: prev.mode }));
                            }
                            const gameName = getRunningGameName() || `Unknown (appid ${appId})`;
                            try {
                                const res = await startWatching(appId, gameName);
                                setStatus({ watching: true, appid: res.appid, game: res.game, earned_count: res.already_earned, mode: res.mode });
                                setStarting(false);
                            }
                            catch (e) {
                                console.error("Auto-watch on game start failed", e);
                            }
                        }).catch(() => { });
                    }).catch(() => { });
                }
                else {
                    // Game exited — stop watching if it was the current game
                    if (current.watching && current.appid === appId) {
                        stopWatching().catch(() => { });
                        setStatus((prev) => ({ watching: false, appid: null, game: null, earned_count: 0, mode: prev.mode }));
                    }
                }
            });
        }
        catch {
            // SteamClient may not be available in all contexts
        }
        return () => {
            removeEventListener("achievement_unlocked", unlockedListener);
            removeEventListener("watching_started", startedListener);
            removeEventListener("watching_stopped", stoppedListener);
            sessionUnregister?.unregister();
        };
    }, []);
    // Auto-scroll feed
    SP_REACT.useEffect(() => {
        if (feedRef.current) {
            feedRef.current.scrollTop = 0;
        }
    }, [achievements]);
    // Auto-detect on startup: if setting is enabled, a game is running, AND it's whitelisted
    SP_REACT.useEffect(() => {
        getAutoDetect().then((autoRes) => {
            if (!autoRes.auto_detect)
                return;
            const appId = getRunningGameAppId();
            if (!appId)
                return;
            getWhitelist().then(async (wlRes) => {
                const isWl = wlRes.whitelist.some((e) => e.appid === appId);
                if (isWl) {
                    const gameName = getRunningGameName() || `Unknown (appid ${appId})`;
                    try {
                        const res = await startWatching(appId, gameName);
                        setStatus({ watching: true, appid: res.appid, game: res.game, earned_count: res.already_earned, mode: res.mode });
                        setStarting(false);
                    }
                    catch (e) {
                        console.error("Auto-detect startup failed", e);
                    }
                }
            }).catch(() => { });
        }).catch(() => { });
    }, []);
    // -----------------------------------------------------------------------
    // Actions
    // -----------------------------------------------------------------------
    const handleAutoDetect = SP_REACT.useCallback(async () => {
        setStarting(true);
        try {
            const appId = getRunningGameAppId();
            if (appId) {
                const isWl = whitelist.some((e) => e.appid === appId);
                if (!isWl) {
                    setStarting(false);
                    return;
                }
                const gameName = getRunningGameName() || `Unknown (appid ${appId})`;
                const res = await startWatching(appId, gameName);
                setStatus({ watching: true, appid: res.appid, game: res.game, earned_count: res.already_earned, mode: res.mode });
                setStarting(false);
            }
            else {
                setStarting(false);
            }
        }
        catch (e) {
            console.error("Auto-detect failed", e);
            setStarting(false);
        }
    }, [whitelist]);
    const handleManualStart = SP_REACT.useCallback(async () => {
        if (!manualAppid.trim())
            return;
        setStarting(true);
        try {
            const res = await startWatching(manualAppid.trim(), `App ${manualAppid.trim()}`);
            setStatus({ watching: true, appid: res.appid, game: res.game, earned_count: res.already_earned, mode: res.mode });
            setStarting(false);
        }
        catch (e) {
            console.error("Manual start failed", e);
            setStarting(false);
        }
    }, [manualAppid]);
    const handleStop = SP_REACT.useCallback(async () => {
        try {
            await stopWatching();
            setStatus((prev) => ({ watching: false, appid: null, game: null, earned_count: 0, mode: prev.mode }));
        }
        catch (e) {
            console.error("Stop failed", e);
        }
    }, []);
    const handleModeChange = SP_REACT.useCallback(async (data) => {
        try {
            const result = await setWatcherMode(data.data);
            setStatus((prev) => ({ ...prev, mode: result.mode }));
        }
        catch (e) {
            console.error("Mode change failed", e);
        }
    }, []);
    const handleAutoDetectToggle = SP_REACT.useCallback(async (checked) => {
        setAutoDetectState(checked);
        try {
            await setAutoDetect(checked);
        }
        catch (e) {
            console.error("Auto-detect toggle failed", e);
            setAutoDetectState(!checked);
        }
    }, []);
    const handleAddToWhitelist = SP_REACT.useCallback(async () => {
        const appid = addAppidInput.trim();
        const name = addNameInput.trim();
        if (!appid)
            return;
        try {
            const res = await addToWhitelist(appid, name);
            if ("whitelist" in res) {
                setWhitelist(res.whitelist);
                setAddAppidInput("");
                setAddNameInput("");
                // Auto-start watching if this game is currently running and auto-watch is on
                if (!statusRef.current.watching && appid === getRunningGameAppId() && autoDetect) {
                    const gameName = getRunningGameName() || name || `App ${appid}`;
                    try {
                        const watchRes = await startWatching(appid, gameName);
                        setStatus({ watching: true, appid: watchRes.appid, game: watchRes.game, earned_count: watchRes.already_earned, mode: watchRes.mode });
                        setStarting(false);
                    }
                    catch (e) {
                        console.error("Auto-watch after whitelist add failed", e);
                    }
                }
            }
        }
        catch (e) {
            console.error("Failed to add to whitelist", e);
        }
    }, [addAppidInput, addNameInput, autoDetect]);
    const handleAddCurrentGame = SP_REACT.useCallback(async () => {
        const appId = getRunningGameAppId();
        if (!appId)
            return;
        const name = getRunningGameName() || `App ${appId}`;
        try {
            const res = await addToWhitelist(appId, name);
            if ("whitelist" in res) {
                setWhitelist(res.whitelist);
                // Auto-start watching if not already watching and auto-watch is on
                if (!statusRef.current.watching && autoDetect) {
                    try {
                        const watchRes = await startWatching(appId, name);
                        setStatus({ watching: true, appid: watchRes.appid, game: watchRes.game, earned_count: watchRes.already_earned, mode: watchRes.mode });
                        setStarting(false);
                    }
                    catch (e) {
                        console.error("Auto-watch after whitelist add failed", e);
                    }
                }
            }
        }
        catch (e) {
            console.error("Failed to add current game", e);
        }
    }, [autoDetect]);
    const handleRemoveFromWhitelist = SP_REACT.useCallback(async (appid) => {
        try {
            const res = await removeFromWhitelist(appid);
            setWhitelist(res.whitelist);
        }
        catch (e) {
            console.error("Failed to remove", e);
        }
    }, []);
    const runningAppId = getRunningGameAppId();
    const runningGameName = getRunningGameName();
    const isCurrentGameWhitelisted = runningAppId
        ? whitelist.some((e) => e.appid === runningAppId)
        : false;
    // -----------------------------------------------------------------------
    // Render — vertical-only layout, no horizontal flex inside PanelSectionRow
    // -----------------------------------------------------------------------
    return (SP_JSX.jsxs("div", { children: [SP_JSX.jsx(DFL.PanelSection, { title: "GSE Watcher", children: status.watching ? (SP_JSX.jsxs(SP_JSX.Fragment, { children: [SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsxs("div", { style: { fontSize: "13px" }, children: [SP_JSX.jsx("strong", { children: status.game || status.appid }), SP_JSX.jsx("span", { style: { color: "rgba(255,255,255,0.4)", marginLeft: 8 }, children: status.appid }), SP_JSX.jsxs("span", { style: { color: "#66c0f4", marginLeft: 8 }, children: ["\u25CF ", status.earned_count] })] }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", onClick: handleStop, children: "Stop" }) })] })) : (SP_JSX.jsxs(SP_JSX.Fragment, { children: [SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", onClick: handleAutoDetect, disabled: starting || !runningAppId || !isCurrentGameWhitelisted, children: starting ? "Starting..." : runningAppId ? (isCurrentGameWhitelisted ? `Watch ${runningGameName ?? `App ${runningAppId}`}` : `${runningGameName ?? `App ${runningAppId}`} ✗ not whitelisted`) : "No game running" }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("input", { type: "text", placeholder: "AppID", value: manualAppid, onChange: (e) => setManualAppid(e.target.value), style: inputStyle, onKeyDown: (e) => e.key === "Enter" && handleManualStart() }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", onClick: handleManualStart, disabled: starting || !manualAppid.trim(), children: "Start Manual" }) })] })) }), achievements.length > 0 && (SP_JSX.jsx(DFL.PanelSection, { title: `Achievements (${achievements.length})`, children: SP_JSX.jsx("div", { ref: feedRef, style: { maxHeight: "120px", overflowY: "auto", fontSize: "12px" }, children: achievements.map((ach) => (SP_JSX.jsxs("div", { style: { padding: "2px 0" }, children: [ach.success ? "✓" : "✗", " ", ach.id] }, `${ach.id}-${ach.timestamp}`))) }) })), SP_JSX.jsxs(DFL.PanelSection, { title: "Settings", children: [SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.Dropdown, { rgOptions: modeOptions, selectedOption: status.mode, onChange: handleModeChange, strDefaultLabel: "Watcher Mode" }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ToggleField, { label: "Auto-watch whitelisted", checked: autoDetect, onChange: handleAutoDetectToggle }) })] }), SP_JSX.jsxs(DFL.PanelSection, { title: "Whitelist", children: [runningAppId && !isCurrentGameWhitelisted && (SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsxs(DFL.ButtonItem, { layout: "below", onClick: handleAddCurrentGame, children: ["+ ", runningGameName ?? `App ${runningAppId}`] }) })), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("input", { type: "text", placeholder: "AppID", value: addAppidInput, onChange: (e) => setAddAppidInput(e.target.value), style: inputStyle, onKeyDown: (e) => e.key === "Enter" && handleAddToWhitelist() }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("input", { type: "text", placeholder: "Name (optional)", value: addNameInput, onChange: (e) => setAddNameInput(e.target.value), style: inputStyle, onKeyDown: (e) => e.key === "Enter" && handleAddToWhitelist() }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", onClick: handleAddToWhitelist, disabled: !addAppidInput.trim(), children: "Add to Whitelist" }) }), whitelist.map((entry) => (SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsxs(DFL.ButtonItem, { layout: "below", onClick: () => handleRemoveFromWhitelist(entry.appid), children: [entry.name, " (", entry.appid, ") \u2014 Remove"] }) }, entry.appid)))] })] }));
};
// ---------------------------------------------------------------------------
// Plugin definition — matches official template pattern:
// definePlugin(() => { ... return { name, content, icon, onDismount } })
// ---------------------------------------------------------------------------
var index = definePlugin(() => {
    return {
        name: "GSE Watcher",
        content: SP_JSX.jsx(GSEWatcherContent, {}),
        icon: SP_JSX.jsx(TrophyIcon, {}),
        onDismount() {
            // Backend handles watcher stop via _unload
            // Frontend event listeners are cleaned up by component useEffect
        },
    };
});

export { index as default };
//# sourceMappingURL=index.js.map
