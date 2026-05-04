import fs from "node:fs";
import path from "node:path";
import worker from "../src/worker.js";

const root = path.resolve(import.meta.dirname, "..");
const env = loadDevVars(path.join(root, ".dev.vars"));

env.SENT_ACTIVITIES = {
  async get() {
    return null;
  },
  async put() {
    return undefined;
  }
};

const pathAndQuery = process.argv[2] || "/run?max=1";
const response = await worker.fetch(new Request(`http://local.test${pathAndQuery}`), env);
const body = await response.text();
console.log(body);

function loadDevVars(file) {
  const text = fs.readFileSync(file, "utf8");
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    values[key] = rawValue.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  }
  return values;
}
