// Configure Native Side Panel action click behavior
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(err => {
        console.error("Failed to set side panel behavior:", err);
    });
}

// ===== CONFIGURATION =====
const GITHUB_DATA_URLS = {
    airports: "https://raw.githubusercontent.com/rtankus/sandcat-extension/92d75e83fb280eae1bf721beb331c5fc370a1b1a/airports.js",
    callsigns: "https://raw.githubusercontent.com/rtankus/callsign-extension/564ea1979ecb182a9f09b5f69b461c3ab97d31a5/airline-callsigns.clean.json"
};

// ===== CACHE =====
let dataCache = {
    airports: { data: null, timestamp: null },
    navaids: { data: null, timestamp: null },
    callsigns: { data: null, timestamp: null }
};

const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

// ===== UTILITIES =====

function sanitizeAirportInfo(str) {
    if (!str) return "";
    // Remove HTML tags and entities
    let s = str.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ");
    
    // Aggressively remove boilerplate
    const junk = [
        "Airport Activity",
        "Flight Tracker",
        "FlightAware",
        "Unknown",
        "INVALID",
        "Information",
        "Status",
        "Airport"
    ];
    
    junk.forEach(j => {
        const re = new RegExp(j, "gi");
        s = s.replace(re, "");
    });

    // Remove trailing dashes/slashes and clean up spaces
    return s.replace(/[/-]\s*$/, "").replace(/\s+/g, " ").trim();
}

function toTitleCase(str) {
    return str.replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase());
}

// Parse CSV to array of objects
function parseCSV(csvText) {
    const lines = csvText.trim().split('\n');
    const headers = lines[0].split(',').map(h => h.trim());
    
    return lines.slice(1).map(line => {
        const values = line.split(',').map(v => v.trim());
        const obj = {};
        headers.forEach((header, i) => {
            obj[header] = values[i] || '';
        });
        return obj;
    });
}

// Extract AIRPORTS array from the .js file
function extractAirportsFromJS(jsText) {
    // The file contains: const AIRPORTS = [{...}];
    const match = jsText.match(/const\s+AIRPORTS\s*=\s*(\[[\s\S]*?\]);/);
    if (match) {
        return JSON.parse(match[1]);
    }
    throw new Error("Could not parse airports.js");
}

// ===== GITHUB FETCH FUNCTION =====
async function fetchGitHubData(key) {
    const cached = dataCache[key];
    const now = Date.now();
    
    // Return cached if fresh
    if (cached.data && cached.timestamp && (now - cached.timestamp < CACHE_DURATION)) {
        console.log(`Using cached ${key}`);
        return cached.data;
    }
    
    try {
        console.log(`Fetching ${key} ...`);
        const url = key === 'navaids' ? chrome.runtime.getURL('navaids.json') : GITHUB_DATA_URLS[key];
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        let data;
        
        // Parse based on file type
        if (key === 'navaids') {
            const jsonText = await response.text();
            data = JSON.parse(jsonText);
        } else if (key === 'airports') {
            const jsText = await response.text();
            data = extractAirportsFromJS(jsText);
        } else if (key === 'callsigns') {
            const json = await response.json();
            data = json.all; // Extract the "all" array
        } else {
            data = await response.json();
        }
        
        // Update cache
        dataCache[key] = {
            data: data,
            timestamp: now
        };
        
        console.log(`✓ Cached ${key} (${data.length} entries)`);
        return data;
        
    } catch (err) {
        console.error(`Failed to fetch ${key}:`, err);
        
        // Fallback to stale cache
        if (cached.data) {
            console.warn(`Using stale ${key} cache`);
            return cached.data;
        }
        
        return null;
    }
}

// ===== CALLSIGN SYNC (Modified) =====
async function syncCallsignData() {
    try {
        const res = await chrome.storage.local.get("callsigns");
        if (!res.callsigns || res.callsigns.length === 0) {
            console.log("Syncing callsigns from GitHub...");
            const data = await fetchGitHubData('callsigns');
            if (data) {
                await chrome.storage.local.set({ callsigns: data });
                console.log(`✓ Synced ${data.length} callsigns`);
            }
        }
    } catch (err) {
        console.error("[Sync] Failed:", err);
    }
}

