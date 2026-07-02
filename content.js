let autoCheckInterval = null;
let lastTargetDate = null;
let lastFetchedTokens = [];
let overlay = null, overlayVisible = false, dragOffsetX = 0, dragOffsetY = 0;
let flightCandidates = [], currentFlightIndex = 0;
let shadowRoot = null;
let callsignData = [];
let fullAircraftHTML = "";
let lastProcessedCallsign = "";
let lastProcessedTime = 0;
let hasMoved = false;
let isSyncing = false;
let lastFetchedCallsign = "";
const infoCache = {}; // { ident: { name, location } } — persisted to localStorage on write


   chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const isExtensionPage = window.location.protocol === "chrome-extension:";

    // 0. Handle Ping/Liveness Check
    if (msg.action === "ping") {
        sendResponse({ status: "pong" });
        return;
    }

    // 1. Handle CLOSE_SIDEPANEL message
    if (msg.action === "CLOSE_SIDEPANEL" && isExtensionPage) {
        window.close();
        return;
    }

    // 1.1 Handle Overlay Toggle
    if (msg.action === "toggleOverlay" && window === window.top && !isExtensionPage) {
        const host = document.getElementById("flight-route-extension-container");
        if (!host) {
            createOverlay();
        } else {
            shadowRoot = host.shadowRoot;
            overlay = shadowRoot.querySelector("#flightOverlay");
            overlayVisible = !overlayVisible;
            host.style.display = overlayVisible ? "block" : "none";
            if (overlayVisible) {
                if (overlay) overlay.classList.remove("hidden");
                chrome.storage.local.set({ lastViewType: "overlay" }).catch(() => {});
            }
        }
    }

    // 1.2 Handle Force Show Overlay
    if (msg.action === "showOverlay" && window === window.top && !isExtensionPage) {
        const host = document.getElementById("flight-route-extension-container");
        if (!host) {
            createOverlay();
        } else {
            shadowRoot = host.shadowRoot;
            overlay = shadowRoot.querySelector("#flightOverlay");
            overlayVisible = true;
            host.style.display = "block";
            if (overlay) overlay.classList.remove("hidden");
            chrome.storage.local.set({ lastViewType: "overlay" }).catch(() => {});
        }
    }

    // 1.5 Send active flight details to sidepanel query
    if (msg.action === "GET_ACTIVE_FLIGHT_DETAILS" && !isExtensionPage) {
        const activeHost = document.getElementById("flight-route-extension-container");
        const root = activeHost ? activeHost.shadowRoot : null;
        if (root) {
            sendResponse({
                callsign: lastFetchedCallsign,
                typeCode: lastProcessedCallsign === lastFetchedCallsign ? lastProcessedCallsign : null,
                targetDate: lastTargetDate ? lastTargetDate.getTime() : null
            });
        } else {
            sendResponse(null);
        }
        return true;
    }

    // 1.8 Handle scanning the active page for LiveATC archive key
    if (msg.action === "FIND_GK_IN_FRAME") {
        const key = findArchiveKeyOnPage();
        sendResponse({ key: key });
        return true;
    }

    // 1.9 Handle updating the UI with found/received key
    if (msg.action === "GK_FOUND_IN_FRAME") {
        updateOverlayUI(msg.text);
    }

// 4. Handle "Froyo Fetch" (ADSB Bridge)
if (msg.type === "ADSB_AIRCRAFT_SELECTED") {
    const target = msg.callsign ? msg.callsign.trim().toUpperCase() : null;
    if (!target) return;

    // DE-DUPLICATION LOGIC:
    // Ignore if it's the same aircraft within 800ms
    const now = Date.now();
    if (target === lastProcessedCallsign && (now - lastProcessedTime < 800)) {
        console.log("🚫 [Overlay] Blocked duplicate fetch for:", target);
        return;
    }

    lastProcessedCallsign = target;
    lastProcessedTime = now;

    if (shadowRoot) {
        const input = shadowRoot.querySelector("#flightInput");

        if (input) {
            input.value = target;
            updateAircraftTab(target, msg.typeCode); 
            
            // fetchRouteOptions call removed to prevent autofire as per user request
        }
    }
}
}); // <--- This closes the chrome.runtime.onMessage.addListener

// Load data from storage when the overlay is created
async function loadCallsignData() {
    const res = await chrome.storage.local.get("callsigns");
    callsignData = res.callsigns || [];
}

/* --- Info Cache (airports, navaids, fixes) --- */
const INFO_CACHE_KEY = "infoCache";
const INFO_CACHE_MAX = 300;

function loadInfoCache() {
    try {
        const raw = localStorage.getItem(INFO_CACHE_KEY);
        if (raw) Object.assign(infoCache, JSON.parse(raw));
    } catch (e) {}
}

function saveInfoCache() {
    try {
        // Trim to max size by dropping oldest keys
        const keys = Object.keys(infoCache);
        if (keys.length > INFO_CACHE_MAX) {
            keys.slice(0, keys.length - INFO_CACHE_MAX).forEach(k => delete infoCache[k]);
        }
        localStorage.setItem(INFO_CACHE_KEY, JSON.stringify(infoCache));
    } catch (e) {}
}

// Renders info into an existing infoDiv/linkElem from a cache hit or fresh fetch.
// action: "getAirportInfo" | "getNavaidName" | "getFixInfo"
function loadIdentInfo(action, ident, infoDiv, linkElem, onDone) {
    const cached = infoCache[ident];
    if (cached) {
        applyInfoResult(action, cached, infoDiv, linkElem);
        if (onDone) onDone();
        return;
    }
    chrome.runtime.sendMessage({ action, ident }, res => {
        if (res && (res.isFound || res.name || res.location)) {
            const entry = { name: res.name || "", location: res.location || "", isFound: res.isFound };
            infoCache[ident] = entry;
            saveInfoCache();
            // Broadcast to ALL instances of this ident currently in the shadow DOM
            broadcastInfoResult(action, ident, entry);
        } else if (infoDiv) {
            infoDiv.remove();
        }
        if (onDone) onDone();
    });
}

// Updates every infoDiv stamped with data-ident=ident in the shadow DOM at once
function broadcastInfoResult(action, ident, entry) {
    if (!shadowRoot) return;
    shadowRoot.querySelectorAll(`[data-ident="${ident}"][data-action="${action}"]`).forEach(infoDiv => {
        const row = infoDiv.closest(".routeToken");
        let linkElem = null;
        if (action === "getAirportInfo") {
            linkElem = row ? row.querySelector("a") : null;
        } else if (action === "getNavaidName") {
            // nameSpan sits inside the left column, identified by its margin-left style
            linkElem = row ? row.querySelector("span[style*='margin-left']") : null;
        }
        // Remove any pending Load info button first
        infoDiv.querySelector("button")?.remove();
        applyInfoResult(action, entry, infoDiv, linkElem);
    });
    const q = shadowRoot.querySelector("#routeSearch")?.value;
    if (q) applyUniversalFilter(q);
}

