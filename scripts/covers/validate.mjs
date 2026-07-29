#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../..');
const VERSION_PATTERN = /^\d{4}\.\d{2}\.\d{2}\.\d+$/;

function parseArgs(argv) {
  const result = { dataVersion: null, coverVersion: null, allowPartial: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--data-version') result.dataVersion = argv[++index];
    else if (value === '--cover-version') result.coverVersion = argv[++index];
    else if (value === '--allow-partial') result.allowPartial = true;
    else throw new Error(`未知参数: ${value}`);
  }
  if (!VERSION_PATTERN.test(result.dataVersion ?? '')) throw new Error('必须提供 --data-version YYYY.MM.DD.N');
  if (!VERSION_PATTERN.test(result.coverVersion ?? '')) throw new Error('必须提供 --cover-version YYYY.MM.DD.N');
  return result;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function listFiles(root, extension) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  function scan(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) scan(fullPath);
      else if (!extension || entry.name.endsWith(extension)) files.push(fullPath);
    }
  }
  scan(root);
  return files.sort();
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function runPool(items, concurrency, worker) {
  let nextIndex = 0;
  async function run() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
}

export async function validateStaging({ dataVersion, coverVersion, allowPartial = false }) {
  const dataRoot = path.join(REPOSITORY_ROOT, 'versions', '2', dataVersion);
  const stagingRoot = path.join(REPOSITORY_ROOT, '.staging', 'covers', '2', coverVersion);
  const dataManifestPath = path.join(dataRoot, 'manifest.json');
  if (!fs.existsSync(dataManifestPath)) throw new Error(`V2 manifest 不存在: ${dataManifestPath}`);
  if (!fs.existsSync(stagingRoot)) throw new Error(`封面暂存目录不存在: ${stagingRoot}`);
  const dataManifest = readJson(dataManifestPath);
  const errors = [];
  const records = [];

  for (const recipe of dataManifest.recipes) {
    const recordPath = path.join(stagingRoot, 'records', recipe.category, `${recipe.id}.json`);
    const imagePath = path.join(stagingRoot, 'images', recipe.category, `${recipe.id}.webp`);
    if (allowPartial && !fs.existsSync(recordPath) && !fs.existsSync(imagePath)) continue;
    if (!fs.existsSync(recordPath)) {
      errors.push(`缺少生成记录: ${recipe.category}/${recipe.id}`);
      continue;
    }
    if (!fs.existsSync(imagePath)) {
      errors.push(`缺少封面文件: ${recipe.category}/${recipe.id}`);
      continue;
    }
    const record = readJson(recordPath);
    if (record.recipeId !== recipe.id) errors.push(`记录 recipeId 不匹配: ${recipe.name}`);
    if (record.recipeHash !== recipe.hash) errors.push(`菜谱更新后未重生成封面: ${recipe.name}`);
    if (record.dataVersion !== dataVersion) errors.push(`记录 dataVersion 不匹配: ${recipe.name}`);
    if (record.coverVersion !== coverVersion) errors.push(`记录 coverVersion 不匹配: ${recipe.name}`);
    const buffer = fs.readFileSync(imagePath);
    if (sha256(buffer) !== record.sha256) errors.push(`封面哈希不匹配: ${recipe.name}`);
    if (buffer.length !== record.bytes) errors.push(`封面大小不匹配: ${recipe.name}`);
    records.push({ recipe, record, imagePath });
  }

  const imageFiles = listFiles(path.join(stagingRoot, 'images'), '.webp');
  const recordFiles = listFiles(path.join(stagingRoot, 'records'), '.json');
  if (!allowPartial && imageFiles.length !== dataManifest.totalRecipes) {
    errors.push(`封面文件数应为 ${dataManifest.totalRecipes}，实际 ${imageFiles.length}`);
  }
  if (!allowPartial && recordFiles.length !== dataManifest.totalRecipes) {
    errors.push(`生成记录数应为 ${dataManifest.totalRecipes}，实际 ${recordFiles.length}`);
  }
  if (allowPartial && imageFiles.length !== recordFiles.length) {
    errors.push(`部分校验时封面与记录数量不一致: 图片 ${imageFiles.length}，记录 ${recordFiles.length}`);
  }

  await runPool(records, 8, async ({ recipe, record, imagePath }) => {
    try {
      const metadata = await sharp(imagePath).metadata();
      if (metadata.format !== 'webp') errors.push(`封面不是 WebP: ${recipe.name}`);
      if (metadata.width !== record.width || metadata.height !== record.height) {
        errors.push(`封面尺寸与记录不一致: ${recipe.name}`);
      }
      if (metadata.width !== metadata.height) errors.push(`封面不是正方形: ${recipe.name}`);
    } catch (error) {
      errors.push(`封面无法解码: ${recipe.name} (${error.message})`);
    }
  });

  if (errors.length > 0) {
    throw new Error(`封面校验失败（${errors.length} 项）:\n${errors.slice(0, 50).map((x) => `- ${x}`).join('\n')}`);
  }
  return { dataManifest, stagingRoot, records };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await validateStaging(args);
  const bytes = result.records.reduce((sum, item) => sum + item.record.bytes, 0);
  console.log(`${args.allowPartial ? '部分' : '全量'}校验通过: ${result.records.length} 张封面，${bytes} bytes`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