// ===== STARTUP =====
chrome.runtime.onInstalled.addListener(() => {
    syncCallsignData();
    chrome.contextMenus.create({
        id: "fetch-in-froyo",
        title: "Fetch in Froyo: %s",
        contexts: ["selection"]
    });
    chrome.contextMenus.create({
        id: "open-froyo-sidepanel",
        title: "Open Froyo Side Panel",
        contexts: ["all"]
    });
    
    // Preload data
    fetchGitHubData('airports').catch(e => console.error("Preload airports failed:", e));
    fetchGitHubData('navaids').catch(e => console.error("Preload navaids failed:", e));
});

chrome.runtime.onStartup.addListener(syncCallsignData);

// ===== ACTION & CONTEXT MENU =====
chrome.action.onClicked.addListener(async (tab) => {
    chrome.storage.local.get(["lastViewType"], async (res) => {
        const lastViewType = res.lastViewType || "overlay";
        if (lastViewType === "sidepanel") {
            chrome.sidePanel.open({ windowId: tab.windowId }).catch(err => console.error(err));
        } else {
            // Close sidepanel first
            chrome.runtime.sendMessage({ action: "CLOSE_SIDEPANEL" }).catch(() => {});
            
            // Check if content script is already injected by sending a ping
            chrome.tabs.sendMessage(tab.id, { action: "ping" }, async (response) => {
                if (chrome.runtime.lastError || !response || response.status !== "pong") {
                    // Not injected yet! Let's inject and toggle
                    try {
                        const filesToInject = ["utils.js", "parser.js", "fuse.js", "content.js"];
                        await chrome.scripting.executeScript({
                            target: { tabId: tab.id, allFrames: true },
                            files: filesToInject
                        });
                        await chrome.tabs.sendMessage(tab.id, { action: "toggleOverlay" });
                    } catch (err) {
                        console.error("Froyo: Injection failed:", err);
                    }
                } else {
                    // Already injected! Just toggle
                    chrome.tabs.sendMessage(tab.id, { action: "toggleOverlay" }).catch(() => {});
                }
            });
        }
    });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "open-froyo-sidepanel") {
        if (chrome.sidePanel && chrome.sidePanel.open) {
            chrome.sidePanel.open({ windowId: tab.windowId }).catch(err => console.error(err));
        }
    } else if (info.menuItemId === "fetch-in-froyo") {
        const payload = { 
            source: "context_menu", 
            type: "ADSB_AIRCRAFT_SELECTED", 
            callsign: info.selectionText.trim() 
        };
        chrome.tabs.query({}, (tabs) => {
            tabs.forEach(t => chrome.tabs.sendMessage(t.id, payload).catch(() => {}));
        });
    }
});