function applyInfoResult(action, entry, infoDiv, linkElem) {
    if (!infoDiv) return;
    if (action === "getAirportInfo") {
        if (entry.isFound && entry.name) {
            if (linkElem) linkElem.style.fontWeight = "bold";
            infoDiv.innerHTML = `<span style="color: #aaa;">${entry.name}</span><br>${entry.location}`;
        } else {
            infoDiv.remove();
        }
    } else if (action === "getNavaidName") {
        if (entry.name) {
            const cleanName = entry.name.replace(/\//g, '').toUpperCase().trim();
            if (linkElem) linkElem.textContent = ` (${cleanName})`;  // linkElem is nameSpan here
            infoDiv.textContent = entry.location || "";
            if (!entry.location) infoDiv.remove();
        } else if (infoDiv) {
            infoDiv.remove();
        }
    } else if (action === "getFixInfo") {
        if (entry.location) {
            infoDiv.textContent = entry.location;
        } else {
            infoDiv.remove();
        }
    }
}

// Creates a "Load info" button that fires loadIdentInfo on click, then removes itself.
function makeLoadButton(action, ident, infoDiv, linkElem, onDone) {
    const btn = document.createElement("button");
    btn.textContent = "Load info";
    btn.style.cssText = `
        font-size: 10px; color: #555; background: none; border: none;
        cursor: pointer; padding: 0; text-decoration: underline; text-align: right;
        font-family: inherit;
    `;
    btn.onclick = (e) => {
        e.stopPropagation();
        btn.remove();
        loadIdentInfo(action, ident, infoDiv, linkElem, onDone);
    };
    return btn;
}
function initCallsignSuggestions(root) {
    const input = root.querySelector("#flightInput");
    const toggleBtn = root.querySelector("#suggestionToggle");
    const inputGroup = input.closest(".input-group");
    
    const suggestionBox = document.createElement("div");
    suggestionBox.id = "suggestionBox";
    
    suggestionBox.style.cssText = `
        position: absolute;
        left: 0;
        right: 0;
        top: 100%;
        background: #1a1a1a;
        border: 1px solid #333;
        border-radius: 0 0 6px 6px;
        max-height: 200px;
        overflow-y: auto;
        z-index: 10000;
        display: none;
        box-shadow: 0 8px 16px rgba(0,0,0,0.6);
        margin-top: -2px;
    `;
    
    let isSuggestionBoxOpen = false;
    let userManuallyClosed = false;
    
    if (inputGroup) {
        inputGroup.style.position = "relative";
        inputGroup.appendChild(suggestionBox);
    }

    // Toggle button click handler
    toggleBtn.onclick = (e) => {
        e.stopPropagation();
        isSuggestionBoxOpen = !isSuggestionBoxOpen;
        userManuallyClosed = !isSuggestionBoxOpen;
        updateSuggestionDisplay();
    };

    const updateSuggestionDisplay = () => {
        if (isSuggestionBoxOpen && suggestionBox.children.length > 0) {
            suggestionBox.style.display = "block";
            toggleBtn.textContent = "▲";
        } else {
            suggestionBox.style.display = "none";
            toggleBtn.textContent = "▼";
            isSuggestionBoxOpen = false;
        }
    };

    // Input event handler
    input.addEventListener("input", () => {
        const searchVal = input.value.trim().toUpperCase();
        suggestionBox.innerHTML = "";
        
        // Reset manual close flag when user types new input
        userManuallyClosed = false;
        
        if (searchVal.length < 2) {
            toggleBtn.style.display = "none";
            isSuggestionBoxOpen = false;
            updateSuggestionDisplay();
            return;
        }
        
  // 1. Update the Fuse keys
        const fuse = new Fuse(callsignData, {
            keys: [
                { name: 'callsign', weight: 3 },
                { name: 'identifier', weight: 3 },
                { name: 'airline', weight: 1 }
            ], 
            threshold: 0.3,
            ignoreLocation: true
        });
        const results = fuse.search(searchVal).slice(0, 15);
results.forEach(result => {
            const match = result.item;
            const item = document.createElement("div");
            item.style.cssText = `
                padding: 10px 12px;
                cursor: pointer;
                border-bottom: 1px solid #222;
                font-size: 12px;
                color: #ddd;
                transition: background 0.2s;
            `;
            
            // 1. STRICTLY grab the ICAO code (from identifier or icao field)
            const icaoCode = match.identifier || match.icao || ""; 
            
            // 2. STRICTLY grab the spoken callsign (ignore airline name completely)
            const spokenCallsign = (match.callsign && match.callsign !== "---") ? match.callsign : "";

            // 3. What shows in the dropdown menu (e.g., "BAW SPEEDBIRD")
            item.innerHTML = `<b style="color:var(--accent)">${icaoCode}</b> <span style="color:#888; margin-left:5px;">${spokenCallsign}</span>`;
            
            item.onclick = () => {
                // 4. What gets inserted into your text box when you click it
                input.value = icaoCode; 
                isSuggestionBoxOpen = false;
                updateSuggestionDisplay();
                input.focus();
                input.setSelectionRange(icaoCode.length, icaoCode.length);
            };
            
            item.onmouseenter = () => item.style.background = "var(--accent)";
            item.onmouseleave = () => item.style.background = "transparent";
            
            suggestionBox.appendChild(item);
        });
        // Auto-open if suggestions exist and user hasn't manually closed
        if (suggestionBox.children.length > 0) {
            toggleBtn.style.display = "block";
            if (!userManuallyClosed) {
                isSuggestionBoxOpen = true;
            }
            updateSuggestionDisplay();
        } else {
            toggleBtn.style.display = "none";
            isSuggestionBoxOpen = false;
            updateSuggestionDisplay();
        }
    });

    // Close suggestions when clicking outside
    document.addEventListener("click", (e) => {
        if (!inputGroup.contains(e.target)) {
            isSuggestionBoxOpen = false;
            updateSuggestionDisplay();
        }
    });
}
/* --- Aircraft Data Logic --- */
let aircraftDataCache = null;
async function updateAircraftTab(tailNumber, providedTypeCode = null) {
    const list = shadowRoot.querySelector("#aircraft-list");
    if (!list) return;

    fullAircraftHTML = ""; 
    list.innerHTML = "Syncing aircraft data...";

    const cleanTail = tailNumber.trim().replace(/[\s\-]/g, '').toUpperCase();
    let headerInfo = [];
    let variantResults = new Set();
    
    // Use the provided ICAO code if available, otherwise look for it later
    const _badCodes = new Set(["UNKNOWN", "---", "TYPE", ""]);
    let icaoCode = (providedTypeCode && !_badCodes.has(providedTypeCode.toUpperCase())) ? providedTypeCode.toUpperCase() : "";

    try {
        // 1. Parallel Fetch with allSettled to ensure lookup doesn't die on 404s
        const fetches = await Promise.allSettled([
            bgFetch(`https://www.flightaware.com/resources/registration/${cleanTail}`),
            bgFetch(`https://www.flightaware.com/live/flight/${cleanTail}/history`),
            bgFetch(`https://www.flightaware.com/live/flight/${cleanTail}`),
            lookupAircraftReg(cleanTail)
        ]);

        const regHtml  = fetches[0].status === 'fulfilled' ? fetches[0].value : "";
        const histHtml = fetches[1].status === 'fulfilled' ? fetches[1].value : "";
        const mainHtml = fetches[2].status === 'fulfilled' ? fetches[2].value : "";

        const regDoc = new DOMParser().parseFromString(regHtml, "text/html");
        const histDoc = new DOMParser().parseFromString(histHtml, "text/html");
        const mainDoc = new DOMParser().parseFromString(mainHtml, "text/html");

        const getRegVal = (lbl) => {
            const row = Array.from(regDoc.querySelectorAll('.attribute-row')).find(r => r.innerText.includes(lbl));
            return row ? (row.querySelector('.medium-9')?.innerText || row.querySelector('.medium-3')?.innerText || "").replace(/\s+/g, ' ').trim() : "";
        };

        // --- OWNER: Parse trackpollBootstrap JSON from live page first (covers all registries incl. international)
        let owner = "", ownerLocation = "", ownerType = "";
        const trackpollMatch = mainHtml.match(/var\s+trackpollBootstrap\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
        if (trackpollMatch) {
            try {
                const bootstrap = JSON.parse(trackpollMatch[1]);
                const flights = bootstrap?.flights || {};
                const firstFlight = Object.values(flights)[0];
                const aircraft = firstFlight?.aircraft || {};
                owner = aircraft.owner || "";
                ownerLocation = aircraft.ownerLocation || "";
                ownerType = aircraft.owner_type || "Owner";
            } catch (e) {}
        }
        // Fall back to registration page if live page had nothing
        if (!owner) {
            owner = getRegVal("Owner");
            ownerLocation = getRegVal("Location");
            ownerType = "Owner";
        }

        // Merge local aircraft DB data if FlightAware returned nothing or 'Unknown'
        const osky = fetches[3].status === 'fulfilled' ? fetches[3].value : {};
        const isUnknown = (s) => !s || ["unknown", "---", "private", "blocked", "n/a", "not available"].some(k => s.toLowerCase().includes(k));

        if (isUnknown(owner) && osky.operator) {
            owner = osky.operator;
            ownerType = "Operator";
        }

        const summary = getRegVal("Summary").toUpperCase();
        const airClass = getRegVal("Airworthiness Class");

        // 1. FRONT PAGE INFO (Owner, Aircraft Name/Model, ICAO Type)
        if (owner || ownerLocation) headerInfo.push(`<span style="color:#fff; font-weight:bold;">${ownerType.toUpperCase()}:</span> ${owner}${ownerLocation ? ` | ${ownerLocation}` : ""}`);

        // If owner still unknown, add a direct FR24 link for the registration
        if (isUnknown(owner)) {
            const fr24Reg = tailToReg(cleanTail).toLowerCase();
            const fr24Url = `https://www.flightradar24.com/data/aircraft/${fr24Reg}`;
            headerInfo.push(`<a href="${fr24Url}" target="_blank" style="color:#586bff;font-size:11px;text-decoration:underline;">Look up ${fr24Reg.toUpperCase()} on Flightradar24 ↗</a>`);
        }
        
        const aircraftName = osky.aircraftType || summary;
        if (aircraftName) headerInfo.push(`<span style="color:#fff; font-weight:bold;">AIRCRAFT:</span> ${aircraftName.toUpperCase()}`);
        
        // --- ICAO SCRAPING ---
// 2. SCRAPING FALLBACK: Only run if ADSB didn't give us a code
        if (!icaoCode) {
            const histRows = Array.from(histDoc.querySelectorAll('table.prettyTable tbody tr, .track-details-table tbody tr'));
            for (const row of histRows) {
                const code = row.querySelectorAll('td')[1]?.innerText.trim().toUpperCase();
                if (code && !["UNKNOWN", "---", "TYPE"].includes(code)) { icaoCode = code; break; }
            }
            if (!icaoCode) icaoCode = mainDoc.querySelector('meta[name="aircrafttype"]')?.content?.toUpperCase();
            if (!icaoCode) {
                const scripts = Array.from(mainDoc.querySelectorAll('script'));
                const target = scripts.find(s => s.innerText.includes("setTargeting('aircraft_type'"));
                icaoCode = target?.innerText.match(/'aircraft_type',\s*'([^']+)'/)?.[1]?.toUpperCase();
            }
            if (!icaoCode && osky.icaoType) icaoCode = osky.icaoType;
        }

        if (icaoCode) {
            headerInfo.push(`<span style="color:#fff; font-weight:bold;">ICAO TYPE:</span> ${icaoCode}`);
        }

        // 2. DETAILS SECTION (Collapsible)
        const details = [];
        if (osky.mfr) details.push(`<b>Manufacturer:</b> ${osky.mfr}`);
        if (osky.msn) details.push(`<b>MSN:</b> ${osky.msn}`);
        if (osky.built) details.push(`<b>Built:</b> ${osky.built}`);
        if (osky.category) details.push(`<b>Category:</b> ${osky.category}`);
        if (osky.engines) details.push(`<b>Engines:</b> ${osky.engines}`);
        if (osky.status) details.push(`<b>Status:</b> ${osky.status}`);
        if (airClass) details.push(`<b>Airworthiness:</b> ${airClass}`);

        if (details.length > 0) {
            const detailsHtml = `
                <details style="margin-top: 10px; cursor: pointer; color: #bbb; font-size: 11px; border: 1px solid #333; border-radius: 6px; padding: 6px;">
                    <summary style="font-weight: bold; color: #586bff; outline: none; list-style: none;">▼ SEE MORE DETAILS</summary>
                    <div style="padding-top: 8px; border-top: 1px solid #222; margin-top: 6px; line-height: 1.6; color: #ddd;">
                        ${details.join('<br>')}
                    </div>
                </details>
            `;
            headerInfo.push(detailsHtml);
        }

        // --- JSON LOOKUP (single load, covers both ICAO and summary matches) ---
        if (!aircraftDataCache) {
            aircraftDataCache = await fetch(chrome.runtime.getURL('aircraft_types.json')).then(r => r.json());
        }

        if (aircraftDataCache) {
            const dataArray = Object.values(aircraftDataCache);
            if (icaoCode) {
                dataArray.filter(i => i.icao === icaoCode).forEach(m => m.m.split(' / ').forEach(n => variantResults.add(n)));
            }
            dataArray.filter(i => {
                const regex = new RegExp(`\\b${i.id.replace(/-/g, '\\-?')}\\b`, 'i');
                return regex.test(aircraftName) || i.id === cleanTail;
            }).forEach(m => m.m.split(' / ').forEach(n => variantResults.add(n)));
        }

        // --- BOLDING & SORTING ---
        const boldingWords = aircraftName.split(/[\s/]+/).filter(w => w.length > 1);
        const highPrio = [], standardPrio = [], others = [];

        Array.from(variantResults).forEach(name => {
            let boldedName = name, isNum = false, isMatch = false;
            boldingWords.forEach(word => {
                const cleanWord = word.replace(/-/g, '');
                const pattern = cleanWord.split('').map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\-?').join('');
                const wordRegex = new RegExp(`\\b(${pattern})\\b`, 'gi');
                if (wordRegex.test(name)) {
                    boldedName = boldedName.replace(wordRegex, '<b>$1</b>');
                    isMatch = true;
                    if (/\d/.test(cleanWord)) isNum = true;
                }
            });
            if (isNum) highPrio.push(boldedName); else if (isMatch) standardPrio.push(boldedName); else others.push(boldedName);
        });

        const variantList = [...highPrio, ...standardPrio, ...others];
        fullAircraftHTML = headerInfo.join('<br>');
        if (variantList.length > 0) {
            fullAircraftHTML += '<hr style="border:0; border-top:1px solid #333; margin:10px 0;">' + variantList.join('<br>');
        }
        
        list.innerHTML = fullAircraftHTML || "No data found for: " + cleanTail;
    } catch (e) { list.innerText = "Error loading aircraft data."; }
    saveFroyoState();
}
async function getMarketingNameShim(typeCode) {
    if (!aircraftDataCache) aircraftDataCache = await fetch(chrome.runtime.getURL('aircraft_types.json')).then(r => r.json());
    const match = Object.values(aircraftDataCache).find(item => item.id === typeCode || item.icao === typeCode);
    return match ? match.m.split(' / ')[0] : "";
}
/* --- Utility --- */

// Per-prefix aircraft DB cache — loaded on first lookup for each prefix.
var _regPrefixCache = (typeof _regPrefixCache !== 'undefined') ? _regPrefixCache : {};

async function lookupAircraftReg(tail) {
    const reg = tailToReg(tail);
    // Canadian registrations: use 2-char sub-prefix (CG, CF, CI) so each country
    // gets its own file instead of everything piling into the 9 MB reg_C.json.
    let prefix;
    if (/^N\d/.test(reg)) {
        prefix = 'N';
    } else if (reg.startsWith('C-') && reg.length > 2) {
        prefix = 'C' + reg[2]; // e.g. "C-GAAC" → "CG", "C-FAAC" → "CF"
    } else {
        prefix = reg.slice(0, reg.indexOf('-') > 0 ? reg.indexOf('-') : 2);
    }

    if (_regPrefixCache[prefix] === undefined) {
        try {
            const url = chrome.runtime.getURL(`aircraft_reg/reg_${prefix}.json`);
            const res = await fetch(url);
            if (res.ok) {
                const text = await res.text();
                _regPrefixCache[prefix] = JSON.parse(text);
            } else {
                _regPrefixCache[prefix] = null;
            }
        } catch (e) {
            // leave undefined to allow retry on transient errors
        }
    }

    const entry = _regPrefixCache[prefix]?.[reg] ?? null;
    if (!entry) return {};

    const parts = entry.split('|');
    return {
        icaoType:     parts[0] || '',
        operator:     parts[1] || '',
        aircraftType: parts[2] || '',
        msn:          parts[3] || '',
        built:        parts[4] || '',
        category:     parts[5] || '',
        status:       parts[6] || '',
        mfr:          parts[7] || '',
        engines:      parts[8] || ''
    };
}

// Reconstruct the standard hyphenated registration from a stripped tail number.
// FlightAware strips hyphens (PHCFR → PH-CFR, GBNWA → G-BNWA).
function tailToReg(tail) {
    if (!tail) return "";
    tail = tail.trim().replace(/[\s-]/g, '').toUpperCase();
    
    // US N-numbers: no hyphen
    if (/^N\d/.test(tail)) return tail;

    // 3-character prefixes (C5-, C6-, etc.)
    const threeChar = ["C5", "C6", "D6", "D2", "D4", "XT", "V2", "V3", "V4", "V6", "V7", "V8", "Z2"];
    if (threeChar.some(p => tail.startsWith(p))) {
        return tail.slice(0, 2) + '-' + tail.slice(2);
    }

    // 2-character prefixes
    if (/^(PH|LX|OE|SP|HA|LY|SE|OH|OK|YL|ES|LN|HB|CS|EC|EI|SX|TC|YU|LZ|UR|RA|JY|HZ|AP|A6|A7|VT|VH|ZK|ZS|C9|5Y|ET|SU|CN|5A)/.test(tail)) {
        return tail.slice(0, 2) + '-' + tail.slice(2);
    }

    // Default: 1-letter prefix (G, F, D, I, B, S, C-G, C-F)
    // Handle Canada specifically since it's C-G or C-F
    if (tail.startsWith('CG') || tail.startsWith('CF')) {
        return 'C-' + tail.slice(1);
    }

    return tail[0] + '-' + tail.slice(1);
}

function bgFetch(url) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action: "fetchPage", url }, res => {
            if (!res || res.error) reject(res?.error || `bgFetch failed for: ${url}`);
            else resolve(res.html);
        });
    });
}

