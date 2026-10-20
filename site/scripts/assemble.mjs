// Assembles dist/ for the aj-demos Pages project (Platform M6):
//   public/ (status page, headers, redirects) + each enabled demo's web build in dist/<slug>/.
// A demo comes from the latest GitHub Release asset web-dist.zip of its repo (public URL), or from a local
// build with `--local <slug>=<dir>`. A missing demo fails the build, so the previous deploy stays live.
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

const site = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(site, "dist");
const { owner, projects } = JSON.parse(
  await import("node:fs").then((fs) => fs.readFileSync(join(site, "projects.json"), "utf8")),
);

const local = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((_, i, a) => a[i - 1] === "--local")
    .map((pair) => pair.split("=", 2)),
);

rmSync(dist, { recursive: true, force: true });
cpSync(join(site, "public"), dist, { recursive: true });
cpSync(join(site, "projects.json"), join(dist, "projects.json"));

const failures = [];
for (const p of projects.filter((x) => x.enabled)) {
  const target = join(dist, p.slug);
  mkdirSync(target, { recursive: true });
  if (local[p.slug]) {
    if (!existsSync(join(local[p.slug], "index.html"))) {
      failures.push(`${p.slug}: no index.html in ${local[p.slug]}`);
      continue;
    }
    cpSync(local[p.slug], target, { recursive: true });
    console.log(`${p.slug}: copied local build ${local[p.slug]}`);
    continue;
  }
  const url = `https://github.com/${owner}/${p.repo}/releases/latest/download/web-dist.zip`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    failures.push(`${p.slug}: ${url} → HTTP ${res.status}`);
    continue;
  }
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
  for (const [name, bytes] of Object.entries(files)) {
    if (name.endsWith("/")) continue;
    const out = join(target, name);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, bytes);
  }
  if (!existsSync(join(target, "index.html"))) failures.push(`${p.slug}: web-dist.zip has no index.html`);
  console.log(`${p.slug}: ${Object.keys(files).length} files from ${url}`);
}

if (failures.length) {
  console.error(`assemble failed — keeping the previous deploy:\n  ${failures.join("\n  ")}`);
  process.exitCode = 1;
} else {
  console.log(`dist/ ready (${projects.filter((x) => x.enabled).length} demo(s))`);
}
