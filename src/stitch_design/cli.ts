#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  StitchError,
  stitch,
  type Project,
  type Screen,
} from "@google/stitch-sdk";

const rootDir = dirname(fileURLToPath(import.meta.url));
const configPath = join(rootDir, "stitch.config.json");
const envPath = join(rootDir, ".env");

if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

type Operation = "generate" | "edit" | "variant" | "export" | "publish";
type DesignSystemSpec = Parameters<Project["createDesignSystem"]>[0];
type VariantOptions = Parameters<Screen["variants"]>[1];

interface StitchConfig {
  projectTitle: string;
  projectId: string | null;
  designSystemId: string | null;
  deviceType: "MOBILE";
  foundationFile: string;
  designSystemFile: string;
  artifactsDir: string;
  manifestFile: string;
}

interface ScreenRecord {
  projectId: string;
  screenId: string;
  parentScreenId?: string;
  slug: string;
  operation: Operation;
  brief?: string;
  html?: string;
  createdAt: string;
  updatedAt: string;
}

interface ArtifactManifest {
  projectId: string | null;
  deviceType: "MOBILE";
  screens: ScreenRecord[];
}

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Map<string, string | true>;
}

function printHelp(): void {
  console.log(`STRIDE Stitch mobile design CLI

Usage:
  npm run stitch -- <command> [arguments] [options]

Commands:
  doctor
  projects
  create-project [title]
  screens [--project <id>]
  design-systems [--project <id>]
  create-design-system [file] [--project <id>]
  update-design-system [file] [--design-system <id>] [--project <id>]
  publish <screen.html> [--title <title>] [--slug <name>] [--project <id>]
  generate <brief.md> [--slug <name>] [--project <id>] [--no-export]
  edit <screen-id> <brief.md> [--slug <name>] [--project <id>] [--no-export]
  variants <screen-id> <brief.md> [--slug <name>] [--count <1-5>]
           [--range <REFINE|EXPLORE|REIMAGINE>]
           [--aspects <LAYOUT,COLOR_SCHEME,...>] [--project <id>] [--no-export]
  export <screen-id> [--slug <name>] [--project <id>]

Authentication:
  Set STITCH_API_KEY, or set both STITCH_ACCESS_TOKEN and GOOGLE_CLOUD_PROJECT.
`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string | true>();

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value?.startsWith("--")) {
      if (value !== undefined) positional.push(value);
      continue;
    }

    const equalsIndex = value.indexOf("=");
    if (equalsIndex !== -1) {
      flags.set(value.slice(2, equalsIndex), value.slice(equalsIndex + 1));
      continue;
    }

    const name = value.slice(2);
    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      index += 1;
    } else {
      flags.set(name, true);
    }
  }

  return { command, positional, flags };
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function loadConfig(): Promise<StitchConfig> {
  const config = await readJson<StitchConfig>(configPath);
  if (config.deviceType !== "MOBILE") {
    throw new Error("stitch.config.json must keep deviceType set to MOBILE.");
  }
  return config;
}

function resolveLocalPath(path: string): string {
  if (isAbsolute(path)) return path;

  const fromCwd = resolve(process.cwd(), path);
  if (existsSync(fromCwd)) return fromCwd;
  return resolve(rootDir, path);
}

function relativeToRoot(path: string): string {
  return relative(rootDir, path).split(sep).join("/");
}