// ===== MESSAGE LISTENERS =====
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    
    // 0.2 Open sidepanel programmatically from webpage overlay
    if (msg.action === "LAUNCH_SIDEPANEL") {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]) {
                chrome.sidePanel.open({ windowId: tabs[0].windowId }).catch(err => console.error(err));
            }
        });
        return;
    }

    // 0.3 Open ADSB Replay page
    if (msg.action === "OPEN_ADSB_REPLAY") {
        let url = "https://globe.adsbexchange.com/";
        if (msg.gk && msg.gk.trim()) {
            const parsedUrl = buildAdsbReplayUrl(msg.gk);
            if (parsedUrl) {
                url = parsedUrl;
            }
        }
        chrome.tabs.create({ url });
        sendResponse({ ok: true });
        return true;
    }

    // 0. Launch overlay in active tab programmatically from side panel
    if (msg.action === "LAUNCH_OVERLAY_IN_ACTIVE_TAB") {
        // Close sidepanel first
        chrome.runtime.sendMessage({ action: "CLOSE_SIDEPANEL" }).catch(() => {});
        chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
            if (tabs[0]) {
                const tab = tabs[0];
                chrome.tabs.sendMessage(tab.id, { action: "ping" }, async (response) => {
                    if (chrome.runtime.lastError || !response || response.status !== "pong") {
                        try {
                            const filesToInject = ["utils.js", "parser.js", "fuse.js", "content.js"];
                            await chrome.scripting.executeScript({
                                target: { tabId: tab.id, allFrames: true },
                                files: filesToInject
                            });
                        } catch (err) {
                            console.log("Froyo: Script injection failed:", err);
                        }
                    }
                    chrome.tabs.sendMessage(tab.id, { action: "showOverlay" }).catch(() => {});
                });
            }
        });
        return;
    }

    // 0.5. Manual Grab Trigger
    if (msg.action === "START_GK_GRAB") {
        chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
            if (tabs[0]) {
                const tab = tabs[0];
                try {
                    const filesToInject = ["utils.js", "parser.js", "fuse.js", "content.js"];
                    // Inject script files to all frames first to ensure content script runs
                    await chrome.scripting.executeScript({
                        target: { tabId: tab.id, allFrames: true },
                        files: filesToInject
                    });

                    // Execute findArchiveKeyOnPage directly in all frames
                    const executionResults = await chrome.scripting.executeScript({
                        target: { tabId: tab.id, allFrames: true },
                        func: () => {
                            if (typeof findArchiveKeyOnPage === "function") {
                                return findArchiveKeyOnPage();
                            }
                            return null;
                        }
                    });

                    let foundKey = null;
                    if (executionResults) {
                        for (const frameResult of executionResults) {
                            if (frameResult.result) {
                                foundKey = frameResult.result;
                                break;
                            }
                        }
                    }

                    if (foundKey) {
                        // Send the found key to all frames/views (including side panel)
                        chrome.runtime.sendMessage({ action: "GK_FOUND_IN_FRAME", text: foundKey }).catch(() => {});
                        // Also send to all tabs
                        chrome.tabs.query({}, (allTabs) => {
                            allTabs.forEach(t => {
                                chrome.tabs.sendMessage(t.id, { action: "GK_FOUND_IN_FRAME", text: foundKey }).catch(() => {});
                            });
                        });
                    }
                } catch (err) {
                    console.error("Froyo: START_GK_GRAB injection or execution failed:", err);
                }
            }
        });
        return;
    }

    // 1. Broadcast Relay (e.g. ADSB Hook)
    if (msg.source === "adsb_hook") {
        chrome.tabs.query({}, (tabs) => {
            tabs.forEach(tab => {
                chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
            });
        });
        return;
    }

    // 3. Force Reload Callsigns
    if (msg.action === "FORCE_RELOAD_CALLSIGNS") {
        // Clear cache and re-sync
        dataCache.callsigns = { data: null, timestamp: null };
        chrome.storage.local.remove("callsigns", () => {
            syncCallsignData().then(() => sendResponse({ status: "done" }));
        });
        return true;
    }

    // 4. Fetch Page (SECURED: Restricted to allowed domains)
    if (msg.action === "fetchPage") {
        const allowedDomains = [
            "flightaware.com",
            "airnav.com",
            "airport-data.com",
            "githubusercontent.com",
            "labelbox.com"
        ];
        
        try {
            const url = new URL(msg.url);
            const isAllowed = allowedDomains.some(domain => 
                url.hostname === domain || url.hostname.endsWith("." + domain)
            );

            if (!isAllowed) {
                console.error("Blocked unauthorized fetch to:", msg.url);
                sendResponse({ error: "Domain not allowed" });
                return true;
            }

            fetch(msg.url)
                .then(r => r.text())
                .then(html => sendResponse({ html }))
                .catch(() => sendResponse({ error: true }));
        } catch (e) {
            sendResponse({ error: "Invalid URL" });
        }
        return true;
    }

    // 5. Force Sync Labelbox
    if (msg.action === "forceSyncLabelbox") {
        chrome.storage.local.get(["lb_pageKey"], (res) => {
            sendResponse({ key: res.lb_key || "" });
        });
        return true;
    }

    // ===== 6. AIRPORT LOOKUP =====
