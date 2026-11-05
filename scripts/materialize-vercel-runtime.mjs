import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

const root = process.cwd();
const apiDist = join(root, "apps", "api", "dist");
const runtimeRoot = join(apiDist, "runtime-packages");
const workspacePackages = ["config", "core", "database", "sms"];
let rewrites = 0;

function relativeImport(fromFile, toFile) {
  let path = relative(dirname(fromFile), toFile).split(sep).join("/");
  if (!path.startsWith(".")) path = `./${path}`;
  return path;
}

async function findJavaScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await findJavaScriptFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(path);
  }
  return files;
}

async function rewriteWorkspaceImports(directory) {
  for (const file of await findJavaScriptFiles(directory)) {
    const source = await readFile(file, "utf8");
    const rewritten = source.replace(
      /((?:from\s*|import\()\s*["'])@tea-ledger\/(config|core|database|sms)(["'])/g,
      (_match, prefix, packageName, suffix) => {
        rewrites += 1;
        return `${prefix}${relativeImport(file, join(runtimeRoot, packageName, "dist", "index.js"))}${suffix}`;
      },
    );
    if (rewritten !== source) await writeFile(file, rewritten);
  }
}

async function assertNoBareWorkspaceImports(directory) {
  for (const file of await findJavaScriptFiles(directory)) {
    const source = await readFile(file, "utf8");
    if (/(?:from\s*|import\()\s*["']@tea-ledger\/(?:config|core|database|sms)["']/.test(source)) {
      throw new Error(`unresolved workspace runtime import in ${file}`);
    }
  }
}

// npm workspaces are linked during installation. Vercel's Lambda file tracer can
// omit those links, so build a self-contained, relative-import runtime tree.
await rm(runtimeRoot, { recursive: true, force: true });
await mkdir(runtimeRoot, { recursive: true });
for (const packageName of workspacePackages) {
  const source = join(root, "packages", packageName);
  const target = join(runtimeRoot, packageName);
  await mkdir(target, { recursive: true });
  await cp(join(source, "dist"), join(target, "dist"), { recursive: true });
  if (packageName === "database") {
    await cp(join(source, "migrations"), join(target, "migrations"), { recursive: true });
  }
}

await rewriteWorkspaceImports(apiDist);
await assertNoBareWorkspaceImports(apiDist);
console.log(`Materialized Vercel runtime modules (${rewrites} workspace imports rewritten).`);
