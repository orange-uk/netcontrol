// netcontrol/src/config.example.js
// Copy this to src/config.js and set your own values. config.js is gitignored
// so your PIN never lands in version control.
//
//   cp src/config.example.js src/config.js

export const config = {
  // PIN for the web app. Prefer setting NETCONTROL_PIN in the environment
  // (e.g. in the LaunchDaemon plist) over hard-coding it here.
  pin: process.env.NETCONTROL_PIN || '1234',

  // Web app port.
  port: Number(process.env.PORT) || 3000,

  // Built-in DNS resolver (runs natively so it sees real client IPs).
  resolver: {
    port: Number(process.env.NETCONTROL_DNS_PORT) || 53,
    upstreams: ['8.8.8.8', '8.8.4.4'],
    blockTTL: 60,
    queryTimeoutMs: 5000,
    watchdogIntervalMs: Number(process.env.NETCONTROL_WATCHDOG_MS) || 30000,
    watchdogProbeTimeoutMs: Number(process.env.NETCONTROL_WATCHDOG_PROBE_MS) || 2000,
  },

  dataFile: process.env.DATA_FILE || './data/state.json',
};