if (msg.action === "getAirportInfo") {
    (async () => {
        try {
            const airportData = await fetchGitHubData('airports');
            
            if (!airportData) {
                sendResponse({ name: "", location: "", isFound: false });
                return;
            }
            
            const ident = msg.ident.toUpperCase();
            
            // Search in array
            const apt = airportData.find(a => 
                a.icao === ident || 
                a.iata === ident || 
                a.id === ident
            );
            
            if (apt) {
                const location = apt.st ? `${apt.city}, ${apt.st}` : apt.city;
                sendResponse({ 
                    name: apt.n, 
                    location: location, 
                    isFound: true 
                });
            } else {
                // FALLBACK 1: Use airport-data.com search
                console.log(`${ident} not in GitHub data, searching airport-data.com...`);
                const searchUrl = `https://airport-data.com/api/ap_info.json?icao=${ident}`;

                try {
                    const apiRes = await fetch(searchUrl);
                    const data = await apiRes.json();
                    
                    if (data && data.name && data.location) {
                        const cleanName = sanitizeAirportInfo(data.name);
                        const cleanLoc = sanitizeAirportInfo(data.location);
                        
                        console.log(`✓ Found via API: ${cleanName}`);
                        sendResponse({ 
                            name: cleanName, 
                            location: cleanLoc, 
                            isFound: true 
                        });
                        return;
                    }
                } catch (err) {
                    console.log(`✗ API lookup failed:`, err);
                }

                // FALLBACK 2: Scrape FlightAware airport page
                console.log(`${ident} not in API, scraping FlightAware...`);
                const faUrl = `https://www.flightaware.com/live/airport/${ident}`;
                
                try {
                    const faRes = await fetch(faUrl);
                    const html = await faRes.text();
                    
                    const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
                    if (titleMatch) {
                        let title = titleMatch[1];
                        
                        // Pattern 1: "Name Airport (Location) IATA / ICAO"
                        let match = title.match(/^(.*?) Airport \((.*?)\)/i);
                        if (match) {
                            sendResponse({ 
                                name: sanitizeAirportInfo(match[1]), 
                                location: sanitizeAirportInfo(match[2]), 
                                isFound: true 
                            });
                            return;
                        }

                        // Pattern 2: "Name (Location) IATA / ICAO"
                        match = title.match(/^(.*?) \((.*?)\)\s+[A-Z0-9]{3,4}\s*\/\s*[A-Z0-9]{3,4}/i);
                        if (match) {
                            sendResponse({
                                name: sanitizeAirportInfo(match[1]),
                                location: sanitizeAirportInfo(match[2]),
                                isFound: true
                            });
                            return;
                        }

                        // Pattern 3: "Name (Location)"
                        match = title.match(/^(.*?) \((.*?)\)/i);
                        if (match) {
                            sendResponse({
                                name: sanitizeAirportInfo(match[1]),
                                location: sanitizeAirportInfo(match[2]),
                                isFound: true
                            });
                            return;
                        }

                        // Fallback: Just use cleaned title
                        const finalTitle = sanitizeAirportInfo(title.split(/[/-]/)[0]);
                        if (finalTitle.length > 3) {
                            sendResponse({ 
                                name: finalTitle, 
                                location: "", 
                                isFound: true 
                            });
                            return;
                        }
                    }
                } catch (err) {
                    console.log(`✗ Scrape failed:`, err);
                }

                sendResponse({ name: "", location: "", isFound: false });
            }
        } catch (err) {
            console.error("Airport lookup error:", err);
            sendResponse({ name: "", location: "", isFound: false });
        }
    })();
    return true;
}

    // ===== 7. NAVAID LOOKUP =====
    if (msg.action === "getNavaidName") {
        (async () => {
            try {
                const ident = msg.ident.toUpperCase();
                let foundName = "";
                let foundLocation = "";

                // 1. First try GitHub CSV
                const navaidData = await fetchGitHubData('navaids');
                if (navaidData) {
                    const navaid = navaidData.find(n => n.ident === ident);
                    if (navaid) {
                        foundName = navaid.name;
                    }
                }

                // 2. Fallback to AirNav
                if (!foundName) {
                    console.log(`${ident} not in GitHub data, searching AirNav...`);
                    const url = `https://www.airnav.com/cgi-bin/navaid-info?id=${ident}`;
                    try {
                        const res = await fetch(url);
                        const html = await res.text();
                        
                        // Parse HTML for: <DT>JFK<DD>KENNEDY VOR/DME<BR>NEW YORK, NY
                        const regex = new RegExp(`<DT>${ident}<DD>(.*?)<BR>([^<]+)`, "i");
                        const match = html.match(regex);
                        if (match) {
                            foundName = match[1].trim();
                            foundLocation = match[2].trim();
                        }
                    } catch (err) {
                        console.log(`✗ AirNav lookup failed:`, err);
                    }
                }

                sendResponse({ name: foundName, location: foundLocation });
            } catch (err) {
                console.error("Navaid lookup error:", err);
                sendResponse({ name: "", location: "" });
            }
        })();
        return true;
    }

    // ===== 8. FIX LOOKUP (unchanged) =====
    if (msg.action === "getFixInfo") {
        const url = `http://www.airnav.com/airspace/fix/${msg.ident.toUpperCase()}`;
        fetch(url)
            .then(res => res.text())
            .then(html => {
                const cityMatch = html.match(/Nearest city:&nbsp;<\/th><td>([\s\S]*?)<\/td>/i);
                let loc = cityMatch ? cityMatch[1].replace(/<[^>]*>/g, '').trim() : "Unknown";
                if (loc.toLowerCase().includes("no known city")) loc = "Unknown";
                sendResponse({ location: loc });
            })
            .catch(() => sendResponse({ location: "" }));
        return true;
    }
});