function getFlag(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function requireValue(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

function projectIdFor(config: StitchConfig, flags: Map<string, string | true>): string {
  return requireValue(
    getFlag(flags, "project") ?? config.projectId ?? undefined,
    "No Stitch project is configured. Run create-project or pass --project <id>.",
  );
}

function safeSlug(value: string): string {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "screen";
}

function slugFromBrief(briefPath: string): string {
  return safeSlug(basename(briefPath, extname(briefPath)));
}

async function composePrompt(
  config: StitchConfig,
  briefPath: string,
  mode: "generate" | "edit" | "variants",
): Promise<string> {
  const foundationPath = resolveLocalPath(config.foundationFile);
  const [foundation, brief] = await Promise.all([
    readFile(foundationPath, "utf8"),
    readFile(briefPath, "utf8"),
  ]);

  const contract = {
    generate: "Create exactly one complete mobile screen that satisfies this brief.",
    edit: "Edit the selected mobile screen. Preserve all unmentioned product behavior and visual structure.",
    variants: "Create purposeful alternatives for the selected mobile screen while preserving its user goal and required content.",
  }[mode];

  return `${foundation.trim()}\n\n# Current Screen Brief\n\n${brief.trim()}\n\n# Task\n\n${contract}`;
}

async function updateManifest(
  config: StitchConfig,
  record: Omit<ScreenRecord, "createdAt" | "updatedAt">,
): Promise<void> {
  const manifestPath = resolveLocalPath(config.manifestFile);
  const manifest = await readJson<ArtifactManifest>(manifestPath);
  const now = new Date().toISOString();
  const index = manifest.screens.findIndex(
    (item) => item.projectId === record.projectId && item.screenId === record.screenId,
  );
  const existing = index === -1 ? undefined : manifest.screens[index];
  const definedRecord = Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  ) as typeof record;
  const next: ScreenRecord = {
    ...existing,
    ...definedRecord,
    operation: existing?.operation ?? record.operation,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  if (index === -1) manifest.screens.push(next);
  else manifest.screens[index] = next;

  manifest.projectId = record.projectId;
  await writeJson(manifestPath, manifest);
}

async function exportScreen(
  config: StitchConfig,
  screen: Screen,
  options: {
    slug: string;
    operation: Operation;
    briefPath?: string;
    parentScreenId?: string;
  },
): Promise<void> {
  const artifactsDir = resolveLocalPath(config.artifactsDir);
  await mkdir(artifactsDir, { recursive: true });

  const htmlUrl = await screen.getHtml();
  if (!htmlUrl) {
    throw new Error(`Stitch returned no HTML artifact for screen ${screen.id}.`);
  }
  const htmlResponse = await fetch(htmlUrl);

  if (!htmlResponse.ok) {
    throw new Error(`HTML download failed with HTTP ${htmlResponse.status}.`);
  }

  const fileBase = `${screen.id}_${safeSlug(options.slug)}`;
  const htmlPath = join(artifactsDir, `${fileBase}.html`);
  await writeFile(htmlPath, await htmlResponse.text(), "utf8");

  await updateManifest(config, {
    projectId: screen.projectId,
    screenId: screen.id,
    parentScreenId: options.parentScreenId,
    slug: safeSlug(options.slug),
    operation: options.operation,
    brief: options.briefPath ? relativeToRoot(options.briefPath) : undefined,
    html: relativeToRoot(htmlPath),
  });

  console.log(`HTML: ${relativeToRoot(htmlPath)}`);
}

async function recordWithoutExport(
  config: StitchConfig,
  screen: Screen,
  options: {
    slug: string;
    operation: Operation;
    briefPath?: string;
    parentScreenId?: string;
  },
): Promise<void> {
  await updateManifest(config, {
    projectId: screen.projectId,
    screenId: screen.id,
    parentScreenId: options.parentScreenId,
    slug: safeSlug(options.slug),
    operation: options.operation,
    brief: options.briefPath ? relativeToRoot(options.briefPath) : undefined,
  });
}

async function maybeExport(
  config: StitchConfig,
  screen: Screen,
  flags: Map<string, string | true>,
  options: {
    slug: string;
    operation: Operation;
    briefPath?: string;
    parentScreenId?: string;
  },
): Promise<void> {
  if (flags.has("no-export")) {
    await recordWithoutExport(config, screen, options);
    return;
  }
  await exportScreen(config, screen, options);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help" || args.command === "--help" || args.command === "-h") {
    printHelp();
    return;
  }

  const config = await loadConfig();

  if (args.command === "doctor") {
    const hasApiKey = Boolean(process.env.STITCH_API_KEY);
    const hasOauth = Boolean(
      process.env.STITCH_ACCESS_TOKEN && process.env.GOOGLE_CLOUD_PROJECT,
    );
    console.log(`Node: ${process.versions.node}`);
    console.log(`Device: ${config.deviceType}`);
    console.log(`Project: ${config.projectId ?? "not configured"}`);
    console.log(`Authentication: ${hasApiKey || hasOauth ? "configured" : "not configured"}`);
    console.log(`Foundation: ${existsSync(resolveLocalPath(config.foundationFile)) ? "ready" : "missing"}`);
    return;
  }

  if (args.command === "projects") {
    const projects = await stitch.projects();
    if (projects.length === 0) {
      console.log("No Stitch projects found.");
      return;
    }
    for (const project of projects) {
      const title = String(project.data?.title ?? "Untitled");
      console.log(`${project.id}\t${title}`);
    }
    return;
  }

  if (args.command === "create-project") {
    const title = args.positional.join(" ") || config.projectTitle;
    const project = await stitch.createProject(title);
    config.projectTitle = title;
    config.projectId = project.id;
    config.designSystemId = null;
    await writeJson(configPath, config);

    const manifestPath = resolveLocalPath(config.manifestFile);
    const manifest = await readJson<ArtifactManifest>(manifestPath);
    manifest.projectId = project.id;
    await writeJson(manifestPath, manifest);
    console.log(`Project created: ${project.id}`);
    return;
  }

  const projectId = projectIdFor(config, args.flags);
  const project = stitch.project(projectId);

  if (args.command === "screens") {
    const screens = await project.screens();
    if (screens.length === 0) {
      console.log(`No screens found in project ${project.id}.`);
      return;
    }
    for (const screen of screens) {
      const title = String(screen.data?.title ?? "Untitled");
      const device = String(screen.data?.deviceType ?? "unknown");
      console.log(`${screen.id}\t${device}\t${title}`);
    }
    return;
  }

  if (args.command === "design-systems") {
    const systems = await project.listDesignSystems();
    if (systems.length === 0) {
      console.log(`No design systems found in project ${project.id}.`);
      return;
    }
    for (const system of systems) {
      const title = String(
        system.data?.designSystem?.displayName ?? system.data?.displayName ?? "Untitled",
      );
      console.log(`${system.id}\t${title}`);
    }
    return;
  }

  if (args.command === "create-design-system") {
    const inputPath = resolveLocalPath(
      args.positional[0] ?? config.designSystemFile,
    );
    const designSystem = await readJson<DesignSystemSpec>(inputPath);
    const foundation = await readFile(resolveLocalPath(config.foundationFile), "utf8");
    designSystem.theme = { ...designSystem.theme, designMd: foundation };

    const created = await project.createDesignSystem(designSystem);
    config.designSystemId = created.id;
    await writeJson(configPath, config);
    console.log(`Design system created: ${created.id}`);
    return;
  }

  if (args.command === "update-design-system") {
    const designSystemId = requireValue(
      getFlag(args.flags, "design-system") ?? config.designSystemId ?? undefined,
      "No design system is configured. Pass --design-system <id>.",
    );
    const inputPath = resolveLocalPath(
      args.positional[0] ?? config.designSystemFile,
    );
    const designSystem = await readJson<DesignSystemSpec>(inputPath);
    const foundation = await readFile(resolveLocalPath(config.foundationFile), "utf8");
    designSystem.theme = { ...designSystem.theme, designMd: foundation };

    await project.designSystem(designSystemId).update(designSystem);
    console.log(`Design system updated: ${designSystemId}`);
    return;
  }

  if (args.command === "publish") {
    const inputPath = resolveLocalPath(
      requireValue(args.positional[0], "publish requires <screen.html>."),
    );
    const title = getFlag(args.flags, "title") ?? basename(inputPath, extname(inputPath));
    const slug = getFlag(args.flags, "slug") ?? safeSlug(title);
    const published = await project.upload(inputPath, {
      title,
      createScreenInstances: true,
    });
    if (published.length === 0) {
      throw new Error("Stitch published no screens from the supplied artifact.");
    }

    for (const screen of published) {
      await updateManifest(config, {
        projectId: screen.projectId,
        screenId: screen.id,
        slug,
        operation: "publish",
        html: relativeToRoot(inputPath),
      });
      console.log(`Screen published: ${screen.id}`);
    }
    return;
  }

  if (args.command === "generate") {
    const briefPath = resolveLocalPath(
      requireValue(args.positional[0], "generate requires <brief.md>."),
    );
    const slug = getFlag(args.flags, "slug") ?? slugFromBrief(briefPath);
    const prompt = await composePrompt(config, briefPath, "generate");
    console.log(`Generating ${slug} in project ${project.id}...`);
    const screen = await project.generate(prompt, "MOBILE");
    console.log(`Screen generated: ${screen.id}`);
    await maybeExport(config, screen, args.flags, {
      slug,
      operation: "generate",
      briefPath,
    });
    return;
  }

  if (args.command === "edit") {
    const screenId = requireValue(args.positional[0], "edit requires <screen-id>.");
    const briefPath = resolveLocalPath(
      requireValue(args.positional[1], "edit requires <brief.md> after <screen-id>."),
    );
    const slug = getFlag(args.flags, "slug") ?? slugFromBrief(briefPath);
    const prompt = await composePrompt(config, briefPath, "edit");
    const source = await project.getScreen(screenId);
    console.log(`Editing ${screenId}...`);
    const edited = await source.edit(prompt, "MOBILE");
    console.log(`Edited screen generated: ${edited.id}`);
    await maybeExport(config, edited, args.flags, {
      slug,
      operation: "edit",
      briefPath,
      parentScreenId: screenId,
    });
    return;
  }

  if (args.command === "variants") {
    const screenId = requireValue(args.positional[0], "variants requires <screen-id>.");
    const briefPath = resolveLocalPath(
      requireValue(args.positional[1], "variants requires <brief.md> after <screen-id>."),
    );
    const baseSlug = getFlag(args.flags, "slug") ?? slugFromBrief(briefPath);
    const count = Number.parseInt(getFlag(args.flags, "count") ?? "3", 10);
    if (!Number.isInteger(count) || count < 1 || count > 5) {
      throw new Error("--count must be an integer from 1 to 5.");
    }

    const range = (getFlag(args.flags, "range") ?? "EXPLORE").toUpperCase();
    if (!["REFINE", "EXPLORE", "REIMAGINE"].includes(range)) {
      throw new Error("--range must be REFINE, EXPLORE, or REIMAGINE.");
    }

    const allowedAspects = [
      "LAYOUT",
      "COLOR_SCHEME",
      "IMAGES",
      "TEXT_FONT",
      "TEXT_CONTENT",
    ] as const;
    const aspects = (getFlag(args.flags, "aspects") ?? "LAYOUT,COLOR_SCHEME")
      .split(",")
      .map((value) => value.trim().toUpperCase())
      .filter((value) => value.length > 0);
    if (aspects.some((value) => !allowedAspects.includes(value as typeof allowedAspects[number]))) {
      throw new Error(`--aspects must use: ${allowedAspects.join(", ")}.`);
    }

    const prompt = await composePrompt(config, briefPath, "variants");
    const source = await project.getScreen(screenId);
    console.log(`Generating ${count} variants from ${screenId}...`);
    const variants = await source.variants(
      prompt,
      {
        variantCount: count,
        creativeRange: range as "REFINE" | "EXPLORE" | "REIMAGINE",
        // SDK 0.3.5 emits this field with an overly narrow union type even
        // though the Stitch API and SDK documentation accept an array.
        aspects: aspects as unknown as NonNullable<VariantOptions["aspects"]>,
      },
      "MOBILE",
    );

    for (let index = 0; index < variants.length; index += 1) {
      const variant = variants[index];
      if (!variant) continue;
      const slug = `${baseSlug}-v${index + 1}`;
      console.log(`Variant ${index + 1}: ${variant.id}`);
      await maybeExport(config, variant, args.flags, {
        slug,
        operation: "variant",
        briefPath,
        parentScreenId: screenId,
      });
    }
    return;
  }

  if (args.command === "export") {
    const screenId = requireValue(args.positional[0], "export requires <screen-id>.");
    const slug = getFlag(args.flags, "slug") ?? "screen";
    const screen = await project.getScreen(screenId);
    await exportScreen(config, screen, { slug, operation: "export" });
    return;
  }

  throw new Error(`Unknown command: ${args.command}. Run with help to see available commands.`);
}

main().catch((error: unknown) => {
  if (error instanceof StitchError) {
    console.error(`Stitch ${error.code}: ${error.message}`);
  } else if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error("Unknown error.");
  }
  process.exitCode = 1;
});
