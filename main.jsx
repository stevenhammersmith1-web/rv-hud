import React from "react";
import { createRoot } from "react-dom/client";
import RVDashboard from "./rv_dashboard.jsx";

// No StrictMode: it double-invokes effects in dev, which would tear down and
// re-open the Web Bluetooth connection on every mount. The BLE hook manages
// its own lifecycle, so we mount it once.
createRoot(document.getElementById("root")).render(<RVDashboard />);
