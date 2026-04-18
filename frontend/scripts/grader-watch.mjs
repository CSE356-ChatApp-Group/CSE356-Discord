#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const DEFAULT_URL = 'https://grading.cse356.compas.cs.stonybrook.edu/dashboard#projectapi';
const DEFAULT_INTERVAL_MS = 15000;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_EMPTY_POLLS = 8;

const cwd = process.cwd();
const userDataDir = path.resolve(cwd, '.playwright/grader-user-data');
const outputDir = path.resolve(cwd, '../artifacts/rollout-monitoring');
const eventsPath = path.join(outputDir, 'grader-watch-events.jsonl');
const latestPath = path.join(outputDir, 'grader-watch-latest.txt');

function getArgValue(name, fallback = undefined) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function nowIso() {
  return new Date().toISOString();
}

function ensureDirs() {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
}

function appendEvent(event) {
  fs.appendFileSync(eventsPath, `${JSON.stringify(event)}\n`);
}

function writeLatest(message) {
  fs.writeFileSync(latestPath, message, 'utf8');
}

async function notifyDiscord(title, body) {
  const url = process.env.DISCORD_WEBHOOK_URL_PROD || process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;
  const content = `${title}\n\`\`\`\n${body.slice(0, 1800)}\n\`\`\``;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
  } catch {
    // Silent — never let alerting break the watcher
  }
}

function normalizeText(value) {
  return value.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

function deriveErrorSignature(text) {
  const lines = normalizeText(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^Last error\b/i.test(line))
    .filter((line) => !/^View history\b/i.test(line));
  return lines.join('\n').trim();
}

function truncateAtKnownSection(text) {
  const endIdx = text.search(
    /\n(?:API Test Submission|API Test Results|Feedback|Working|Authentication|Profile & Presence|Communities|Channels|Direct Conversations|Messaging|Search|Read State)\b/i
  );
  if (endIdx === -1) return text;
  return text.slice(0, endIdx).trim();
}

async function extractErrorBlock(page) {
  const bodyText = normalizeText(await page.locator('body').innerText());

  const lastErrorIdx = bodyText.indexOf('Last error');
  if (lastErrorIdx === -1) {
    return null;
  }

  const tail = bodyText.slice(lastErrorIdx);
  const cleaned = truncateAtKnownSection(normalizeText(tail));

  if (!cleaned) return null;
  return cleaned;
}

async function waitForFirstSignal(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const block = await extractErrorBlock(page);
    if (block) return block;
    await page.waitForTimeout(500);
  }
  return null;
}

async function main() {
  const url = getArgValue('--url', DEFAULT_URL);
  const intervalMs = Number(getArgValue('--interval-ms', String(DEFAULT_INTERVAL_MS)));
  const timeoutMs = Number(getArgValue('--timeout-ms', String(DEFAULT_TIMEOUT_MS)));
  const maxEmptyPolls = Number(getArgValue('--max-empty-polls', String(DEFAULT_MAX_EMPTY_POLLS)));
  const headed = hasFlag('--headed');
  const requireLogin = hasFlag('--require-login');
  const once = hasFlag('--once');
  const cdpUrl = getArgValue('--cdp-url');

  ensureDirs();

  console.log(`[${nowIso()}] grader-watch starting`);
  console.log(`url=${url}`);
  console.log(`events=${eventsPath}`);
  console.log(`latest=${latestPath}`);
  console.log(`profile=${userDataDir}`);

  let browser = null;
  let context = null;
  if (cdpUrl) {
    console.log(`cdp=${cdpUrl}`);
    browser = await chromium.connectOverCDP(cdpUrl);
    context = browser.contexts()[0];
    if (!context) {
      throw new Error('No browser context found via CDP. Open at least one tab in the debug Chrome instance.');
    }
  } else {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: !headed,
      viewport: { width: 1440, height: 900 },
    });
  }

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    if (requireLogin) {
      console.log('Login mode enabled. Complete login in browser, then press Ctrl+C.');
      await new Promise(() => {});
    }

    const first = await waitForFirstSignal(page, timeoutMs);
    let previous = first;
    let previousSignature = first ? deriveErrorSignature(first) : '';
    let emptyPolls = first ? 0 : 1;

    if (first) {
      const event = {
        ts: nowIso(),
        kind: 'snapshot',
        change: 'initial',
        signature: previousSignature,
        text: first,
      };
      appendEvent(event);
      writeLatest(first);
      console.log(`[${event.ts}] initial snapshot captured`);
      console.log(first);
    } else {
      const event = {
        ts: nowIso(),
        kind: 'warning',
        change: 'no_error_block_detected',
        text:
          'Could not find "Last error" block. If this is first run, use --headed --require-login, or attach to logged-in Chrome via --cdp-url http://127.0.0.1:9222.',
      };
      appendEvent(event);
      console.error(`[${event.ts}] ${event.text}`);
    }

    if (once) return;

    // Continuous diff monitor for rollout gates and incident response.
    while (true) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs });
      const current =
        (await waitForFirstSignal(page, Math.min(timeoutMs, 8000))) ?? (await extractErrorBlock(page));

      if (!current) {
        emptyPolls += 1;
        const warning = {
          ts: nowIso(),
          kind: 'warning',
          change: 'empty_poll',
          emptyPolls,
          text: 'No "Last error" block detected on this poll',
        };
        appendEvent(warning);
        console.error(`[${warning.ts}] ${warning.text} (count=${emptyPolls})`);
        if (emptyPolls >= maxEmptyPolls) {
          const fail = {
            ts: nowIso(),
            kind: 'error',
            change: 'empty_poll_threshold_exceeded',
            emptyPolls,
            text: 'Exceeded empty poll threshold; exiting non-zero for rollout gate.',
          };
          appendEvent(fail);
          console.error(`[${fail.ts}] ${fail.text}`);
          process.exitCode = 2;
          return;
        }
      } else {
        emptyPolls = 0;
        const currentSignature = deriveErrorSignature(current);
        if (currentSignature !== previousSignature) {
          const event = {
            ts: nowIso(),
            kind: 'update',
            change: 'error_block_changed',
            signature: currentSignature,
            text: current,
          };
          appendEvent(event);
          writeLatest(current);
          console.log(`[${event.ts}] dashboard error block changed`);
          console.log(current);
          await notifyDiscord(':rotating_light: **Grader error changed**', currentSignature);
          previous = current;
          previousSignature = currentSignature;
        } else {
          console.log(`[${nowIso()}] no change`);
          previous = current;
        }
      }

      await page.waitForTimeout(intervalMs);
    }
  } finally {
    if (browser) {
      await browser.close();
    } else {
      await context.close();
    }
  }
}

main().catch((error) => {
  const event = {
    ts: nowIso(),
    kind: 'error',
    change: 'watcher_exception',
    text: String(error?.stack || error),
  };
  try {
    ensureDirs();
    appendEvent(event);
  } catch {
    // If filesystem write fails, still print the root failure.
  }
  console.error(`[${event.ts}] ${event.text}`);
  process.exit(1);
});
