// adsb_hook.js

if (location.hostname.includes("adsbexchange.com")) {

  if (window.__adsbStoreHook) {
    console.log("ADSB hook already installed");
  } else {

    window.__adsbStoreHook = true;

    console.log("ADS-B aircraft URL hook installed");

    let lastIcao = null;
// adsb_hook.js
function detectAircraft() {
    try {
        const params = new URLSearchParams(location.search);
        const icaoHex = params.get("icao");
        if (!icaoHex) return;

        const cleanHex = icaoHex.toLowerCase();
        
        // FIX: Update lastIcao IMMEDIATELY to prevent the loop
        if (cleanHex !== lastIcao) {
            lastIcao = cleanHex; 

            setTimeout(() => {
                let callsign = null;
                let typeCode = null;
                
                try {
                    let planes = (typeof selectedPlanes === "function") ? selectedPlanes() : [];
                    if (!planes || !planes.length) {
                        if (typeof SelPlanes !== "undefined" && SelPlanes.length) planes = SelPlanes;
                    }

                    if (planes && planes.length) {
                        const p = planes[0];
                        callsign = p.flight || p.callsign || p.t || null;
                        typeCode = p.t || p.type || p.icaoType || null;

                        if (!typeCode && p.desc) {
                            const firstWord = p.desc.split(' ')[0];
                            if (firstWord.length >= 2 && firstWord.length <= 4) typeCode = firstWord;
                        }
                    }
                } catch (e) {}

                if (callsign && callsign.trim()) {
                    window.postMessage({
                        source: "adsb_hook",
                        type: "ADSB_AIRCRAFT_SELECTED",
                        callsign: callsign.trim(),
                        typeCode: typeCode ? typeCode.trim().toUpperCase() : null
                    }, "*");
                }
            }, 100); 
        }
    } catch (e) {}
}
    const origRAF = window.requestAnimationFrame;

    window.requestAnimationFrame = function(fn){

      return origRAF.call(this,function(){

        detectAircraft();

        return fn.apply(this,arguments);

      });

    };

    // 🔥 CRITICAL: run once immediately after load
    setTimeout(detectAircraft, 1000);

  }

}