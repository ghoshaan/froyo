function normalizeFlight(input) {
    return input.replace(/\s+/g, "").toUpperCase();
}

function parseGlobalKeyDate(gk) {
    const months = {
        Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
        Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11
    };

    // 1. New Compact Format: SJC-20260410061831_5_VAD_v2.wav (YYYYMMDDHHMMSS)
    // Pattern: anything-YYYYMMDDHHMMSS_
    const compactMatch = gk.match(/-(\d{14})_/);
    if (compactMatch) {
        const dateStr = compactMatch[1];
        return new Date(Date.UTC(
            dateStr.slice(0, 4),           // Year
            parseInt(dateStr.slice(4, 6)) - 1,  // Month (0-indexed)
            dateStr.slice(6, 8),           // Day
            dateStr.slice(8, 10),          // Hour
            dateStr.slice(10, 12),         // Minute
            dateStr.slice(12, 14)          // Second
        ));
    }

    // 2. Original Pattern: Jan-31-2026-1430Z
    const fullMatch = gk.match(/([A-Z][a-z]{2})-(\d{2})-(\d{4})-(\d{4})Z/);
    if (fullMatch) {
        return new Date(Date.UTC(
            fullMatch[3], months[fullMatch[1]], fullMatch[2],
            fullMatch[4].slice(0, 2), fullMatch[4].slice(2)
        ));
    }

    // 3. Numerical Pattern: 2026-12-28-13-48
    const numericMatch = gk.match(/(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/);
    if (numericMatch) {
        return new Date(Date.UTC(
            numericMatch[1], // Year
            parseInt(numericMatch[2]) - 1, // Month (0-indexed)
            numericMatch[3], // Day
            numericMatch[4], // Hour
            numericMatch[5]  // Minute
        ));
    }

    // 4. Fallback: Jan-31-2026 (No time)
    const dateOnlyMatch = gk.match(/([A-Z][a-z]{2})-(\d{2})-(\d{4})/);
    if (dateOnlyMatch) {
        return new Date(Date.UTC(dateOnlyMatch[3], months[dateOnlyMatch[1]], dateOnlyMatch[2], 0, 0, 0));
    }

}

function parseGlobalKeyFacility(gk) {
    if (!gk) return null;
    // Look for the month name followed by -day-year-timeZ
    const match = gk.match(/^(.*?)-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-/i);
    if (match) {
        return match[1]; // e.g. "ZBW-CCC1"
    }
    // Also support compact pattern: e.g. SJC-20260410061831_...
    const compactMatch = gk.match(/^(.*?)-\d{14}_/);
    if (compactMatch) {
        return compactMatch[1]; // e.g. "SJC"
    }
    return null;
}

function sidStarWords(fix) {
    if (!fix) return "";
    
    const words = {
        1: "one", 2: "two", 3: "three", 4: "four", 5: "five",
        6: "six", 7: "seven", 8: "eight", 9: "nine"
    };

    // 1. Maintain transition logic (e.g., YOSE3.NTELL -> yose three ntell)
    if (fix.includes('.')) {
        const parts = fix.split('.');
        return `${sidStarWords(parts[0])} ${parts[1].toLowerCase()}`;
    }

    // 2. Fix expansion logic (e.g., BRUSR1 -> brusr one)
    // This regex looks for letters followed by a single digit at the end
    const match = fix.match(/^([A-Z]+)(\d)$/i);
    if (match) {
        const name = match[1].toLowerCase();
        const num = match[2];
        return `${name} ${words[num] || num}`;
    }

    return fix.toLowerCase();
}
function findClosestTrackPoint(waypoint, trackLog) {
    if (!waypoint.lat || !waypoint.lon || !trackLog || trackLog.length === 0) return null;
    let closest = null;
    let minDistance = Infinity;

    trackLog.forEach(point => {
        const dist = Math.sqrt(Math.pow(point.lat - waypoint.lat, 2) + Math.pow(point.lon - waypoint.lon, 2));
        if (dist < minDistance) {
            minDistance = dist;
            closest = point;
        }
    });
    return closest;
}