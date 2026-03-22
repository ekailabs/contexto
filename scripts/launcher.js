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
const dashboardPort = process.env.DASHBOARD_PORT || "3000";
const openrouterPort = process.env.OPENROUTER_PORT || "4010";
const apiPort = process.env.API_PORT || "4010";

const SERVICES = {
  dashboard: {
    dev: `pnpm --filter @ekai/dashboard run dev -p ${dashboardPort}`,
    start: `pnpm --filter @ekai/dashboard run start -p ${dashboardPort} -H 0.0.0.0`,
    label: "dashboard",
    color: "magenta",
    port: dashboardPort,
  },
  openrouter: {
    dev: `OPENROUTER_PORT=${openrouterPort} pnpm --filter @ekai/openrouter run dev`,
    start: `OPENROUTER_PORT=${openrouterPort} pnpm --filter @ekai/openrouter run start`,
    label: "openrouter",
    color: "yellow",
    port: openrouterPort,
  },
  api: {
    dev: `API_PORT=${apiPort} pnpm --filter @ekai/api run dev`,
    start: `API_PORT=${apiPort} pnpm --filter @ekai/api run start`,
    label: "api",
    color: "cyan",
    port: apiPort,
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