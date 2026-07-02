function parseCoordinate(ident) {
    const match = ident.match(/^(\d{2,4})([NS])\/?(\d{3,5})([EW])$/i);
    if (!match) return null;

    let latDeg = 0;
    const latStr = match[1];
    if (latStr.length === 4) {
        latDeg = parseInt(latStr.slice(0, 2), 10) + parseInt(latStr.slice(2, 4), 10) / 60;
    } else if (latStr.length === 2) {
        latDeg = parseInt(latStr, 10);
    } else {
        return null;
    }
    if (match[2].toUpperCase() === 'S') latDeg = -latDeg;

    let lonDeg = 0;
    const lonStr = match[3];
    if (lonStr.length === 5) {
        lonDeg = parseInt(lonStr.slice(0, 3), 10) + parseInt(lonStr.slice(3, 5), 10) / 60;
    } else if (lonStr.length === 3) {
        lonDeg = parseInt(lonStr, 10);
    } else {
        return null;
    }
    if (match[4].toUpperCase() === 'W') lonDeg = -lonDeg;

    return { lat: latDeg, lon: lonDeg };
}

function parseRoutePage(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    let fixes = [];

    // 1. Extract the raw route string
    let rawRouteString = "";
    const routeHeader = doc.querySelector(".prettyTable thead th[colspan]");
    if (routeHeader) {
        rawRouteString = routeHeader.textContent.trim();
    } 
    
    if (!rawRouteString) {
        const bodyText = doc.body.innerText || doc.body.textContent;
        const match = bodyText.match(/Unable to decode route\s*\(([^)]+)\)/i);
        if (match && match[1]) {
            rawRouteString = match[1].trim();
        }
    }

    // 2. Parse speed/altitude and coordinates from the raw route string
    const rawRouteSpeeds = {};
    if (rawRouteString) {
        const rawTokens = rawRouteString.split(/\s+/);
        rawTokens.forEach(rawText => {
            if (!rawText.trim()) return;
            
            let ident = rawText.toUpperCase();
            let speed = null;
            let alt = null;

            // Extract compound speed/altitude blocks (e.g., BORLI/N0456F340 or 4200N/02000W/N0456F340)
            if (ident.includes('/')) {
                const parts = ident.split('/');
                const lastPart = parts[parts.length - 1];
                const isPerf = /^(?:[NM]\d{3,4}F\d{3}|[NMF]\d{3,4})$/i.test(lastPart);
                if (isPerf) {
                    const perfMatch = lastPart.match(/([NM])(\d{3,4})F(\d{3})/i);
                    if (perfMatch) {
                        speed = perfMatch[1].toUpperCase() === 'M' 
                            ? "M0." + parseInt(perfMatch[2], 10).toString()
                            : parseInt(perfMatch[2], 10).toString();
                        alt = (parseInt(perfMatch[3], 10) * 100).toString();
                    } else {
                        const speedMatch = lastPart.match(/[NM](\d{3,4})/i);
                        if (speedMatch) speed = parseInt(speedMatch[1], 10).toString();
                        const altMatch = lastPart.match(/F(\d{3})/i);
                        if (altMatch) alt = (parseInt(altMatch[1], 10) * 100).toString();
                    }
                    ident = parts.slice(0, -1).join('/');
                }
            } 
            else if (/^N\d{4}F\d{3}$/.test(ident)) {
                const perfMatch = ident.match(/^N(\d{4})F(\d{3})$/);
                speed = parseInt(perfMatch[1], 10).toString();
                alt = (parseInt(perfMatch[2], 10) * 100).toString();
            }

            if (ident !== "DCT" && ident.trim()) {
                rawRouteSpeeds[ident] = { speed, alt };
            }
        });
    }

    // 3. Build the list of fixes from the table if it exists
    const rows = doc.querySelectorAll(".prettyTable tbody tr, .track-details-table tbody tr");
    if (rows.length > 0) {
        rows.forEach(r => {
            const cells = r.querySelectorAll("td");
            if (cells.length >= 3) {
                const ident = cells[0].textContent.trim().toUpperCase();
                if (!ident) return;

                let lat = parseFloat(cells[1].textContent);
                let lon = parseFloat(cells[2].textContent);
                if (isNaN(lat) || isNaN(lon)) {
                    const parsedCoord = parseCoordinate(ident);
                    if (parsedCoord) {
                        lat = parsedCoord.lat;
                        lon = parsedCoord.lon;
                    } else {
                        lat = null;
                        lon = null;
                    }
                }

                // Check type from cells[7] if present
                let type = "fix";
                if (cells.length >= 8) {
                    const typeText = cells[7].textContent.trim().toLowerCase();
                    if (typeText.includes("airport")) {
                        type = "airport";
                    }
                }

                // Match with speed/altitude from raw route string if available
                const speedAlt = rawRouteSpeeds[ident] || { speed: null, alt: null };

                fixes.push({
                    ident: ident,
                    type: type,
                    lat: lat,
                    lon: lon,
                    actualSpeed: speedAlt.speed,
                    actualAlt: speedAlt.alt
                });
            }
        });
    } else if (rawRouteString) {
        // Fallback: Process every token in the original sequence
        const rawTokens = rawRouteString.split(/\s+/);
        rawTokens.forEach(rawText => {
            if (!rawText.trim()) return;
            
            let ident = rawText.toUpperCase();
            let speed = null;
            let alt = null;

            if (ident.includes('/')) {
                const parts = ident.split('/');
                const lastPart = parts[parts.length - 1];
                const isPerf = /^(?:[NM]\d{3,4}F\d{3}|[NMF]\d{3,4})$/i.test(lastPart);
                if (isPerf) {
                    const perfMatch = lastPart.match(/([NM])(\d{3,4})F(\d{3})/i);
                    if (perfMatch) {
                        speed = perfMatch[1].toUpperCase() === 'M' 
                            ? "M0." + parseInt(perfMatch[2], 10).toString()
                            : parseInt(perfMatch[2], 10).toString();
                        alt = (parseInt(perfMatch[3], 10) * 100).toString();
                    } else {
                        const speedMatch = lastPart.match(/[NM](\d{3,4})/i);
                        if (speedMatch) speed = parseInt(speedMatch[1], 10).toString();
                        const altMatch = lastPart.match(/F(\d{3})/i);
                        if (altMatch) alt = (parseInt(altMatch[1], 10) * 100).toString();
                    }
                    ident = parts.slice(0, -1).join('/');
                }
            } 
            else if (/^N\d{4}F\d{3}$/.test(ident)) {
                const perfMatch = ident.match(/^N(\d{4})F(\d{3})$/);
                speed = parseInt(perfMatch[1], 10).toString();
                alt = (parseInt(perfMatch[2], 10) * 100).toString();
            }

            if (ident === "DCT") return;

            let lat = null;
            let lon = null;
            const parsedCoord = parseCoordinate(ident);
            if (parsedCoord) {
                lat = parsedCoord.lat;
                lon = parsedCoord.lon;
            }

            fixes.push({
                ident: ident,
                type: "fix",
                lat: lat,
                lon: lon,
                actualSpeed: speed,
                actualAlt: alt
            });
        });
    }

    return fixes;
}
function parseTrackLog(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const trackData = [];
    const table = doc.querySelector(".prettyTable") || doc.querySelector(".track-details-table");
    
    if (table) {
        const rows = table.querySelectorAll("tbody tr");
        rows.forEach(r => {
            const cells = r.querySelectorAll("td");
            
            // Skip header/summary rows (like the 4-cell rows you found)
            if (cells.length < 8) return;

            const lat = parseFloat(cells[1].textContent.trim());
            const lon = parseFloat(cells[2].textContent.trim());
            
            // This regex finds the number WITH commas (e.g., "33,000") 
            // and ignores the hidden sorting number (e.g., "33000")
// Inside parseTrackLog(html) in parser.js
const findFormattedNum = (cell) => {
    if (!cell) return "";

    // 1. Get the raw text
    let text = (typeof cell === 'string') ? cell.trim() : cell.textContent.trim();

    // 2. If we have the DOM element, try to remove the hidden sort value
    if (typeof cell !== 'string') {
        const sortSpan = cell.querySelector('[class*="sort"]'); 
        if (sortSpan) {
            text = text.replace(sortSpan.textContent, '').trim();
        }
    }

    // 3. SAFETY FALLBACK: If the number is doubled (e.g., "500500") and has no comma
    // This regex looks for a sequence of digits that repeats exactly twice
    const doubledMatch = text.match(/^(\d+)\1$/);
    if (doubledMatch && !text.includes(',')) {
        return doubledMatch[1];
    }

    // 4. Prioritize numbers with commas (e.g., "33,000")
    const commaMatch = text.match(/\d{1,3}(,\d{3})+/);
    if (commaMatch) return commaMatch[0];

    // 5. Final fallback for simple digits
    const simpleMatch = text.match(/\d+/);
    return simpleMatch ? simpleMatch[0] : "";
};

// --- CRITICAL: UPDATE THESE CALL SITES ---
// Ensure you REMOVE ".textContent" so the actual element is passed
const speedValue = findFormattedNum(cells[4]); 
const altValue = findFormattedNum(cells[6]);

            if (!isNaN(lat) && !isNaN(lon) && (speedValue || altValue)) {
                trackData.push({
                    lat: lat,
                    lon: lon,
                    alt: altValue,
                    speed: speedValue
                });
            }
        });
    }
    return trackData;
}

