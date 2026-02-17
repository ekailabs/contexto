const { execSync } = require("child_process");
const { readFileSync } = require("fs");
const { resolve } = require("path");

// Load .env from project root (don't override existing env vars)
try {
  const envPath = resolve(__dirname, "..", ".env");
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = val;
  }
} catch {}

// Resolve ports from env (each service owns its own port var)
const gatewayPort = process.env.PORT || "3001";
const dashboardPort = process.env.DASHBOARD_PORT || "3000";
const memoryPort = process.env.MEMORY_PORT || "4005";
const openrouterPort = process.env.OPENROUTER_PORT || "4010";

const SERVICES = {
  gateway: {
    dev: `PORT=${gatewayPort} npm run dev -w gateway`,
    start: `PORT=${gatewayPort} npm run start -w gateway`,
    label: "gateway",
    color: "blue",
    port: gatewayPort,
  },
  dashboard: {
    dev: `npx -w ui/dashboard next dev -p ${dashboardPort}`,
    start: `npx -w ui/dashboard next start -p ${dashboardPort} -H 0.0.0.0`,
    label: "dashboard",
    color: "magenta",
    port: dashboardPort,
  },
  memory: {
    dev: `MEMORY_PORT=${memoryPort} npm run start -w memory`,
    start: `MEMORY_PORT=${memoryPort} npm run start -w memory`,
    label: "memory",
    color: "green",
    port: memoryPort,
  },
  openrouter: {
    dev: `OPENROUTER_PORT=${openrouterPort} npm run dev -w @ekai/openrouter`,
    start: `OPENROUTER_PORT=${openrouterPort} npm run start -w @ekai/openrouter`,
    label: "openrouter",
    color: "yellow",
    port: openrouterPort,
  },
};

const mode = process.argv.includes("--mode")
  ? process.argv[process.argv.indexOf("--mode") + 1]
  : "dev";

if (!["dev", "start"].includes(mode)) {
  console.error(`Unknown mode "${mode}". Use --mode dev or --mode start`);
  process.exit(1);
}

const isDisabled = (v) => v === "false" || v === "0";

const enabled = Object.entries(SERVICES).filter(
  ([name]) => !isDisabled(process.env[`ENABLE_${name.toUpperCase()}`])
);

if (enabled.length === 0) {
  console.error("All services disabled — nothing to start.");
  process.exit(1);
}

const commands = enabled.map(([, svc]) => `"${svc[mode]}"`).join(" ");
const names = enabled.map(([, svc]) => svc.label).join(",");
const colors = enabled.map(([, svc]) => svc.color).join(",");

const summary = enabled
  .map(([, svc]) => `${svc.label}(:${svc.port})`)
  .join("  ");
console.log(`\n  Starting [${mode}]: ${summary}\n`);

const cmd = `npx concurrently --names "${names}" -c "${colors}" ${commands}`;

try {
  execSync(cmd, { stdio: "inherit" });
} catch {
  process.exit(1);
}
