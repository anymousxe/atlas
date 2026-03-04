const fs = require("fs");
const path = require("path");
const cwd = process.cwd();
const candidates = [
  path.join(cwd, ".env"),
  path.join(cwd, "worker", ".env"),
  path.join(cwd, "worker", ".env.local")
];
const keys = {};
for (const p of candidates) {
  if (!fs.existsSync(p)) continue;
  for (const raw of fs.readFileSync(p, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (v !== "") keys[k] = v;
  }
}
const claude = (keys.CLAUDE_API_KEY || keys.ANTHROPIC_API_KEY || keys.CLAUDE_KEY || "").trim();
const numbered = Array.from({ length: 10 }, (_, i) => (keys[`LITEROUTER_KEY_${i + 1}`] || "").trim());
const hasNumbered = numbered.some(Boolean);
const single = (keys.LITEROUTER_KEY || keys.LITEROUTER_API_KEY || "").trim();
const lrCount = hasNumbered ? numbered.filter(Boolean).length : (single ? 1 : 0);
console.log(JSON.stringify({
  found: candidates.filter(p => fs.existsSync(p)),
  claudePresent: !!claude,
  claudeLength: claude.length,
  lrCount,
  sample: Object.keys(keys).slice(0, 20)
}, null, 2));
