#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const dashboardRoots = [
  'infrastructure/monitoring/grafana-provisioning/dashboards',
  'infrastructure/monitoring/grafana-provisioning-remote/dashboards',
].map((dir) => path.join(repoRoot, dir));

const requiredPanelsByFile = new Map([
  ['chatapp-overview.json', [
    'Fanout target cache (rate by path + result)',
    'Realtime fanout stage p95 (ms)',
    'Realtime fanout publish vs candidate targets p95',
    'WS bootstrap channel count p95',
    'WS bootstrap list cache (rate by result)',
  ]],
]);

function walkJsonFiles(rootDir) {
  const found = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      found.push(...walkJsonFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.json')) {
      found.push(fullPath);
    }
  }
  return found;
}

function flattenPanels(panels) {
  const flat = [];
  for (const panel of panels || []) {
    flat.push(panel);
    if (Array.isArray(panel?.panels)) {
      flat.push(...flattenPanels(panel.panels));
    }
  }
  return flat;
}

const dashboardFiles = dashboardRoots.flatMap(walkJsonFiles);
if (!dashboardFiles.length) {
  throw new Error('No Grafana dashboard JSON files found');
}

for (const file of dashboardFiles) {
  const raw = fs.readFileSync(file, 'utf8');
  const dashboard = JSON.parse(raw);

  if (!dashboard || typeof dashboard !== 'object') {
    throw new Error(`${file}: dashboard JSON did not parse to an object`);
  }
  if (!Array.isArray(dashboard.panels)) {
    throw new Error(`${file}: dashboard is missing a top-level panels array`);
  }

  const flatPanels = flattenPanels(dashboard.panels);
  const titles = new Set(flatPanels.map((panel) => panel?.title).filter(Boolean));
  const requiredTitles = requiredPanelsByFile.get(path.basename(file)) || [];
  for (const title of requiredTitles) {
    if (!titles.has(title)) {
      throw new Error(`${file}: missing required panel "${title}"`);
    }
  }
}

console.log(`Validated ${dashboardFiles.length} Grafana dashboard JSON files.`);