// ===== ADSB REPLAY HELPER FUNCTIONS =====
function buildAdsbReplayUrl(rawText) {
    const parsed = parseReplayFromGlobalKey(rawText);
    if (!parsed?.replay) return null;

    let airport = parsed.airport || extractICAOFromKey(rawText);

    const badAirportTokens = new Set([
        "CENT", "CENTER", "CENTRE", "CTR",
        "APP", "DEP", "TWR", "GND",
        "RADAR", "FINAL", "FINA"
    ]);

    if (airport && badAirportTokens.has(String(airport).toUpperCase())) {
        airport = extractAirportFromDashedKey(rawText);
    }

    const airportParam =
        /^[A-Z]{3,4}$/.test(airport || "")
            ? `&airport=${encodeURIComponent(airport)}`
            : "";

    return `https://globe.adsbexchange.com/?replay=${encodeURIComponent(parsed.replay)}${airportParam}`;
}

function parseReplayFromGlobalKey(rawText) {
    const raw = String(rawText || "").trim();
    if (!raw) return null;
    const foreign = parseGlobalKeyAirportDateTime(rawText);
    if (foreign) return foreign;

    // ---------- DATETIME-ONLY FORMAT ----------
    {
        const m = raw.match(
            /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{1,2})-(\d{4})-(\d{2})(\d{2})Z$/i
        );
        if (m) {
            const months = {
                Jan:"01", Feb:"02", Mar:"03", Apr:"04", May:"05", Jun:"06",
                Jul:"07", Aug:"08", Sep:"09", Oct:"10", Nov:"11", Dec:"12"
            };
            const month = months[m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase()];
            const day   = String(m[2]).padStart(2, "0");
            const year  = m[3];
            const hour  = m[4];
            const min   = m[5];
            return { replay: `${year}-${month}-${day}-${hour}:${min}`, airport: null, format: "datetime_only" };
        }
    }

    // ---------- IATA COMPACT FORMAT ----------
    let m = raw.match(/\b[A-Za-z]{2,4}-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})\d{2}_/i);
    if (m) {
        return {
            replay: `${m[1]}-${m[2]}-${m[3]}-${m[4]}:${m[5]}`,
            airport: extractICAOFromKey(raw) || null,
            format: "iata_compact"
        };
    }

    // ---------- NEW FORMAT ----------
    m = raw.match(/\b(\d{2})(\d{2})(\d{2})_(\d{2})(\d{2})_\d+\.wav\b/i);
    if (m) {
        const yy = Number(m[1]);
        const year = String(yy >= 70 ? 1900 + yy : 2000 + yy);
        const month = m[2];
        const day = m[3];
        const hour = m[4];
        const minute = m[5];

        return {
            replay: `${year}-${month}-${day}-${hour}:${minute}`,
            airport: extractICAOFromKey(raw) || null,
            format: "new_compact"
        };
    }

    // ---------- OLD FORMAT ----------
    m = raw.match(
        /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{1,2})-(\d{4})-(\d{4})Z/i
    );

    if (m) {
        const months = {
            Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
            Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12"
        };

        const year = m[3];
        const month = months[m[1]];
        const day = String(m[2]).padStart(2, "0");
        const hour = m[4].slice(0, 2);
        const minute = m[4].slice(2, 4);

        return {
            replay: `${year}-${month}-${day}-${hour}:${minute}`,
            airport: extractICAOFromKey(raw) || null,
            format: "old_named"
        };
    }

    return null;
}