function parseRouteAnalysis(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const componentFreqs = {}; 
    
    const headers = Array.from(doc.querySelectorAll("th.mainHeader"));
    const summaryHeader = headers.find(th => th.textContent.includes("Route Analysis Summary"));
    
    if (summaryHeader) {
        const table = summaryHeader.closest("table");
        if (table) {
            const rows = table.querySelectorAll("tbody tr, tr");
            rows.forEach(tr => {
                const tds = tr.querySelectorAll("td");
                if (tds.length >= 5) {
                    const freqText = tds[0].textContent.trim();
                    const freq = parseInt(freqText, 10);
                    if (!isNaN(freq)) {
                        const routeCell = tds[4];
                        const routeLink = routeCell.querySelector("a");
                        const routeString = routeLink ? routeLink.textContent.trim() : routeCell.textContent.trim();
                        
                        const components = routeString.split(/\s+/).filter(c => c);
                        components.forEach(c => {
                            componentFreqs[c] = (componentFreqs[c] || 0) + freq;
                        });
                    }
                }
            });
        }
    }
    
    const sorted = Object.entries(componentFreqs).map(([ident, freq]) => ({ ident, freq })).sort((a, b) => b.freq - a.freq);
    const maxFreq = sorted.length > 0 ? sorted[0].freq : 1;
    sorted.forEach(item => {
        item.maxFreq = maxFreq;
        item.type = "fix"; 
    });
    return sorted;
}