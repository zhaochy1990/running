import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const readJson = async (path) => JSON.parse(await readFile(join(root, path), "utf8"));

const [config, designSystem, manifest, foundation, briefFiles] = await Promise.all([
  readJson("stitch.config.json"),
  readJson("design-system.json"),
  readJson("artifacts/manifest.json"),
  readFile(join(root, "prompts/foundation.md"), "utf8"),
  readdir(join(root, "briefs")),
]);

const failures = [];
const expect = (condition, message) => {
  if (!condition) failures.push(message);
};

expect(config.designSystemId === "9639466710049134133", "unexpected design system ID");
expect(config.confirmedProjectId === "7939736180256612039", "unexpected confirmed project ID");
expect(config.confirmedDesignSystemId === "10849724626496628336", "unexpected confirmed design system ID");
expect(designSystem.theme.colorMode === "DARK", "colorMode must be DARK");
expect(designSystem.theme.bodyFont === "INTER", "bodyFont must be INTER");
expect(designSystem.theme.headlineFont === "INTER", "headlineFont must be INTER");
expect(designSystem.theme.overrideNeutralColor.toUpperCase() === "#07080A", "canvas must be #07080A");
expect(designSystem.theme.overridePrimaryColor.toUpperCase() === "#FF6363", "accent must be #FF6363");
expect(designSystem.theme.overrideSecondaryColor.toUpperCase() === "#55B3FF", "focus color must be #55B3FF");
expect(designSystem.theme.overrideTertiaryColor.toUpperCase() === "#5FC992", "success color must be #5FC992");
expect(designSystem.theme.typography["body-lg"].fontWeight === "500", "body weight must be 500");
expect(designSystem.theme.typography["metric-value"].fontFamily === "Geist Mono", "metrics must use Geist Mono");
expect(designSystem.theme.spacing["touch-target"] === "48px", "touch target must be 48px");

for (const token of [
  "#07080A",
  "#101111",
  "#FF6363",
  "Inter",
  "Geist Mono",
  "rgba(255,255,255,0.06)",
  "cubic-bezier(0.2,0,0,1)",
]) {
  expect(foundation.includes(token), `foundation is missing ${token}`);
}

for (const screen of manifest.screens) {
  expect(Boolean(screen.designGeneration), `screen ${screen.screenId} has no designGeneration`);
  expect(["candidate", "approved"].includes(screen.status), `screen ${screen.screenId} has invalid status`);
  expect(Array.isArray(screen.briefs) && screen.briefs.length > 0, `screen ${screen.screenId} has no canonical brief`);
  if (screen.html) expect(existsSync(join(root, screen.html)), `screen ${screen.screenId} HTML is missing`);
  for (const brief of screen.briefs ?? []) {
    expect(existsSync(join(root, brief)), `screen ${screen.screenId} brief ${brief} is missing`);
  }

  if (screen.status === "candidate") {
    expect(!screen.approvedArtifactSha256, `candidate ${screen.screenId} has an approved hash`);
    expect(!screen.confirmedScreenId, `candidate ${screen.screenId} has a confirmed screen`);
  }

  if (screen.status === "approved" && !screen.designGeneration.startsWith("legacy-")) {
    const html = screen.html ? await readFile(join(root, screen.html)) : null;
    const actualHash = html ? createHash("sha256").update(html).digest("hex") : "";
    expect(Boolean(html), `approved screen ${screen.screenId} has no local HTML`);
    expect(screen.approvedArtifactSha256 === actualHash, `approved screen ${screen.screenId} hash does not match its HTML`);
    expect(screen.confirmedProjectId === config.confirmedProjectId, `approved screen ${screen.screenId} has the wrong confirmed project`);
    expect(Boolean(screen.confirmedScreenId), `approved screen ${screen.screenId} has no confirmed screen`);
    expect(screen.confirmedVerified === true, `approved screen ${screen.screenId} is not confirmed as verified`);
  }
}

const processBriefs = briefFiles.filter((name) => /(?:^|[-_])(fix|refine|verify)(?:[-_.]|$)/i.test(name));
expect(processBriefs.length === 0, `process briefs must not be archived: ${processBriefs.join(", ")}`);

const canonicalBriefs = briefFiles.filter((name) => name.endsWith(".md") && !name.includes("legacy"));
for (const name of canonicalBriefs) {
  const content = await readFile(join(root, "briefs", name), "utf8");
  for (const line of content.split("\n")) {
    for (const banned of [/#ffffff/i, /#1fad5b/i, /white canvas/i, /opaque-white/i, /geist sans/i]) {
      if (!banned.test(line)) continue;
      const occurrence = line.search(banned);
      const negation = line.search(/\b(?:do not|never|avoid)\b/i);
      expect(negation !== -1 && negation < occurrence, `${name} contains obsolete visual instruction ${banned}`);
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Foundation audit passed: ${manifest.screens.length} candidate/approved screens tracked.`);
