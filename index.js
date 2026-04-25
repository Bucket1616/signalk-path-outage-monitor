// index.js
"use strict";

const PLUGIN_ID = "signalk-path-outage-monitor";
const PLUGIN_NAME = "Path Outage Monitor";

module.exports = function (app) {
  let unsubscribes = [];
  let checkTimer = null;
  let monitors = [];

  // Keystone (bus health) tracking
  let keystone = null;     // { path, source, timeoutMs, lastUpdate, inOutage, outageStart }
  let keystoneUnsub = null;
  let pluginStartedAt = Date.now();

  function start(props) {
    stop(); // clean restart
    pluginStartedAt = Date.now();

    // --- Keystone setup ---
    keystone = null;
    keystoneUnsub = null;

    const ksPath = props.keystonePath;
    const ksSource = props.keystoneSource || null;
    const ksTimeoutMs = (props.keystoneTimeoutSeconds || 0) * 1000;

    if (ksPath && ksTimeoutMs > 0) {
      keystone = {
        path: ksPath,
        source: ksSource,
        timeoutMs: ksTimeoutMs,
        lastUpdate: null,
        inOutage: false,
        outageStart: null
      };
      app.debug(
       `${PLUGIN_ID}: keystone configured path=${keystone.path}` +
        (keystone.source ? ` source=${keystone.source}` : "") +
        ` timeout=${(keystone.timeoutMs / 1000).toFixed(1)}s`
      };

      try {
        let ksStream;
        if (ksSource && app.streambundle.getSourceStream) {
          app.debug(
            `${PLUGIN_ID}: subscribing keystone to getSourceStream(${ksSource}, ${keystone.path})`
          );
          ksStream = app.streambundle.getSourceStream(ksSource, keystone.path);
        } else {
          app.debug(
            `${PLUGIN_ID}: subscribing keystone to getSelfStream(${keystone.path})`
          );
          ksStream = app.streambundle.getSelfStream(keystone.path);
        }

        keystoneUnsub = ksStream.onValue(() => {
          const now = Date.now();
          // Recovery from bus-down
          if (keystone.inOutage) {
            const durationMs = now - (keystone.outageStart || now);
            app.error(
              `${PLUGIN_ID}: N2K BUS RECOVERED keystone=${keystone.path}` +
              ` outage=${(durationMs / 1000).toFixed(1)}s`
            );
            keystone.inOutage = false;
            keystone.outageStart = null;
          }
          keystone.lastUpdate = now;
        });
      } catch (e) {
        app.error(
          `${PLUGIN_ID}: failed to subscribe keystone ${ksPath}` +
          (ksSource ? ` (source=${ksSource})` : "") +
          `: ${e.message || e}`
        );
      }
    }

    // --- Monitors setup ---
    monitors = (props.monitors || [])
      .filter(m => m && typeof m.path === "string" && m.path.length > 0)
      .map(m => ({
        path: m.path,
        source: m.source || null,
        timeoutMs: (m.timeoutSeconds || 0) * 1000,
        lastUpdate: null,
        inOutage: false,
        outageStart: null,
        pendingOutage: false,
        pendingSince: null
      }));
    app.debug(
      `${PLUGIN_ID}: configured ${monitors.length} monitors: ` +
      monitors.map(m =>
        `${m.path}` +
        (m.source ? `@${m.source}` : "") +
        `(${(m.timeoutMs / 1000).toFixed(1)}s)`
      ).join(", ")
    );

    if (monitors.length === 0) {
      app.debug(`${PLUGIN_ID}: no monitors configured`);
      return;
    }

    // Subscribe to each monitored path (optionally by source)
    monitors.forEach(mon => {
      try {
        let stream;
        if (mon.source && app.streambundle.getSourceStream) {
          app.debug(
            `${PLUGIN_ID}: subscribing monitor to getSourceStream(${mon.source}, ${mon.path})`
          );
          stream = app.streambundle.getSourceStream(mon.source, mon.path);
        } else {
          app.debug(
            `${PLUGIN_ID}: subscribing monitor to getSelfStream(${mon.path})`
          );
          stream = app.streambundle.getSelfStream(mon.path);
        }

        const unsub = stream.onValue(() => {
          const now = Date.now();

          // If we were in a logged outage, this is recovery
          if (mon.inOutage) {
            const durationMs = now - (mon.outageStart || now);
            app.error(
              `${PLUGIN_ID}: OUTAGE END path=${mon.path}` +
              (mon.source ? ` source=${mon.source}` : "") +
              ` duration=${(durationMs / 1000).toFixed(1)}s`
            );
            mon.inOutage = false;
            mon.outageStart = null;
          }

          // Clear any pending “maybe outage” state
          mon.pendingOutage = false;
          mon.pendingSince = null;

          mon.lastUpdate = now;
        });
        unsubscribes.push(unsub);
      } catch (e) {
        app.error(
          `${PLUGIN_ID}: failed to subscribe to ${mon.path}` +
          (mon.source ? ` (source=${mon.source})` : "") +
          `: ${e.message || e}`
        );
      }
    });

    // Periodic decision loop
    checkTimer = setInterval(checkTimeouts, 1000);
  }

  function stop() {
    unsubscribes.forEach(u => {
      try { u && u(); } catch (e) {}
    });
    unsubscribes = [];

    if (keystoneUnsub) {
      try { keystoneUnsub(); } catch (e) {}
      keystoneUnsub = null;
    }
    keystone = null;

    if (checkTimer) {
      clearInterval(checkTimer);
      checkTimer = null;
    }
    monitors = [];
  }

  function checkTimeouts() {
    const now = Date.now();

    // --- Keystone state update ---
    let keystoneAge = null;
    if (keystone && keystone.timeoutMs > 0) {
      if (keystone.lastUpdate == null) {
        // Age since plugin start (no data yet)
        keystoneAge = now - pluginStartedAt;
      } else {
        keystoneAge = now - keystone.lastUpdate;
      }

      if (!keystone.inOutage && keystoneAge > keystone.timeoutMs) {
        keystone.inOutage = true;
        keystone.outageStart = keystone.lastUpdate
          ? keystone.lastUpdate + keystone.timeoutMs
          : now - keystoneAge + keystone.timeoutMs;

        app.error(
          `${PLUGIN_ID}: N2K BUS DOWN (keystone=${keystone.path}` +
          (keystone.source ? ` source=${keystone.source}` : "") +
          `) age=${(keystoneAge / 1000).toFixed(1)}s` +
          ` timeout=${(keystone.timeoutMs / 1000).toFixed(1)}s`
        );
      }
    }

    // --- Per-path logic with pending + decision window ---
    monitors.forEach(mon => {
      if (!mon.timeoutMs || mon.timeoutMs <= 0) return;

      // Compute age of this path
      let age;
      if (mon.lastUpdate == null) {
        age = now - pluginStartedAt;
      } else {
        age = now - mon.lastUpdate;
      }

      // 1) If already in logged outage, nothing to do here; recovery is in onValue
      if (mon.inOutage) {
        return;
      }

      // 2) If not yet pending and exceeded its own timeout -> become candidate outage
      if (!mon.pendingOutage && age > mon.timeoutMs) {
        mon.pendingOutage = true;
        mon.pendingSince = now;
        // Outage start is when it first exceeded its own timeout
        mon.outageStart = mon.lastUpdate
          ? mon.lastUpdate + mon.timeoutMs
          : pluginStartedAt + mon.timeoutMs;
        return; // wait for decision window
      }

      // 3) If pending, decide once keystone decision window has elapsed
      if (mon.pendingOutage) {
        const keystoneTimeoutMs =
          keystone && keystone.timeoutMs > 0 ? keystone.timeoutMs : 0;

        // If we have no keystone configured, classify immediately
        if (!keystone || keystoneTimeoutMs === 0) {
          mon.inOutage = true;
          mon.pendingOutage = false;
          mon.pendingSince = null;
          app.error(
            `${PLUGIN_ID}: OUTAGE START path=${mon.path}` +
            (mon.source ? ` source=${mon.source}` : "") +
            ` (no keystone) age=${(age / 1000).toFixed(1)}s` +
            ` timeout=${(mon.timeoutMs / 1000).toFixed(1)}s`
          );
          return;
        }

        const decisionAt = mon.pendingSince + keystoneTimeoutMs;
        if (now < decisionAt) {
          // Still in “wait and see” window
          return;
        }

        // Decision time: look at keystone age now
        let currentKeystoneAge = keystoneAge;
        if (currentKeystoneAge == null && keystone && keystone.timeoutMs > 0) {
          if (keystone.lastUpdate == null) {
            currentKeystoneAge = now - pluginStartedAt;
          } else {
            currentKeystoneAge = now - keystone.lastUpdate;
          }
        }

        const ksTimeout = keystone.timeoutMs;

        if (
          currentKeystoneAge != null &&
          currentKeystoneAge > ksTimeout
        ) {
          // Keystone also effectively out -> bus-down classification; suppress per-path log
          mon.pendingOutage = false;
          mon.pendingSince = null;
          mon.outageStart = null; // bus-induced, not independent outage
          return;
        } else {
          // Keystone alive -> real sensor outage
          mon.inOutage = true;
          mon.pendingOutage = false;
          mon.pendingSince = null;

          app.error(
            `${PLUGIN_ID}: OUTAGE START path=${mon.path}` +
            (mon.source ? ` source=${mon.source}` : "") +
            ` age=${(age / 1000).toFixed(1)}s` +
            ` timeout=${(mon.timeoutMs / 1000).toFixed(1)}s (keystone alive)`
          );
          return;
        }
      }
    });
  }

  const plugin = {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    description:
      "Monitors up to 10 Signal K paths. If time between deltas exceeds a per-path timeout, logs outages; uses a keystone path to suppress bus-off events.",
    schema: {
      type: "object",
      properties: {
        keystonePath: {
          type: "string",
          title: "Keystone path (indicates N2K bus is alive)",
          description:
            "Example: a stable N2K-based path like navigation.speedOverGround",
          default: "navigation.speedOverGround"
        },
        keystoneSource: {
          type: "string",
          title: "Optional keystone source",
          description:
            "If set, only deltas from this source are used to detect bus state (e.g. n2k-from-file.serial)"
        },
        keystoneTimeoutSeconds: {
          type: "number",
          title: "Keystone timeout (seconds)",
          description:
            "If no deltas on keystone for this long, treat N2K bus as down",
          default: 10
        },
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
                title:
                  "Signal K path to monitor (e.g. navigation.headingTrue)"
              },
              source: {
                type: "string",
                title: "Optional source",
                description:
                  "If set, only deltas from this source are monitored (e.g. n2k-from-ais.ttyUSB0)"
              },
              timeoutSeconds: {
                type: "number",
                title:
                  "Path timeout (seconds) between deltas before flagging outage",
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

  return plugin;
};