async function createOverlay() {
    const isExtensionPage = window.location.protocol === "chrome-extension:";

    // EMERGENCY RESET (only for tab page)
    if (!isExtensionPage) {
        const storedX = parseInt(localStorage.getItem("overlayX"));
        const storedY = parseInt(localStorage.getItem("overlayY"));
        if (storedY < 0 || storedX < 0 || storedX > window.innerWidth) {
            localStorage.setItem("overlayX", "140px");
            localStorage.setItem("overlayY", "140px");
        }

        let host = document.getElementById("flight-route-extension-container");
        if (host) {
            shadowRoot = host.shadowRoot;
            overlay = shadowRoot.querySelector("#flightOverlay");
            overlayVisible = true;
            host.style.display = "block";
            return;
        }
    }

    try {
        const htmlText = await fetch(chrome.runtime.getURL("overlay.html")).then(r => r.text());
        const cssText = await fetch(chrome.runtime.getURL("overlay.css")).then(r => r.text());

        // Create the style element with common CSS and custom overrides
        const style = document.createElement("style");
        style.textContent = cssText + `
    :host, :root, body {
        --bg-main: #121212;
        --bg-surface: #1e1e1e;
        --accent: #492ced;
        --accent-glow: rgba(73, 44, 237, 0.2);
        --text-primary: #e0e0e0;
        --text-secondary: #9e9e9e;
        --border: #2e2e2e;
        --font: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
#overlayBody {
    display: flex;
    flex-direction: column;
    flex: 1;
    overflow-y: auto;
}
    #flightOverlay {
        background: var(--bg-main) !important;
        border: 1px solid var(--border) !important;
        border-radius: 10px !important;
        box-shadow: 0 8px 32px rgba(0,0,0,0.4) !important;
        font-family: var(--font) !important;
        overflow: hidden;
    }

    #overlayHeader {
        background: var(--bg-surface) !important;
        border-bottom: 1px solid var(--border) !important;
        padding: 6px 12px !important;
        font-weight: 600 !important;
        font-size: 11px;
        letter-spacing: 0.3px;
    }

    .tab-bar { 
        display: flex; 
        background: var(--bg-surface); 
        padding: 2px 4px 0 4px;
        gap: 2px;
    }

    .tab-btn { 
        flex: 1;
        padding: 6px 4px;
        cursor: pointer; 
        color: var(--text-secondary); 
        font-size: 10px; 
        border: none; 
        background: none; 
        border-radius: 6px 6px 0 0;
        text-transform: uppercase; 
        font-weight: 700; 
        transition: all 0.15s ease;
    }

    .tab-btn.active::after {
        content: '';
        position: absolute;
        bottom: 0;
        left: 25%;
        right: 25%;
        height: 2px;
        background: var(--accent);
    }

    .tab-pane { 
        display: none; 
        background: var(--bg-main);
    }

    .tab-pane.active { 
        display: block; 
    }

#aircraft-list, #routeOutput { 
    padding: 10px 12px; 
    line-height: 1.4;
}

    .static-search-header { 
        padding: 10px 12px;
        background: var(--bg-main);
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    input[type="text"] {
        background: #222 !important;
        border: 1px solid var(--border) !important;
        border-radius: 4px !important;
        color: #fff !important;
        padding: 5px 8px !important;
        font-size: 12px !important;
    }

    .routeToken {
        border-left: 2px solid transparent;
        margin: 1px 6px;
        padding: 6px 10px !important;
        font-size: 13px;
    }

    .track-data {
        font-size: 10px !important;
        margin-top: 1px !important;
        opacity: 0.8;
    }
`;

        const content = document.createElement("div");
        content.innerHTML = htmlText;
        
        const overlayBody = content.querySelector("#overlayBody");
        const originalBodyHTML = overlayBody.innerHTML;

        overlayBody.innerHTML = `
            <div id="controlsSection" class="static-search-header">${originalBodyHTML}</div>
            
            <div class="tab-bar">
                <button class="tab-btn active" data-target="routes-tab">Route</button>
                <button class="tab-btn" data-target="aircraft-tab">Aircraft</button>
                <button class="tab-btn" data-target="history-tab">History</button>
                <button class="tab-btn" data-target="analyzer-tab">Analysis</button>
            </div>
            
            <div class="input-group" style="padding: 8px 12px 0 12px; background: #121212;">
                <input type="text" id="routeSearch" placeholder="Search" style="width: 100%;">
            </div>

            <div id="routes-tab" class="tab-pane active"><div id="routeOutput"></div></div>
            <div id="aircraft-tab" class="tab-pane"><div id="aircraft-list" style="color: #999;">Search a tail...</div></div>
            <div id="history-tab" class="tab-pane"><div id="history-summary" style="color: #777; font-size:12px;">Fetch a flight to see history.</div></div>
            <div id="analyzer-tab" class="tab-pane">
                <div style="padding: 10px 12px; display: flex; gap: 4px; border-bottom: 1px solid #1e1e1e; flex-shrink: 0;">
                    <input type="text" id="analyzerOrig" placeholder="Orig" style="width: 50px; text-transform: uppercase;">
                    <input type="text" id="analyzerDest" placeholder="Dest" style="width: 50px; text-transform: uppercase;">
                    <button id="analyzerFetchBtn" class="small-btn" style="flex: 1; width: auto; background: var(--accent);">Fetch Analysis</button>
                </div>
                <div id="analyzer-output" style="color: #777; font-size:12px; flex: 1;">
                    <div style="padding: 10px 12px;">Enter orig/dest to fetch...</div>
                </div>
            </div>
        `;

        const searchInput = overlayBody.querySelector("#routeSearch");
        if (searchInput) {
            searchInput.placeholder = "Search";
            searchInput.addEventListener("input", () => applyUniversalFilter(searchInput.value));
        }

        const header = overlayBody.querySelector(".static-search-header");
        const oldOutput = header.querySelector("#routeOutput");
        if (oldOutput) oldOutput.remove();

        overlayBody.querySelectorAll('.tab-btn').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                overlayBody.querySelectorAll('.tab-btn, .tab-pane').forEach(el => el.classList.remove('active'));
                btn.classList.add('active');
                overlayBody.querySelector('#' + btn.dataset.target).classList.add('active');
                if (searchInput) applyUniversalFilter(searchInput.value);
                saveFroyoState();
            };
        });

        if (isExtensionPage) {
            shadowRoot = document;
            
            // Render directly in document body
            document.body.innerHTML = "";
            document.head.appendChild(style);
            // Append the actual Froyo element child from content wrapper div
            document.body.appendChild(content.firstElementChild);

            await loadCallsignData();
            loadInfoCache();
            initCallsignSuggestions(document);

            overlay = document.querySelector("#flightOverlay");
            overlay.classList.add("sidepanel-mode");
            overlayVisible = true;
            chrome.storage.local.set({ lastViewType: "sidepanel" }).catch(() => {});
            
            initOverlay(document);

            // Active tab synchronization
            const syncFromActiveTab = () => {
                chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                    if (tabs[0]) {
                        chrome.tabs.sendMessage(tabs[0].id, { action: "GET_ACTIVE_FLIGHT_DETAILS" }, (response) => {
                            if (response && response.callsign) {
                                const flightInput = document.querySelector("#flightInput");
                                if (flightInput && response.callsign !== flightInput.value) {
                                    flightInput.value = response.callsign;
                                    updateAircraftTab(response.callsign, response.typeCode);
                                    fetchRouteOptions(response.callsign, response.targetDate ? new Date(response.targetDate) : null);
                                }
                            }
                        });
                    }
                });
            };

            syncFromActiveTab();
            chrome.tabs.onActivated.addListener(syncFromActiveTab);
            chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
                if (changeInfo.status === "complete") {
                    syncFromActiveTab();
                }
            });
        } else {
            // Injecting floating overlay on tab webpage
            const host = document.createElement("div");
            host.id = "flight-route-extension-container";
            document.body.appendChild(host);
            
            const shadow = host.attachShadow({ mode: "open" });
            shadowRoot = shadow; 
            shadow.appendChild(style);
            shadow.appendChild(content);

            await loadCallsignData();
            loadInfoCache();
            initCallsignSuggestions(shadow);
            
            overlay = shadow.querySelector("#flightOverlay");
            overlayVisible = true;
            chrome.storage.local.set({ lastViewType: "overlay" }).catch(() => {});
            
            initOverlay(shadow);
        }
    } catch (e) {
        console.error("Overlay failed", e);
    }
}

