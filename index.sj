// file: index.js
"use strict";

const PLUGIN_ID = "signalk-path-outage-monitor";
const PLUGIN_NAME = "Path outage monitor (per-path timeouts)";

module.exports = function (app) {
  let unsubscribes = [];
  let checkTimer = null;

  // Per path we track:
  // {
  //   path: string,
  //   timeoutMs: number,
  //   lastUpdate: number|null,
  //   inOutage: boolean,
  //   outageStart: number|null
  // }
  let monitors = [];

  function start(props) {
    stop(); // in case of restart

    monitors = (props.monitors || [])
      .filter(m => m && typeof m.path === "string" && m.path.length > 0)
      .map(m => ({
        path: m.path,
        timeoutMs: (m.timeoutSeconds || 0) * 1000,
        lastUpdate: null,
        inOutage: false,
        outageStart: null
      }));

    if (monitors.length === 0) {
      app.debug(`${PLUGIN_ID}: no monitors configured`);
      return;
    }

    // Subscribe to each path via streambundle
    monitors.forEach(mon => {
      try {
        const stream = app.streambundle.getSelfStream(mon.path);
        const unsub = stream.onValue(v => {
          const now = Date.now();
          // If we were in outage, this ends it
          if (mon.inOutage) {
            const durationMs = now - (mon.outageStart || now);
            app.error(
              `${PLUGIN_ID}: RECOVERED path=${mon.path} outage=${(durationMs / 1000).toFixed(
                1
              )}s`
            );
            mon.inOutage = false;
            mon.outageStart = null;
          }
          mon.lastUpdate = now;
        });
        unsubscribes.push(unsub);
      } catch (e) {
        app.error(`${PLUGIN_ID}: failed to subscribe to ${mon.path}: ${e.message || e}`);
      }
    });

    // Periodic check for timeouts
    checkTimer = setInterval(checkTimeouts, 1000);
  }

  function stop() {
    unsubscribes.forEach(u => {
      try {
        u && u();
      } catch (e) {}
    });
    unsubscribes = [];
    if (checkTimer) {
      clearInterval(checkTimer);
      checkTimer = null;
    }
    monitors = [];
  }

  function checkTimeouts() {
    const now = Date.now();
    monitors.forEach(mon => {
      if (!mon.timeoutMs || mon.timeoutMs <= 0) return;
      if (mon.lastUpdate == null) {
        // Never seen any data; treat as outage only once
        if (!mon.inOutage && now - app.startedAt > mon.timeoutMs) {
          mon.inOutage = true;
          mon.outageStart = now;
          app.error(
            `${PLUGIN_ID}: OUTAGE START path=${mon.path} no data since plugin start`
          );
        }
        return;
      }

      const age = now - mon.lastUpdate;
      if (!mon.inOutage && age > mon.timeoutMs) {
        // Outage starts
        mon.inOutage = true;
        mon.outageStart = mon.lastUpdate + mon.timeoutMs;
        const gap = now - mon.outageStart;
        app.error(
          `${PLUGIN_ID}: OUTAGE START path=${mon.path} age=${(
            age / 1000
          ).toFixed(1)}s timeout=${(mon.timeoutMs / 1000).toFixed(1)}s`
        );
      }
    });
  }

  const plugin = {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    description:
      "Monitors up to 10 Signal K paths. If time between deltas exceeds a per-path timeout, logs outage start and end with duration.",
    schema: {
      type: "object",
      properties: {
        monitors: {
          type: "array",
          maxItems: 10,
          title: "Monitored paths",
          items: {
            type: "object",
            required: ["path", "timeoutSeconds"],
            properties: {
              path: {
                type: "string",
                title: "Signal K path to monitor (e.g. navigation.position)"
              },
              timeoutSeconds: {
                type: "number",
                title: "Timeout (seconds) between deltas before flagging outage",
                default: 10
              }
            }
          }
        }
      }
    },
    start: function (props) {
      app.debug(`${PLUGIN_ID}: starting`);
      start(props || {});
    },
    stop: function () {
      app.debug(`${PLUGIN_ID}: stopping`);
      stop();
    },
    statusMessage: function () {
      return "Running";
    }
  };

  // track when plugin was loaded (for initial-no-data logic)
  app.startedAt = Date.now();

  return plugin;
};