function parseGlobalKeyAirportDateTime(rawText) {
    const raw = String(rawText || "").trim();
    const upper = raw.toUpperCase();

    const MONTHS = {
        JAN: "01", FEB: "02", MAR: "03", APR: "04",
        MAY: "05", JUN: "06", JUL: "07", AUG: "08",
        SEP: "09", OCT: "10", NOV: "11", DEC: "12"
    };

    const dateMatch = upper.match(
        /-([A-Z]{3})-(\d{1,2})-(\d{4})-(\d{4})Z\b/
    );

    if (!dateMatch) return null;

    const airport = extractAirportFromDashedKey(raw);
    const month = MONTHS[dateMatch[1]];
    const day = dateMatch[2].padStart(2, "0");
    const year = dateMatch[3];
    const hhmm = dateMatch[4];

    if (!month) return null;

    const hour = hhmm.slice(0, 2);
    const minute = hhmm.slice(2, 4);

    return {
        airport,
        replay: `${year}-${month}-${day}-${hour}:${minute}`,
        date: `${year}-${month}-${day}`,
        time: `${hour}:${minute}`,
        format: "flex_dashed"
    };
}

function extractAirportFromDashedKey(rawKey) {
    const upper = String(rawKey || "").toUpperCase();

    const ignore = new Set([
        "NY", "APP", "DEP", "CENTER", "CENTRE", "CENT", "RADAR", "TOWER", "GROUND",
        "CTR", "FINAL", "FINA", "FREQ", "VAD", "GND", "TWR",
        "APPR", "ARR", "ARRIVAL", "DEPARTURE", "V2", "CTAF", "OUT"
    ]);

    const firstToken = upper.split("-")[0]?.trim();
    const firstLetters = firstToken.replace(/[^A-Z]/g, "");

    if (
        /^[A-Z]{4}(?:\d+[A-Z0-9]*)?$/.test(firstToken) &&
        !ignore.has(firstLetters)
    ) {
        return firstLetters.slice(0, 4);
    }

    if (/^[A-Z]{3}\d$/.test(firstToken) && !ignore.has(firstLetters)) {
        return firstToken;
    }

    const dateSplit = upper.split(/-(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)-/);
    const beforeDate = dateSplit[0] || upper;

    const parts = beforeDate.split("-").filter(Boolean);

    for (const rawPart of parts) {
        const p = rawPart.toUpperCase();
        const lettersOnly = p.replace(/[^A-Z]/g, "");

        if (ignore.has(p) || ignore.has(lettersOnly)) continue;
        if (lettersOnly.startsWith("FINA") || lettersOnly.startsWith("FINAL")) continue;

        const icao = p.match(/^([A-Z]{4})(?:\d+[A-Z0-9]*)?$/);
        if (icao && !ignore.has(icao[1])) {
            return icao[1];
        }

        if (/^[A-Z]{3}$/.test(p) && !ignore.has(p)) {
            return p;
        }

        const canadian = p.match(/^([A-Z]{3}\d)$/);
        if (canadian && !ignore.has(canadian[1].slice(0, 3))) {
            return canadian[1];
        }
    }

    return null;
}

function extractICAOFromKey(rawKey) {
    if (!rawKey) return null;

    const dashed = extractAirportFromDashedKey(rawKey);
    if (dashed) return dashed;

    const upper = String(rawKey).toUpperCase();
    const domestic = upper.match(
        /(?<![A-Z])(?:K[A-Z]{3}|PA[A-Z]{2}|PH[A-Z]{2}|P[A-Z]{3}|C[A-Z]{3})(?![A-Z])/
    );

    if (domestic) return domestic[0];

    return null;
}