function triggerFlash(inputElement) {
    inputElement.classList.remove("input-flash");
    // Trigger reflow to allow restarting the animation
    void inputElement.offsetWidth; 
    inputElement.classList.add("input-flash");
    
    // Clean up class after animation ends
    setTimeout(() => {
        inputElement.classList.remove("input-flash");
    }, 600);
}
function initOverlay(root) {
    overlay = root.querySelector("#flightOverlay"); 
    restorePosition();

    // 0. Load persisted Froyo State from storage
    chrome.storage.local.get("froyoState", (data) => {
        if (data && data.froyoState) {
            loadFroyoState(data.froyoState);
        }
    });

    const header = root.querySelector("#overlayHeader");
    const body = root.querySelector("#overlayBody");
    const container = root.querySelector("#flightOverlay");
    
    // 1. DEFINE THESE ONCE HERE
    const datePicker = root.querySelector("#datePicker");
    const timePicker = root.querySelector("#timePicker");
    const timezoneSelect = root.querySelector("#timezoneSelect");
    const textSizeBtn = root.querySelector("#textSizeBtn");

    // 1.5 Setup first install login banner dismiss logic
    const loginBanner = root.querySelector("#loginPromptBanner");
    const closeLoginBtn = root.querySelector("#closeLoginPrompt");
    if (loginBanner && closeLoginBtn) {
        if (localStorage.getItem("hasShownLoginPrompt") === "true") {
            loginBanner.remove();
        } else {
            closeLoginBtn.onclick = (e) => {
                e.stopPropagation();
                loginBanner.remove();
                localStorage.setItem("hasShownLoginPrompt", "true");
            };
            const loginLink = loginBanner.querySelector("a");
            if (loginLink) {
                loginLink.onclick = () => {
                    localStorage.setItem("hasShownLoginPrompt", "true");
                    setTimeout(() => loginBanner.remove(), 1000);
                };
            }
        }
    }

    // 1.7 Setup launch overlay / sidepanel buttons
    const launchOverlayBtn = root.querySelector("#launchOverlayBtn");
    if (launchOverlayBtn) {
        launchOverlayBtn.onclick = (e) => {
            e.stopPropagation();
            chrome.runtime.sendMessage({ action: "LAUNCH_OVERLAY_IN_ACTIVE_TAB" });
            if (window.location.protocol === "chrome-extension:") {
                window.close();
            }
        };
    }

    const launchSidepanelBtn = root.querySelector("#launchSidepanelBtn");
    if (launchSidepanelBtn) {
        launchSidepanelBtn.onclick = (e) => {
            e.stopPropagation();
            // Open sidepanel
            chrome.runtime.sendMessage({ action: "LAUNCH_SIDEPANEL" });
            // Hide the webpage overlay
            const host = document.getElementById("flight-route-extension-container");
            if (host) {
                host.style.display = "none";
                overlayVisible = false;
                saveFroyoState();
            }
        };
    }

    // 1.6 Setup Global Key handlers
    const gkInput = root.querySelector("#gkInput");
    const grabGkBtn = root.querySelector("#grabGkBtn");
    const pasteGKBtn = root.querySelector("#pasteGKBtn");

    if (gkInput) {
        gkInput.addEventListener("input", () => {
            const val = gkInput.value.trim();
            if (val) {
                updateOverlayUI(val);
            }
        });
    }

    if (grabGkBtn) {
        grabGkBtn.onclick = (e) => {
            e.stopPropagation();
            chrome.runtime.sendMessage({ action: "START_GK_GRAB" });
        };
    }

    if (pasteGKBtn) {
        pasteGKBtn.onclick = async (e) => {
            e.stopPropagation();
            try {
                const t = await navigator.clipboard.readText();
                if (t) {
                    updateOverlayUI(t.trim());
                }
            } catch (err) {
                console.error("Paste failed", err);
            }
        };
    }

    const adsbReplayBtn = root.querySelector("#adsbReplayBtn");
    if (adsbReplayBtn) {
        adsbReplayBtn.onclick = (e) => {
            e.stopPropagation();
            const gk = root.querySelector("#gkInput")?.value || "";
            chrome.runtime.sendMessage({ action: "OPEN_ADSB_REPLAY", gk });
        };
    }

    if (timezoneSelect) {
        // Load persisted timezone or default to user local timezone offset
        const persistedOffset = localStorage.getItem("overlayTimezone");
        const localOffset = -new Date().getTimezoneOffset();
        const targetOffset = persistedOffset !== null ? parseInt(persistedOffset, 10) : localOffset;

        let matchFound = false;
        for (let i = 0; i < timezoneSelect.options.length; i++) {
            if (parseInt(timezoneSelect.options[i].value, 10) === targetOffset) {
                timezoneSelect.selectedIndex = i;
                matchFound = true;
                break;
            }
        }
        if (!matchFound) {
            const formatOffset = (minutes) => {
                const sign = minutes >= 0 ? "+" : "-";
                const absMinutes = Math.abs(minutes);
                const hrs = Math.floor(absMinutes / 60);
                const mins = absMinutes % 60;
                const timeStr = mins > 0 ? `${hrs}:${mins.toString().padStart(2, '0')}` : `${hrs}`;
                return `UTC ${sign}${timeStr}`;
            };
            const customOption = document.createElement("option");
            customOption.value = targetOffset;
            customOption.textContent = `${formatOffset(targetOffset)} (Persisted/Local)`;
            customOption.selected = true;
            timezoneSelect.prepend(customOption);
        }

        // Save selected timezone when changed
        timezoneSelect.addEventListener("change", () => {
            localStorage.setItem("overlayTimezone", timezoneSelect.value);
        });
    }

    // Auto-fill date/time inputs if they are empty
    if (datePicker && !datePicker.value) {
        datePicker.value = new Date().toISOString().split('T')[0];
    }
    if (timePicker && !timePicker.value) {
        const now = new Date();
        const hrs = now.getHours().toString().padStart(2, '0');
        const mins = now.getMinutes().toString().padStart(2, '0');
        timePicker.value = `${hrs}:${mins}`;
    }

    // 2. Window Toggle Logic
    header.addEventListener("mouseup", (e) => {
        if (e.target.closest('button') || e.target.closest('a')) return;

        // Disable minimize behavior in sidepanel mode
        if (window.location.protocol === "chrome-extension:") return;

        if (!hasMoved) {
            const isMinimized = body.classList.toggle("hidden");
            container.classList.toggle("minimized", isMinimized);
            
            if (isMinimized) {
                container.style.height = "auto";
            } else {
                const storedH = localStorage.getItem("overlayHeight");
                if (storedH) container.style.height = storedH;
            }
            localStorage.setItem("overlayMinimized", isMinimized);
        }
    });

    // 4. Setup Input Interception
    const inputs = root.querySelectorAll('input[type="text"]');
    inputs.forEach(input => {
        ["keydown", "keyup", "keypress"].forEach(type => {
            input.addEventListener(type, (e) => {
                if (e.key === "Enter" && input.id === "flightInput") {
                    e.preventDefault();
                    root.querySelector("#fetchBtn").click();
                }
                e.stopPropagation();
            }, { capture: true });
        });
    });

    root.querySelector("#closeBtn").onclick = () => { 
        document.getElementById("flight-route-extension-container").style.display = "none"; 
        overlayVisible = false; 
    };

    // 5. Drag and Resize Logic
    root.querySelector("#overlayHeader").addEventListener("mousedown", dragStart);
    
    const resizers = {
        r: root.querySelector('#resizer-r'),
        b: root.querySelector('#resizer-b'),
        rb: root.querySelector('#resizer-rb')
    };

    Object.keys(resizers).forEach(type => {
        const el = resizers[type];
        if (!el) return;
        el.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const rect = overlay.getBoundingClientRect();
            let startW = rect.width, startH = rect.height, startX = e.pageX, startY = e.pageY;

            const resize = (mE) => {
                if (type === 'r' || type === 'rb') {
                    const maxWidth = window.innerWidth - rect.left;
                    const newWidth = startW + (mE.pageX - startX);
                    overlay.style.width = Math.max(180, Math.min(newWidth, maxWidth)) + 'px';
                }
                if (type === 'b' || type === 'rb') {
                    const maxHeight = window.innerHeight - rect.top;
                    const newHeight = startH + (mE.pageY - startY);
                    overlay.style.height = Math.max(100, Math.min(newHeight, maxHeight)) + 'px';
                }
            };
            const stop = () => {
                window.removeEventListener('mousemove', resize);
                window.removeEventListener('mouseup', stop);
                localStorage.setItem("overlayWidth", overlay.style.width);
                localStorage.setItem("overlayHeight", overlay.style.height);
            };
            window.addEventListener('mousemove', resize);
            window.addEventListener('mouseup', stop);
        });
    });

    // 6. Button Listeners
    root.querySelector("#pasteFlightBtn").onclick = async () => {
        try {
            const t = await navigator.clipboard.readText(); 
            const input = root.querySelector("#flightInput");
            if (t) {
                input.value = t.trim().toUpperCase();
                triggerFlash(input);
            }
        } catch (err) { console.error("Paste failed", err); }
    };

    textSizeBtn.onclick = (e) => {
        e.stopPropagation();
        const isLarge = overlay.classList.toggle("large-text");
        localStorage.setItem("overlayLargeText", isLarge);
        textSizeBtn.textContent = isLarge ? "A-" : "A+";
    };

    // SYNC DATE PICKER ON GK INPUT
    root.querySelector("#fetchBtn").onclick = () => {
        // Note: Make sure normalizeFlight is defined somewhere in your scripts! 
        // If it isn't, this line will silently crash the button.
        const rawInput = root.querySelector("#flightInput").value;
        const callsign = typeof normalizeFlight === "function" ? normalizeFlight(rawInput) : rawInput.trim().toUpperCase();
        
        const selectedDate = datePicker.value;
        const selectedTime = timePicker ? timePicker.value : "00:00";
        const selectedTz = timezoneSelect ? parseInt(timezoneSelect.value, 10) : 0;

        if (!callsign) return alert("Enter callsign");

        let targetDate = null;
        if (selectedDate) {
            const [year, month, day] = selectedDate.split("-").map(Number);
            const [hours, minutes] = (selectedTime || "00:00").split(":").map(Number);
            targetDate = new Date(Date.UTC(year, month - 1, day, hours, minutes));
            if (isNaN(targetDate.getTime())) {
                return alert("Invalid Date/Time selected");
            }
            if (!isNaN(selectedTz)) {
                targetDate.setUTCMinutes(targetDate.getUTCMinutes() - selectedTz);
            }
        }

        // TRIGGER THE AIRCRAFT TAB IMMEDIATELY
        updateAircraftTab(callsign);

        fetchRouteOptions(callsign, targetDate);
    };
// Inside initOverlay(root) in content.js
const toggleBtn = root.querySelector("#toggleControlsBtn");
const controls = root.querySelector("#controlsSection");

// Restore saved state from localStorage
const isCollapsed = localStorage.getItem("overlayControlsCollapsed") === "true";
if (isCollapsed && toggleBtn && controls) {
    controls.style.display = "none";
    toggleBtn.textContent = "▼";
}

if (toggleBtn) {
    toggleBtn.onclick = (e) => {
        e.stopPropagation();
        const isHidden = controls.style.display === "none";
        controls.style.display = isHidden ? "flex" : "none";
        toggleBtn.textContent = isHidden ? "▲" : "▼";
        localStorage.setItem("overlayControlsCollapsed", !isHidden);
    };
}

