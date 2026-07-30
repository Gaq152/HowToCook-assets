#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../..');
const VERSION_PATTERN = /^\d{4}\.\d{2}\.\d{2}\.\d+$/;

function parseArgs(argv) {
  const result = {
    dataVersion: null,
    snapshotVersion: null,
    aiCoverVersion: null,
    rebuild: false,
    source: path.resolve(REPOSITORY_ROOT, '..', 'assets', 'covers'),
    target: path.join(REPOSITORY_ROOT, 'covers'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--data-version') result.dataVersion = argv[++index];
    else if (value === '--snapshot-version') result.snapshotVersion = argv[++index];
    else if (value === '--ai-cover-version') result.aiCoverVersion = argv[++index];
    else if (value === '--rebuild') result.rebuild = true;
    else if (value === '--source') result.source = path.resolve(argv[++index]);
    else if (value === '--target') result.target = path.resolve(argv[++index]);
    else throw new Error(`未知参数: ${value}`);
  }
  if (!VERSION_PATTERN.test(result.dataVersion ?? '')) throw new Error('必须提供 --data-version YYYY.MM.DD.N');
  if (!VERSION_PATTERN.test(result.snapshotVersion ?? '')) throw new Error('必须提供 --snapshot-version YYYY.MM.DD.N');
  if (!VERSION_PATTERN.test(result.aiCoverVersion ?? '')) throw new Error('必须提供 --ai-cover-version YYYY.MM.DD.N');
  return result;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function compareVersions(left, right) {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const manifestPath = path.join(REPOSITORY_ROOT, 'versions', '2', args.dataVersion, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`V2 manifest 不存在: ${manifestPath}`);
  const manifest = readJson(manifestPath);
  const currentSnapshotPath = path.join(args.target, 'manifest.json');
  if (fs.existsSync(currentSnapshotPath) && !args.rebuild) {
    const currentSnapshot = readJson(currentSnapshotPath);
    if (compareVersions(args.snapshotVersion, currentSnapshot.coverVersion ?? '0') <= 0) {
      throw new Error(`快照版本必须高于已发布版本 ${currentSnapshot.coverVersion}；首次提交前重建请显式添加 --rebuild`);
    }
  }
  const aiStagingRoot = path.join(REPOSITORY_ROOT, '.staging', 'covers', '2', args.aiCoverVersion);
  const snapshotEntries = [];
  const generatedTimes = [];
  let copied = 0;
  let bytes = 0;
  for (const recipe of [...manifest.recipes].sort((left, right) => left.id.localeCompare(right.id))) {
    const relativePath = path.join(recipe.category, `${recipe.name}.webp`);
    const source = path.join(args.source, relativePath);
    const target = path.join(args.target, relativePath);
    if (!fs.existsSync(source)) throw new Error(`APP 封面不存在: ${source}`);
    const metadata = await sharp(source).metadata();
    if (metadata.format !== 'webp') throw new Error(`APP 封面不是 WebP: ${source}`);
    if (metadata.width !== metadata.height || metadata.width < 256) {
      throw new Error(`APP 封面尺寸不合格: ${source} (${metadata.width}x${metadata.height})`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    const buffer = fs.readFileSync(source);
    const imageHash = sha256(buffer);
    const recordPath = path.join(aiStagingRoot, 'records', recipe.category, `${recipe.id}.json`);
    let aiRecord = null;
    if (fs.existsSync(recordPath)) {
      const candidate = readJson(recordPath);
      if (candidate.recipeId === recipe.id && candidate.sha256 === imageHash) {
        aiRecord = candidate;
        if (candidate.generatedAt) generatedTimes.push(candidate.generatedAt);
      }
    }
    snapshotEntries.push({
      recipeId: recipe.id,
      recipeName: recipe.name,
      category: recipe.category,
      path: path.posix.join('covers', recipe.category, `${recipe.name}.webp`),
      sha256: imageHash,
      bytes: buffer.length,
      width: metadata.width,
      height: metadata.height,
      aiGenerated: aiRecord != null,
      aiCoverVersion: aiRecord?.coverVersion ?? null,
    });
    copied += 1;
    bytes += buffer.length;
  }

  const publishedAt = new Date().toISOString();
  const snapshotManifest = {
    schemaVersion: 2,
    mediaType: 'recipe-cover-snapshot',
    coverVersion: args.snapshotVersion,
    dataVersion: args.dataVersion,
    generatedAt: generatedTimes.sort().at(-1) ?? manifest.generatedAt ?? publishedAt,
    publishedAt,
    totalCovers: snapshotEntries.length,
    aiGeneratedCovers: snapshotEntries.filter((entry) => entry.aiGenerated).length,
    totalBytes: bytes,
    covers: snapshotEntries,
  };
  writeJson(path.join(args.source, 'manifest.json'), snapshotManifest);
  writeJson(path.join(args.target, 'manifest.json'), snapshotManifest);
  writeJson(path.join(REPOSITORY_ROOT, 'channels', 'v2-covers-stable.json'), {
    schemaVersion: 2,
    channel: 'stable',
    mediaType: 'recipe-cover-snapshot',
    coverVersion: args.snapshotVersion,
    dataVersion: args.dataVersion,
    manifestPath: 'covers/manifest.json',
    publishedAt,
  });

  console.log(`已同步 ${copied} 张 APP 封面到静态兼容路径，共 ${bytes} bytes`);
  console.log(`封面快照 ${args.snapshotVersion}: ${snapshotManifest.aiGeneratedCovers} 张 AI 封面`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
