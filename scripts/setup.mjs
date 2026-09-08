/**
 * Fetches the Live2D Cubism runtime, which is not redistributed in this repo.
 *
 * Pulls two pieces:
 *   public/core/live2dcubismcore.min.js   the closed-source Core, from Live2D's CDN
 *   vendor/CubismWebFramework             the open-source framework, pinned
 *
 * The framework tag matters: releases newer than the CDN Core reference APIs the
 * Core does not have (5-r.5 expects `model.offscreens`, added in Cubism 5.3) and
 * crash on model load. Keep these two in step.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CORE_URL = 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js';
const FRAMEWORK_REPO = 'https://github.com/Live2D/CubismWebFramework.git';
const FRAMEWORK_TAG = '5-r.4';

const corePath = resolve(root, 'public/core/live2dcubismcore.min.js');
const frameworkPath = resolve(root, 'vendor/CubismWebFramework');

async function fetchCore() {
  if (existsSync(corePath)) return console.log('core: already present');
  mkdirSync(dirname(corePath), { recursive: true });
  const res = await fetch(CORE_URL);
  if (!res.ok) throw new Error(`core download failed: ${res.status}`);
  writeFileSync(corePath, Buffer.from(await res.arrayBuffer()));
  console.log('core: downloaded');
}

function fetchFramework() {
  if (existsSync(frameworkPath)) return console.log('framework: already present');
  mkdirSync(dirname(frameworkPath), { recursive: true });
  execFileSync(
    'git',
    ['clone', '--depth', '1', '--branch', FRAMEWORK_TAG, FRAMEWORK_REPO, frameworkPath],
    { stdio: 'inherit' }
  );
  console.log(`framework: cloned at ${FRAMEWORK_TAG}`);
}

await fetchCore();
fetchFramework();

console.log(
  '\nBy using the Cubism SDK you accept Live2D\'s licence: https://www.live2d.com/en/sdk/license/'
);
console.log('Next: put a model under public/models/ (see README), then `npm run dev`.');