// ... existing code below ...
root.querySelector("#prevFlight").onclick = () => navigateFlight(-1);
    root.querySelector("#nextFlight").onclick = () => navigateFlight(1);

	shadowRoot.querySelector("#clearBtn").onclick = () => {
	    shadowRoot.querySelector("#flightInput").value = "";
	    const gkInput = shadowRoot.querySelector("#gkInput");
	    if (gkInput) gkInput.value = "";
	    const searchBar = shadowRoot.querySelector("#routeSearch");
	    if (searchBar) searchBar.value = "";

	    if (datePicker) datePicker.value = "";
	    if (timePicker) timePicker.value = "";
	    if (timezoneSelect) {
	        const persistedOffset = localStorage.getItem("overlayTimezone");
	        const localOffset = -new Date().getTimezoneOffset();
	        const targetOffset = persistedOffset !== null ? parseInt(persistedOffset, 10) : localOffset;
	        for (let i = 0; i < timezoneSelect.options.length; i++) {
	            if (parseInt(timezoneSelect.options[i].value, 10) === targetOffset) {
	                timezoneSelect.selectedIndex = i;
	                break;
	            }
	        }
	    }

	    shadowRoot.querySelector("#routeOutput").innerHTML = "";
	    const aircraftList = shadowRoot.querySelector("#aircraft-list");
	    if (aircraftList) {
	        aircraftList.innerHTML = "Search a tail...";
	        fullAircraftHTML = ""; // Reset the cache
	    }

	    const historySummary = shadowRoot.querySelector("#history-summary");
	    if (historySummary) historySummary.innerHTML = `<span style="color:#777; padding: 10px 12px; display:block;">Fetch a flight to see history.</span>`;

	    shadowRoot.querySelector("#depDateHeader").style.color = "var(--accent)";
	    lastTargetDate = null; 

	    // Reset View on FA link
	    const faLink = shadowRoot.querySelector("#faLink");
	    if (faLink) {
	        faLink.href = "#";
	        faLink.style.opacity = "0.5";
	        faLink.title = "Fetch a flight to view on FlightAware";
	    }

	    updateArrows();
	    applyUniversalFilter(""); 
	};

    const nowBtn = root.querySelector("#nowBtn");
    if (nowBtn) {
        nowBtn.onclick = (e) => {
            e.stopPropagation();
            const datePicker = root.querySelector("#datePicker");
            const timePicker = root.querySelector("#timePicker");
            const timezoneSelect = root.querySelector("#timezoneSelect");
            
            if (datePicker && timePicker) {
                const now = new Date();
                const tzOffset = timezoneSelect ? parseInt(timezoneSelect.value, 10) : 0;
                const targetTime = new Date(now.getTime() + (tzOffset * 60 * 1000));
                
                const y = targetTime.getUTCFullYear();
                const m = String(targetTime.getUTCMonth() + 1).padStart(2, '0');
                const d = String(targetTime.getUTCDate()).padStart(2, '0');
                
                const hrs = String(targetTime.getUTCHours()).padStart(2, '0');
                const mins = String(targetTime.getUTCMinutes()).padStart(2, '0');
                
                datePicker.value = `${y}-${m}-${d}`;
                timePicker.value = `${hrs}:${mins}`;
                
                triggerFlash(datePicker);
                triggerFlash(timePicker);
                saveFroyoState();
            }
        };
    }

    root.querySelector("#analyzerFetchBtn").onclick = async () => {
        const orig = root.querySelector("#analyzerOrig").value.trim().toUpperCase();
        const dest = root.querySelector("#analyzerDest").value.trim().toUpperCase();
        if (!orig || !dest) return alert("Enter both origin and destination");
        
        const out = root.querySelector("#analyzer-output");
        out.innerHTML = "<div style='padding: 10px 12px;'>Fetching analysis...</div>";
        
        const url = `https://www.flightaware.com/analysis/route.rvt?origin=${orig}&destination=${dest}`;
        try {
            const html = await bgFetch(url);
            const tokens = parseRouteAnalysis(html);
            if (!tokens || tokens.length === 0) {
                out.innerHTML = "<div style='padding: 10px 12px;'>No routes found or unable to parse.</div>";
            } else {
                renderRoute(tokens, out);
            }
        } catch (e) {
            out.innerHTML = `<div style='padding: 10px 12px; color: red;'>Error fetching analysis: ${e.message}</div>`;
        }
    };

    root.addEventListener("click", (e) => {
        if (e.target && e.target.tagName === "BUTTON") {
            const text = e.target.textContent.trim().toUpperCase();
            
            // 1. "Analyze Route" button at top of route output
            if (text.startsWith("ANALYZE") && text.includes("→")) {
                const match = text.match(/ANALYZE\s+([A-Z0-9]+)\s*→\s*([A-Z0-9]+)/i);
                if (match) {
                    e.stopPropagation();
                    triggerRouteAnalysis(match[1].toUpperCase(), match[2].toUpperCase());
                    return;
                }
            }

            // 2. History pair "Analyze" button
            if (text === "ANALYZE") {
                const parent = e.target.closest("#history-summary > div") || e.target.parentNode?.parentNode;
                if (parent) {
                    const airportRows = parent.querySelectorAll(".routeToken");
                    if (airportRows.length >= 2) {
                        e.stopPropagation();
                        const orig = airportRows[0].getAttribute("data-copy") || airportRows[0].innerText.trim();
                        const dest = airportRows[1].getAttribute("data-copy") || airportRows[1].innerText.trim();
                        triggerRouteAnalysis(orig.toUpperCase(), dest.toUpperCase());
                        return;
                    }
                }
            }
        }
    });
}
function formatMonthDDYYYY(dStr) {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${months[parseInt(dStr.slice(4, 6), 10) - 1]} ${dStr.slice(6, 8)} ${dStr.slice(0, 4)}`;
}
function findFlightCandidates(html, gk, flightNum) {
    const timeGroups = new Map();
    const doc = new DOMParser().parseFromString(html, "text/html");
    
    // Target the history table rows
    const rows = doc.querySelectorAll('table.prettyTable tbody tr, .track-details-table tbody tr');
    
    rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length < 4) return;

        // Column 0: Date/Link, Column 1: Aircraft Type, Column 2: Origin, Column 3: Dest
        const link = cells[0].querySelector('a[href*="/history/"]');
        if (!link) return;

        const href = link.getAttribute('href');
        const match = href.match(/history\/(\d{8})\/(\d{4}Z)\/([A-Z0-9]{3,4})\/([A-Z0-9]{3,4})/i);
        
        if (match) {
            const d = match[1], t = match[2].toUpperCase(), orig = match[3].toUpperCase(), dest = match[4].toUpperCase();
            // Capture aircraft type from the second column (index 1)
            const typeCode = cells[1].textContent.trim().toUpperCase();
            
            const ts = Date.UTC(
                parseInt(d.slice(0, 4)), 
                parseInt(d.slice(4, 6)) - 1, 
                parseInt(d.slice(6, 8)), 
                parseInt(t.slice(0, 2)), 
                parseInt(t.slice(2, 4))
            );
            
            const hour = Math.floor(ts / 3600000);
            if (!timeGroups.has(hour)) timeGroups.set(hour, []);
            
            // Build the absolute URL properly
            let fullUrl = href;
            if (!fullUrl.startsWith("http")) {
                fullUrl = "https://www.flightaware.com" + (fullUrl.startsWith("/") ? "" : "/") + fullUrl;
            }
            if (!fullUrl.endsWith("/route")) {
                fullUrl = fullUrl.replace(/\/$/, "") + "/route";
            }

            timeGroups.get(hour).push({ 
                timeLabel: t, 
                dateLabel: formatMonthDDYYYY(d), 
                diff: Math.abs(ts - (gk ? gk.getTime() : Date.now())), 
                timestamp: ts, 
                url: fullUrl, 
                orig, 
                dest,
                aircraftType: typeCode // Store the type here
            });
        }
    });

    const final = [];
    timeGroups.forEach(entries => {
        const main = entries.sort((a,b) => a.diff - b.diff)[0];
        if (entries.length > 1) { 
            const twin = entries.find(e => e.dest !== main.dest); 
            if (twin) main.intended = twin.dest; 
        }
        final.push(main);
    });
    return final.sort((a,b) => a.timestamp - b.timestamp);
}

function buildHistorySummary(html) {
    const container = shadowRoot?.querySelector("#history-summary");
    if (!container) return;

    const doc = new DOMParser().parseFromString(html, "text/html");
    const rows = Array.from(doc.querySelectorAll("table.prettyTable tbody tr, .track-details-table tbody tr"));

    const pairCounts = new Map();
    let earliestDateText = null;

    rows.forEach(row => {
        const cells = row.querySelectorAll("td");
        if (cells.length < 4) return;

const extractIcao = (text) => {
            // Target the last 3 to 4 alphanumeric characters right before the final parenthesis
            const m = text.trim().match(/([A-Z0-9]{3,4})\)$/);
            if (m) return m[1].toUpperCase();
            
            // Ultimate fallback: strip out all invalid CSS characters so querySelector can never crash
            return text.replace(/[^A-Z0-9]/gi, '').toUpperCase();
        };

        const orig = extractIcao(cells[2].textContent);
        const dest = extractIcao(cells[3].textContent);
        if (!orig || !dest) return;

        // Track earliest date — last row with a date cell is the oldest
        const dateTxt = cells[0].textContent.trim();
        if (dateTxt) earliestDateText = dateTxt;

        const key = `${orig}|||${dest}`;
        pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
    });

    if (pairCounts.size === 0) {
        container.innerHTML = `<span style="color:#777; padding:10px 12px; display:block;">No route pairs found.</span>`;
        return;
    }

    const sorted = [...pairCounts.entries()].sort((a, b) => b[1] - a[1]);
    const totalFlights = rows.filter(r => r.querySelectorAll("td").length >= 4).length;

    // Header
    container.innerHTML = "";
    const header = document.createElement("div");
    header.style.cssText = "font-size:10px; color:#555; font-weight:700; letter-spacing:0.4px; padding:8px 12px 6px 12px; text-transform:uppercase; border-bottom:1px solid #1e1e1e;";
    header.textContent = earliestDateText
        ? `${totalFlights} flights since ${earliestDateText}`
        : `${totalFlights} flights`;
    container.appendChild(header);

    sorted.forEach(([key, count]) => {
        const [orig, dest] = key.split("|||");

        const pairWrapper = document.createElement("div");
        pairWrapper.style.cssText = "border-bottom: 1px solid #1e1e1e; padding: 2px 0;";

        const badge = document.createElement("div");
        badge.style.cssText = "font-size: 10px; color: #555; font-weight: 700; letter-spacing: 0.4px; padding: 6px 12px 2px 12px; text-transform: uppercase; display: flex; justify-content: space-between; align-items: center;";

        const countSpan = document.createElement("span");
        countSpan.textContent = `${count}×`;
        badge.appendChild(countSpan);

        const analyzeBtn = document.createElement("button");
        analyzeBtn.className = "analyze-hist-btn";
        analyzeBtn.dataset.orig = orig;
        analyzeBtn.dataset.dest = dest;
        analyzeBtn.textContent = "Analyze";
        analyzeBtn.style.cssText = "background: rgba(73,44,237,0.25); border: 1px solid rgba(73,44,237,0.5); color: #9b8fff; border-radius: 3px; padding: 2px 7px; font-size: 9px; cursor: pointer; font-weight: 600; letter-spacing: 0.3px; text-transform: uppercase;";
        analyzeBtn.onclick = (e) => { e.stopPropagation(); triggerRouteAnalysis(orig, dest); };
        badge.appendChild(analyzeBtn);

        pairWrapper.appendChild(badge);

        [orig, dest].forEach(ident => {
            const row = document.createElement("div");
            row.className = "routeToken type-airport";
            row.style.position = "relative";

            const airportRowId = `hist-${ident}-${Math.floor(Math.random() * 10000)}`;
            const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(ident + " airport")}`;
            row.setAttribute("data-copy", ident);

            row.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: flex-start; width: 100%; gap: 10px;">
                    <div style="display: flex; flex-direction: column;">
                        <div>
                            <a id="link-${airportRowId}" href="${googleUrl}" target="_blank" style="font-weight: normal; color: #586bff; text-decoration: none;">${ident}</a>
                        </div>
                    </div>
                    <div id="${airportRowId}" class="selectable-info" style="font-size: 11px; color: #777; text-align: right;"></div>
                </div>
            `;

            const infoDiv = row.querySelector(`#${airportRowId}`);
            const linkElem = row.querySelector(`#link-${airportRowId}`);
            infoDiv.dataset.ident = ident;
            infoDiv.dataset.action = "getAirportInfo";

loadIdentInfo("getAirportInfo", ident, infoDiv, linkElem, null);

            row.onclick = async (e) => {
                if (e.target.tagName === "A" || e.target.tagName === "BUTTON") return;
                try {
                    await navigator.clipboard.writeText(ident);
                    row.classList.add("copied");
                    setTimeout(() => row.classList.remove("copied"), 1000);
                } catch (err) {}
            };

            pairWrapper.appendChild(row);
        });

        container.appendChild(pairWrapper);
    });
}

