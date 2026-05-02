#!/usr/bin/env node
/**
 * Writes backend/dist/.build-sha after tsc so release tarballs can prove which
 * commit produced the compiled dist (see scripts/release/verify-backend-dist-release-sha.sh).
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const backendRoot = path.join(__dirname, "..");
const distDir = path.join(backendRoot, "dist");
const repoRoot = path.join(backendRoot, "..");
const outFile = path.join(distDir, ".build-sha");

if (!fs.existsSync(distDir)) {
  console.error("write-dist-build-metadata: backend/dist is missing; run tsc before this step.");
  process.exit(1);
}

let sha;
try {
  sha = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
} catch (e) {
  console.error(
    "write-dist-build-metadata: git rev-parse HEAD failed (is this a git checkout?).",
  );
  process.exit(1);
}

if (!/^[0-9a-f]{40}$/i.test(sha)) {
  console.error(`write-dist-build-metadata: unexpected SHA from git: ${sha}`);
  process.exit(1);
}

fs.writeFileSync(outFile, `${sha}\n`, "utf8");
console.log(`write-dist-build-metadata: wrote ${path.relative(repoRoot, outFile)} (${sha})`);