function triggerRouteAnalysis(orig, dest) {
    console.log("[Froyo] triggerRouteAnalysis called. Orig:", orig, "Dest:", dest);
    const root = shadowRoot || document.getElementById("flight-route-extension-container")?.shadowRoot;
    console.log("[Froyo] Resolved root:", root);
    if (!root) {
        console.error("[Froyo] Error: root is null or undefined!");
        return;
    }

    // Pre-fill the analyzer fields
    const origInput = root.querySelector("#analyzerOrig");
    const destInput = root.querySelector("#analyzerDest");
    console.log("[Froyo] origInput:", origInput, "destInput:", destInput);
    if (origInput) origInput.value = orig;
    if (destInput) destInput.value = dest;

    // Switch to the Analysis tab
    const tabButtons = root.querySelectorAll('.tab-btn, .tab-pane');
    console.log("[Froyo] tabButtons/panes count:", tabButtons.length);
    tabButtons.forEach(el => el.classList.remove('active'));
    
    const analyzerTab = root.querySelector('#analyzer-tab');
    const analyzerBtn = root.querySelector('.tab-btn[data-target="analyzer-tab"]');
    console.log("[Froyo] analyzerTab:", analyzerTab, "analyzerBtn:", analyzerBtn);
    if (analyzerTab) analyzerTab.classList.add('active');
    if (analyzerBtn) analyzerBtn.classList.add('active');

    // Fire the fetch
    const fetchBtn = root.querySelector("#analyzerFetchBtn");
    console.log("[Froyo] fetchBtn:", fetchBtn);
    if (fetchBtn) {
        console.log("[Froyo] Clicking fetchBtn...");
        fetchBtn.click();
    } else {
        console.error("[Froyo] Error: fetchBtn not found!");
    }
}

async function fetchRouteOptions(flight, gkDate) {
    const out = shadowRoot.querySelector("#routeOutput");
    if (!flight) return;
    
    lastFetchedCallsign = flight;
    lastTargetDate = gkDate; // Save the date for comparison
    shadowRoot.querySelector("#depDateHeader").style.color = "#586bff"; // Reset to blue
    // ... rest of function
    
    // 1. Reset state for new flight search
    flightCandidates = [];
    currentFlightIndex = 0;

    // 2. Reset header text to placeholders
    shadowRoot.querySelector("#depDateHeader").textContent = "DATE";
    shadowRoot.querySelector("#depTimeHeader").textContent = "0000Z";
    
    // Reset View on FA link in footer
    const faLink = shadowRoot.querySelector("#faLink");
    if (faLink) {
        faLink.href = "#";
        faLink.style.opacity = "0.5";
        faLink.title = "Fetch a flight to view on FlightAware";
    }

    updateArrows();

    out.innerHTML = "Fetching...";
    
    const isNNumber = flight.match(/^N[0-9]{1,5}[A-Z]{0,2}$/) && flight.length <= 6;
    const livePageUrl = `https://www.flightaware.com/live/flight/${flight}`;

    try {
        let mainPageHtml = await bgFetch(livePageUrl);
        
        // Use the gkDate passed from the button click instead of looking at gkInput again
        let historyHtml = await bgFetch(`https://www.flightaware.com/live/flight/${flight}/history/500`);
        let candidates = findFlightCandidates(historyHtml, gkDate, flight);
        buildHistorySummary(historyHtml);
        // ... (rest of your existing logic) ...     
        if (candidates.length === 0) {
            candidates = findFlightCandidates(mainPageHtml, gkDate, flight);
        }

        if (candidates.length === 0) {
            if (mainPageHtml.includes("couldn't find flight tracking data for")) {
                out.innerHTML = `<div class="routeToken">NO HISTORY FOUND</div>`;
            } else {
                // 2. Updated error message (removed "any")
                out.innerHTML = `
                    <div class="routeToken" style="flex-direction: column; align-items: flex-start; gap: 5px;">
                        <span style="color: #ffa657;">Unable to parse route history.</span>
                        <a href="${livePageUrl}" target="_blank" style="text-decoration: underline; font-size: 11px;">Check live page manually</a>
                    </div>`;
            }
        } else {
    flightCandidates = candidates;
    
    // 1. Find the absolute closest match
    const bestMatchIndex = flightCandidates.findIndex(
        c => c.diff === Math.min(...flightCandidates.map(o => o.diff))
    );

    // Fallback to latest if findIndex somehow fails
    const safeIndex = bestMatchIndex === -1 ? flightCandidates.length - 1 : bestMatchIndex;
    const bestMatch = flightCandidates[safeIndex];
    const oneDayMs = 24 * 60 * 60 * 1000;

    // 2. Check if the "best" match is more than 24 hours away from the target date
    if (gkDate && bestMatch.diff > oneDayMs) {
        const dateSource = "target date";

        // Non-blocking in-overlay confirmation banner
        out.innerHTML = `
            <div class="routeToken" style="flex-direction: column; align-items: flex-start; gap: 8px;">
                <span style="color: #ffa657;">Flight not found for ${dateSource}.</span>
                <span style="color: #aaa; font-size: 11px;">Closest found: <b style="color:#e0e0e0;">${bestMatch.dateLabel}</b></span>
                <div style="display:flex; gap:8px; margin-top:2px;">
                    <button id="confirmShowClosest" style="background:var(--accent); color:#fff; border:none; border-radius:4px; padding:4px 12px; cursor:pointer; font-size:11px;">Show closest</button>
                    <button id="cancelClosest" style="background:#333; color:#aaa; border:none; border-radius:4px; padding:4px 12px; cursor:pointer; font-size:11px;">Cancel</button>
                </div>
            </div>`;

        out.querySelector("#confirmShowClosest").onclick = async () => {
            currentFlightIndex = safeIndex;
            await loadSpecificRoute(flightCandidates[currentFlightIndex]);
        };
        out.querySelector("#cancelClosest").onclick = () => {
            out.innerHTML = `<div class="routeToken" style="color: #f85149;">Search cancelled.</div>`;
        };
        return; // Wait for user to click
    }

    currentFlightIndex = safeIndex;
    await loadSpecificRoute(flightCandidates[currentFlightIndex]);
}

} catch (e) { 
        out.innerHTML = `
            <div class="routeToken" style="flex-direction: column; align-items: flex-start; gap: 5px;">
                <span style="color: #f85149; font-weight: bold;">Crash in fetchRouteOptions:</span>
                <span style="color: #aaa; font-size: 11px;">${e.toString()}</span>
                <span style="color: #aaa; font-size: 10px;">${e.stack || ""}</span>
                <a href="${livePageUrl}" target="_blank" style="text-decoration: underline; font-size: 11px; margin-top: 5px;">Check live page manually</a>
            </div>`;
        if (isNNumber) updateAircraftTab(flight);
    }
}
async function loadSpecificRoute(candidate) {
    const out = shadowRoot.querySelector("#routeOutput");
    const regPanel = shadowRoot.querySelector(".registration-panel");
    const liveUrl = candidate.url.replace(/\/route$/, "");
    
    out.innerHTML = "Loading route...";
    if (regPanel) out.prepend(regPanel);

    shadowRoot.querySelector("#depDateHeader").textContent = candidate.dateLabel;
    shadowRoot.querySelector("#depTimeHeader").textContent = candidate.timeLabel;

    if (lastTargetDate) {
        const diffMs = Math.abs(candidate.timestamp - lastTargetDate.getTime());
        const oneDayMs = 24 * 60 * 60 * 1000;
        shadowRoot.querySelector("#depDateHeader").style.color = (diffMs > oneDayMs) ? "#f85149" : "#586bff";
    }
    
    const faLink = shadowRoot.querySelector("#faLink");
    if (faLink) {
        faLink.href = liveUrl;
        faLink.style.opacity = "1";
        faLink.title = "View this specific flight on FlightAware";
    }

    updateArrows();
    try {
        const trackLogUrl = candidate.url.replace('/route', '/tracklog');
        
        const [routeHtml, trackHtml] = await Promise.all([
            bgFetch(candidate.url),
            bgFetch(trackLogUrl)
        ]);

        let tokens = parseRoutePage(routeHtml);
        const trackLog = parseTrackLog(trackHtml);

        tokens.forEach(token => {
            const match = findClosestTrackPoint(token, trackLog);
            if (match) {
                token.actualAlt = match.alt;
                token.actualSpeed = match.speed;
            }
        });

        const urlParts = candidate.url.split('/');
        const actualDest = urlParts[urlParts.length - 2].toUpperCase();
        const orig = urlParts[urlParts.length - 3].toUpperCase();

        tokens = tokens.filter(t => t.ident.toUpperCase() !== orig && t.ident.toUpperCase() !== actualDest);
        tokens.unshift({ ident: orig, type: "airport" });
        tokens.push({ ident: actualDest, type: "airport" });

        if (candidate.intended && candidate.intended.toUpperCase() !== actualDest) {
            tokens.push({ 
                ident: candidate.intended.toUpperCase(), 
                isDiverted: true, 
                type: "airport" 
            });
        }

        lastFetchedTokens = tokens; 
        renderRoute(tokens);

        // Inject "Analyze Route" button at top of route output
        const routeOut = shadowRoot.querySelector("#routeOutput");
        const analyzeRouteBtn = document.createElement("button");
        analyzeRouteBtn.className = "analyze-route-btn";
        analyzeRouteBtn.dataset.orig = orig;
        analyzeRouteBtn.dataset.dest = actualDest;
        analyzeRouteBtn.textContent = `Analyze ${orig} → ${actualDest}`;
        analyzeRouteBtn.style.cssText = "display:block; width:calc(100% - 24px); margin: 8px 12px 4px 12px; padding: 5px 10px; background: rgba(73, 44, 237, 0.2); border: 1px solid rgba(73, 44, 237, 0.4); color: #9b8fff; border-radius: 4px; cursor: pointer; font-size: 11px; font-weight: 600; letter-spacing: 0.3px; text-align: center; text-transform: uppercase;";
        analyzeRouteBtn.onclick = () => triggerRouteAnalysis(orig, actualDest);
        routeOut.insertBefore(analyzeRouteBtn, routeOut.firstChild);

        const callsign = shadowRoot.querySelector("#flightInput")?.value.trim().toUpperCase();
        if (callsign) updateAircraftTab(callsign, candidate.aircraftType || null);

    } catch (e) { 
        // Diagnostic error catching
        out.innerHTML = `
            <div class="routeToken" style="flex-direction: column; align-items: flex-start; gap: 5px;">
                <span style="color: #f85149; font-weight: bold;">Crash in loadSpecificRoute:</span>
                <span style="color: #aaa; font-size: 11px;">${e.toString()}</span>
                <span style="color: #aaa; font-size: 10px;">${e.stack}</span>
            </div>`;
        if (regPanel) out.prepend(regPanel); 
    }
}
function renderRoute(tokens, targetElement = null) {
    const root = shadowRoot || document.getElementById("flight-route-extension-container")?.shadowRoot;
    if (!root) return;

    const showTrack = true;

    const out = targetElement || root.querySelector("#routeOutput"); 
    const regPanel = targetElement ? null : root.querySelector(".registration-panel");
    const typePanel = targetElement ? null : root.querySelector(".aircraft-type-panel");

    out.innerHTML = "";

    if (regPanel) {
        out.appendChild(regPanel);
        if (typePanel) typePanel.remove();
    } else if (typePanel) {
        out.appendChild(typePanel);
    }
   
    // Check if route has a US connection (ICAO starting with K or P)
    const origIdent = tokens.length > 0 ? tokens[0].ident.toUpperCase() : "";
    const destIdent = tokens.length > 0 ? tokens[tokens.length - 1].ident.toUpperCase() : "";
    const isUSRoute = /^[KP]/.test(origIdent) || /^[KP]/.test(destIdent);

    tokens.forEach(item => {
        if (item.ident) item.ident = item.ident.replace(/\+/g, '');

        const row = document.createElement("div"); 
        row.className = "routeToken";
        row.style.position = "relative";
        
        const isProc = /\d/.test(item.ident) && (item.ident.length > 4 || item.ident.includes('.'));
        const isNavaid = (item.ident.length === 2 || item.ident.length === 3) && !/\d/.test(item.ident);
        const isAirport = item.type === "airport" || item.ident.startsWith("NEAR") || ((item.ident.length === 3 || item.ident.length === 4) && !isNavaid && !isProc);
        
        const text = (typeof sidStarWords === "function") ? sidStarWords(item.ident).toUpperCase() : item.ident.toUpperCase();
        row.setAttribute("data-copy", text);
        
        if (item.freq && item.maxFreq) {
            const ratio = Math.max(0.1, item.freq / item.maxFreq);
            row.classList.add("freq-token");
            row.style.backgroundColor = `rgba(73, 44, 237, ${ratio})`;
            row.style.borderBottom = '1px solid rgba(0,0,0,0.2)';
            
            // Add a badge for frequency
            const freqBadge = document.createElement("div");
            freqBadge.style.cssText = "position:absolute; right:12px; top:50%; transform:translateY(-50%); font-size:10px; color:#fff; opacity:0.8; font-weight:bold;";
            freqBadge.textContent = `${item.freq}×`;
            row.appendChild(freqBadge);
        }

        const trackInfo = (showTrack && item.actualAlt && item.actualSpeed) 
            ? `<div class="track-data" style="color: #586bff; font-size: 12px; margin-top: 2px; font-weight: normal; font-family: monospace;">${item.actualAlt} FT @ ${item.actualSpeed} KTS</div>` 
            : "";
// --- BRANCH: AIRPORT ---
        if (isAirport) {
            row.classList.add("type-airport");
            const ident = item.ident.toUpperCase();
            const airportRowId = `info-${ident}-${Math.floor(Math.random() * 10000)}`;
            const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(ident + " airport")}`;
            const diversionLabel = item.isDiverted ? `<span style="color: #f85149; font-weight: bold; margin-left: 8px;">(DIVERTED FROM)</span>` : "";

            row.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: flex-start; width: 100%; gap: 10px;">
                    <div style="display: flex; flex-direction: column;">
                        <div>
                            <a id="link-${airportRowId}" href="${googleUrl}" target="_blank" style="font-weight: normal; color: #586bff; text-decoration: none;">${ident}</a>
                            ${diversionLabel}
                        </div>
                        ${trackInfo}
                    </div>                    <div id="${airportRowId}" class="selectable-info" style="font-size: 11px; color: #777; text-align: right;"></div>
                </div>
            `;

            const infoDiv = row.querySelector(`#${airportRowId}`);
            const linkElem = row.querySelector(`#link-${airportRowId}`);
            const onDone = () => { const q = root.querySelector("#routeSearch")?.value; if (q) applyUniversalFilter(q); };

            infoDiv.dataset.ident = ident;
            infoDiv.dataset.action = "getAirportInfo";

            // Unconditionally auto-load, no buttons
            loadIdentInfo("getAirportInfo", ident, infoDiv, linkElem, onDone);
        }
// --- BRANCH: NAVAID ---
        else if (isNavaid) {
            row.classList.add("type-navaid");
            const ident = item.ident.toUpperCase();
            const nameId = `nav-name-${ident}`;
            const locId = `nav-loc-${ident}`;
            
            row.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: flex-start; width: 100%; gap: 10px;">
                    <div style="display: flex; flex-direction: column;">
                        <div style="display: flex; align-items: center;">
                            <span style="font-weight: normal; color: #586bff;">${ident}</span>
                            <span id="${nameId}" style="color: #888; margin-left: 5px; font-size: 12px; font-weight: normal;"></span>
                        </div>
                        ${trackInfo}
                    </div>
                    <div id="${locId}" class="selectable-info" style="font-size: 11px; color: #777; text-align: right;"></div>
                </div>
            `;

            const nameSpan = row.querySelector(`#${nameId}`);
            const locDiv = row.querySelector(`#${locId}`);
            const onDone = () => { const q = root.querySelector("#routeSearch")?.value; if (q) applyUniversalFilter(q); };

            // MUST be set for broadcastInfoResult to find the element
            locDiv.dataset.ident = ident;
            locDiv.dataset.action = "getNavaidName";

            // Instantly auto-load ALL navaids from local data (bypassing AirNav buttons)
            loadIdentInfo("getNavaidName", ident, locDiv, nameSpan, onDone);
        }
        // --- BRANCH: FIX ---
        else {
            row.classList.add("type-fix");
            const ident = item.ident.toUpperCase();
            const fixId = `fix-loc-${ident}-${Math.floor(Math.random() * 10000)}`;
            
            row.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: flex-start; width: 100%; gap: 10px;">
                    <div style="display: flex; flex-direction: column;">
                        <span style="color: #ddd;">${text}</span>
                        ${trackInfo}
                    </div>
                    <div id="${fixId}" class="selectable-info" style="font-size: 11px; color: #777; text-align: right;"></div>
                </div>
            `;

            const isCoordinate = /\d{2,4}[NS].*\d{3,5}[EW]/i.test(ident);
            if (isUSRoute && !isCoordinate) {
                const locDiv = row.querySelector(`#${fixId}`);
                locDiv.dataset.ident = ident;
                locDiv.dataset.action = "getFixInfo";
                const onDone = () => { const q = root.querySelector("#routeSearch")?.value; if (q) applyUniversalFilter(q); };

                if (infoCache[ident]) {
                    loadIdentInfo("getFixInfo", ident, locDiv, null, onDone);
                } else {
                    locDiv.appendChild(makeLoadButton("getFixInfo", ident, locDiv, null, onDone));
                }
            }
        }

        // --- ROW ACTIONS ---
        row.onclick = async (e) => { 
            if (e.target.tagName === "A" || e.target.tagName === "BUTTON") return;
            try {
                await navigator.clipboard.writeText(row.getAttribute("data-copy")); 
                row.classList.add("copied"); 
                setTimeout(() => row.classList.remove("copied"), 1000); 
            } catch (err) {}
        };

        out.appendChild(row);

    }); // <--- LOOP ENDS HERE

    if (!targetElement) {
        const currentQuery = root.querySelector("#routeSearch")?.value.toUpperCase();
        if (currentQuery) applyUniversalFilter(currentQuery);
    } else {
        const currentQuery = root.querySelector("#routeSearch")?.value.toUpperCase();
        if (currentQuery) applyUniversalFilter(currentQuery);
    }
    saveFroyoState();
}

function updateArrows() {
    const prev = shadowRoot.querySelector("#prevFlight"), 
          next = shadowRoot.querySelector("#nextFlight");
    
    // Force arrows to remain visible
    prev.style.display = next.style.display = "inline";
    
    // Disable (grey out) if no candidates exist or if at the bounds of the list
    prev.disabled = (flightCandidates.length === 0 || currentFlightIndex === 0);
    next.disabled = (flightCandidates.length === 0 || currentFlightIndex === flightCandidates.length - 1);
}
function navigateFlight(dir) {
    const newIdx = currentFlightIndex + dir;
    if (newIdx >= 0 && newIdx < flightCandidates.length) {
        currentFlightIndex = newIdx;
        loadSpecificRoute(flightCandidates[currentFlightIndex]);
    }
}

function dragStart(e) {
    if (e.target.closest('button') || e.target.closest('a')) return;

    hasMoved = false; // Reset the flag every time a click starts
    const rect = overlay.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left; 
    dragOffsetY = e.clientY - rect.top;
    
    document.addEventListener("mousemove", dragMove);
    document.addEventListener("mouseup", dragEnd);
}

function dragMove(e) {
    hasMoved = true; // If the mouse moves at all, it's now a drag, not a click
    
    let newX = e.clientX - dragOffsetX;
    let newY = e.clientY - dragOffsetY;

    const rect = overlay.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width;
    const maxY = window.innerHeight - rect.height;

    newX = Math.max(0, Math.min(newX, maxX));
    newY = Math.max(0, Math.min(newY, maxY));

    overlay.style.left = newX + "px";
    overlay.style.top = newY + "px";
}
function restorePosition() { 
    let x = localStorage.getItem("overlayX") || "140px";
    let y = localStorage.getItem("overlayY") || "140px"; 
    const w = localStorage.getItem("overlayWidth");
    const h = localStorage.getItem("overlayHeight");
    const isSidepanel = window.location.protocol === "chrome-extension:";
    const isMinimized = !isSidepanel && localStorage.getItem("overlayMinimized") === "true";
    const isLargeText = localStorage.getItem("overlayLargeText") === "true"; // Add this
    
    overlay.style.left = x; 
    overlay.style.top = y; 
    if(w) overlay.style.width = w;

    // Restore Text Size
    if (isLargeText) {
        overlay.classList.add("large-text");
        const btn = shadowRoot.querySelector("#textSizeBtn");
        if (btn) btn.textContent = "A-";
    }

    if (isMinimized) {
        overlay.querySelector("#overlayBody").classList.add("hidden");
        overlay.classList.add("minimized");
        overlay.style.height = "auto";
    } else {
        if(h) overlay.style.height = h;
    }
}
/* --- Global Keyboard Interceptor --- */
// Blocks host webpage shortcuts while overlay is active, but allows typing
['keydown', 'keyup', 'keypress'].forEach(evt => {
    window.addEventListener(evt, (e) => {
        // Only proceed if the overlay is actually visible
        if (!overlayVisible || !shadowRoot) return;

        // 2. Check if focus is inside a text box in your Shadow DOM overlay
        const shadowActive = shadowRoot.activeElement;
        const isShadowInput = shadowActive && (
            shadowActive.tagName === "INPUT" || 
            shadowActive.tagName === "TEXTAREA" || 
            shadowActive.isContentEditable
        );

        if (isShadowInput) {
            // Stop propagation so the host page doesn't see the key event.
            // (Due to shadow DOM retargeting, the host page sees the target as a DIV,
            // which causes its shortcut manager to wrongly execute the shortcut).
            e.stopPropagation();
            
            // Handle internal Enter key logic since we stopped propagation
            if (evt === 'keydown' && e.key === "Enter" && shadowActive.id === "flightInput") {
                e.preventDefault();
                const fetchBtn = shadowRoot.querySelector("#fetchBtn");
                if (fetchBtn) fetchBtn.click();
            }
            return;
        }

        // For the general overlay blocking logic, we only care about keydown
        if (evt !== 'keydown') return;

        // 1. Modifier Bypass: Let system/browser shortcuts (Ctrl+C, Shift+Tab, etc.) pass
        if (e.ctrlKey || e.metaKey || e.shiftKey) {
            return;
        }

        // 3. Check if focus is inside a text box on the main webpage
        const pageActive = document.activeElement;
        const isPageInput = pageActive && (
            pageActive.tagName === "INPUT" || 
            pageActive.tagName === "TEXTAREA" || 
            pageActive.isContentEditable
        );

        // 4. Selective blocking logic
        if (isPageInput) {
            // If the user is actively typing in a page input field, do nothing
            return;
        } else {
            // If no input is focused, stop the event so the webpage doesn't 
            // trigger its own shortcuts (like 'S' for search or 'L' for log)
            e.stopPropagation();
        }
    }, true); // The 'true' ensures we capture the event before the site scripts do
});
function dragEnd() {
    document.removeEventListener("mousemove", dragMove);
    document.removeEventListener("mouseup", dragEnd);
    
    // Only save the position if we actually moved it
    if (hasMoved) {
            localStorage.setItem("overlayX", overlay.style.left);
            localStorage.setItem("overlayY", overlay.style.top);
        }
    }


function applyUniversalFilter(query) {
    const root = shadowRoot || document.getElementById("flight-route-extension-container")?.shadowRoot;
    if (!root) return;
    
    const rawQuery = query.trim();
    
    // If query is empty, show everything and stop
    if (!rawQuery) {
        root.querySelectorAll(".routeToken, #aircraft-list br, #aircraft-list span").forEach(el => {
            if (el.classList) el.classList.remove("filtered-out");
            el.style.display = ""; 
        });
        // Restore all history pair wrappers
        root.querySelectorAll("#history-summary > div").forEach(el => el.style.display = "");
        return;
    }

    const isAircraftTab = root.querySelector('button[data-target="aircraft-tab"]').classList.contains('active');
    const isHistoryTab = root.querySelector('button[data-target="history-tab"]')?.classList.contains('active');

    if (isAircraftTab) {
        const list = root.querySelector("#aircraft-list");
        if (!list || !fullAircraftHTML) return;
        
        const lines = fullAircraftHTML.split(/<br>|<hr[^>]*>/g);
        
        const fuse = new Fuse(lines, {
            threshold: 0.4,
            ignoreLocation: true 
        });

        const results = fuse.search(rawQuery);
        const matchedLines = results.map(r => r.item);
        list.innerHTML = matchedLines.join('<br>');

    } else if (isHistoryTab) {
        // --- HISTORY TAB FILTERING ---
        // Filter at pairWrapper level — hide the whole pair if neither airport matches
        const pairWrappers = Array.from(root.querySelectorAll("#history-summary > div"));

        pairWrappers.forEach(wrapper => {
            const tokens = Array.from(wrapper.querySelectorAll(".routeToken"));
            if (!tokens.length) return; // skip the header div

            const searchData = tokens.map((el, index) => ({
                text: el.innerText.replace(/\s+/g, ' ').trim(),
                index
            }));

            const fuse = new Fuse(searchData, {
                keys: ["text"],
                threshold: 0.4,
                ignoreLocation: true
            });

            const matched = new Set(fuse.search(rawQuery).map(r => r.item.index));

            tokens.forEach((token, index) => {
                token.classList.toggle("filtered-out", !matched.has(index));
            });

            wrapper.style.display = tokens.some((_, i) => matched.has(i)) ? "" : "none";
        });

    } else {
        // --- ROUTES TAB FILTERING ---
        const items = Array.from(root.querySelectorAll(".routeToken"));
        
        const searchData = items.map((el, index) => ({
            text: el.innerText.replace(/\s+/g, ' ').trim(),
            index: index
        }));

        const fuse = new Fuse(searchData, {
            keys: ["text"],
            threshold: 0.4,
            distance: 100,
            ignoreLocation: true
        });

        const results = fuse.search(rawQuery);
        const matchedIndices = new Set(results.map(r => r.item.index));

        items.forEach((item, index) => {
            item.classList.toggle("filtered-out", !matchedIndices.has(index));
        });
    }
}


/* --- ADSB Integration Logic (The Bridge) --- */
if (window.location.hostname.includes("adsbexchange.com")) {
    // 1. Inject the hook into the ADSB page context
    if (!window.__adsbHookInjected) {
        const s = document.createElement("script");
        s.src = chrome.runtime.getURL("adsb_hook.js");
        s.onload = () => s.remove();
        (document.head || document.documentElement).appendChild(s);
        window.__adsbHookInjected = true;
    }

    // 2. Relay the message to background.js
    window.addEventListener("message", (event) => {
        // Safety check: ensure the message is from our hook
        if (event.source !== window || !event.data || event.data.source !== "adsb_hook") return;
        
        // Forward the entire data object (Callsign + TypeCode) to the background
        chrome.runtime.sendMessage(event.data);
    });
}
function normalizeFlight(flight) {
    if (!flight) return "";
    // Removes spaces and hyphens, and makes it uppercase
    return flight.trim().replace(/[\s-]/g, '').toUpperCase();
}

function findArchiveKeyOnPage() {
    // Matches patterns like ZBW-CCC1-Jun-30-2026-0000Z or similar LiveATC key formats
    const regex = /([A-Za-z0-9-]+)-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-([0-9]{1,2})-([0-9]{4})-([0-9]{4})Z/i;
    
    // 1. Scan links (hrefs)
    const links = document.querySelectorAll("a");
    for (const link of links) {
        const href = link.href;
        const match = href.match(regex);
        if (match) return match[0];
    }
    
    // 2. Scan audio source tags
    const sources = document.querySelectorAll("source, audio");
    for (const src of sources) {
        const url = src.src;
        const match = url.match(regex);
        if (match) return match[0];
    }

    // 3. Scan specific elements likely to contain archive filenames or info
    const elements = document.querySelectorAll("td, div, span, p, b, strong, a, font");
    for (const el of elements) {
        if (el.children.length === 0) {
            const text = el.innerText.trim();
            const match = text.match(regex);
            if (match) return match[0];
        }
    }

    // 4. Scan whole body text (fallback)
    const bodyText = document.body.innerText;
    const bodyMatch = bodyText.match(regex);
    if (bodyMatch) return bodyMatch[0];

    return null;
}

function updateOverlayUI(text) {
    if (!shadowRoot) return;
    const gkInput = shadowRoot.querySelector("#gkInput");
    const datePicker = shadowRoot.querySelector("#datePicker");
    const timePicker = shadowRoot.querySelector("#timePicker");
    const timezoneSelect = shadowRoot.querySelector("#timezoneSelect");
    const flightInput = shadowRoot.querySelector("#flightInput");

    if (gkInput && gkInput.value !== text) {
        gkInput.value = text;
        triggerFlash(gkInput);
    }

    // Parse date & time from the key
    const date = parseGlobalKeyDate(text);
    if (date && !isNaN(date.getTime())) {
        if (datePicker) {
            const y = date.getUTCFullYear();
            const m = String(date.getUTCMonth() + 1).padStart(2, '0');
            const d = String(date.getUTCDate()).padStart(2, '0');
            datePicker.value = `${y}-${m}-${d}`;
            triggerFlash(datePicker);
        }
        if (timePicker) {
            const hrs = String(date.getUTCHours()).padStart(2, '0');
            const mins = String(date.getUTCMinutes()).padStart(2, '0');
            timePicker.value = `${hrs}:${mins}`;
            triggerFlash(timePicker);
        }
        if (timezoneSelect) {
            timezoneSelect.value = "0"; // Set to UTC
            localStorage.setItem("overlayTimezone", "0");
            triggerFlash(timezoneSelect);
        }
    }
    saveFroyoState();
}

function saveFroyoState() {
    if (isSyncing || !shadowRoot) return;
    
    const callsign = shadowRoot.querySelector("#flightInput")?.value || "";
    const gk = shadowRoot.querySelector("#gkInput")?.value || "";
    const date = shadowRoot.querySelector("#datePicker")?.value || "";
    const time = shadowRoot.querySelector("#timePicker")?.value || "";
    const timezone = shadowRoot.querySelector("#timezoneSelect")?.value || "0";
    const search = shadowRoot.querySelector("#routeSearch")?.value || "";
    
    const routeOutputHTML = shadowRoot.querySelector("#routeOutput")?.innerHTML || "";
    const aircraftListHTML = shadowRoot.querySelector("#aircraft-list")?.innerHTML || "";
    const historySummaryHTML = shadowRoot.querySelector("#history-summary")?.innerHTML || "";
    
    // Find active tab
    let activeTabName = "routes-tab";
    const activeTab = shadowRoot.querySelector(".tab-btn.active");
    if (activeTab) {
        activeTabName = activeTab.dataset.target;
    }

    const state = {
        callsign,
        gk,
        date,
        time,
        timezone,
        search,
        routeOutputHTML,
        aircraftListHTML,
        historySummaryHTML,
        activeTabName,
        timestamp: Date.now()
    };

    isSyncing = true;
    chrome.storage.local.set({ froyoState: state }, () => {
        isSyncing = false;
    });
}

function loadFroyoState(state) {
    if (!state || !shadowRoot) return;
    
    isSyncing = true;

    const flightInput = shadowRoot.querySelector("#flightInput");
    if (flightInput && flightInput.value !== state.callsign) {
        flightInput.value = state.callsign;
    }

    const gkInput = shadowRoot.querySelector("#gkInput");
    if (gkInput && gkInput.value !== state.gk) {
        gkInput.value = state.gk;
    }

    const datePicker = shadowRoot.querySelector("#datePicker");
    if (datePicker && datePicker.value !== state.date) {
        datePicker.value = state.date;
    }

    const timePicker = shadowRoot.querySelector("#timePicker");
    if (timePicker && timePicker.value !== state.time) {
        timePicker.value = state.time;
    }

    const timezoneSelect = shadowRoot.querySelector("#timezoneSelect");
    if (timezoneSelect && timezoneSelect.value !== state.timezone) {
        timezoneSelect.value = state.timezone;
    }

    const routeSearch = shadowRoot.querySelector("#routeSearch");
    if (routeSearch && routeSearch.value !== state.search) {
        routeSearch.value = state.search;
    }

    const routeOutput = shadowRoot.querySelector("#routeOutput");
    if (routeOutput && routeOutput.innerHTML !== state.routeOutputHTML) {
        routeOutput.innerHTML = state.routeOutputHTML;
    }

    const aircraftList = shadowRoot.querySelector("#aircraft-list");
    if (aircraftList && aircraftList.innerHTML !== state.aircraftListHTML) {
        aircraftList.innerHTML = state.aircraftListHTML;
    }

    const historySummary = shadowRoot.querySelector("#history-summary");
    if (historySummary && historySummary.innerHTML !== state.historySummaryHTML) {
        historySummary.innerHTML = state.historySummaryHTML;
    }

    // Restore active tab
    if (state.activeTabName) {
        const tabBtn = shadowRoot.querySelector(`.tab-btn[data-target="${state.activeTabName}"]`);
        const tabPane = shadowRoot.querySelector(`#${state.activeTabName}`);
        if (tabBtn && tabPane) {
            shadowRoot.querySelectorAll('.tab-btn, .tab-pane').forEach(el => el.classList.remove('active'));
            tabBtn.classList.add('active');
            tabPane.classList.add('active');
        }
    }

    // Apply search filter if search is active
    if (state.search) {
        applyUniversalFilter(state.search);
    }

    isSyncing = false;
}

// Global listener for sync changes across views
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.froyoState && !isSyncing) {
        loadFroyoState(changes.froyoState.newValue);
    }
});

// Auto-initialize if running in the sidepanel extension context
if (window.location.protocol === "chrome-extension:" && window.location.pathname.endsWith("sidepanel.html")) {
    if (document.readyState === "loading") {
        window.addEventListener("DOMContentLoaded", () => createOverlay());
    } else {
        createOverlay();
    }
}
