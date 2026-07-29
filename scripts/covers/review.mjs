#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../..');
const VERSION_PATTERN = /^\d{4}\.\d{2}\.\d{2}\.\d+$/;

function parseArgs(argv) {
  const result = { coverVersion: null, onlyReplacements: false, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--cover-version') result.coverVersion = argv[++index];
    else if (value === '--only-replacements') result.onlyReplacements = true;
    else if (value === '--output') result.output = path.resolve(argv[++index]);
    else throw new Error(`未知参数: ${value}`);
  }
  if (!VERSION_PATTERN.test(result.coverVersion ?? '')) throw new Error('必须提供 --cover-version YYYY.MM.DD.N');
  return result;
}

function listJsonFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listJsonFiles(entryPath) : entry.name.endsWith('.json') ? [entryPath] : [];
  });
}

function escapeXml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const stagingRoot = path.join(REPOSITORY_ROOT, '.staging', 'covers', '2', args.coverVersion);
  let records = listJsonFiles(path.join(stagingRoot, 'records'))
    .map((recordPath) => JSON.parse(fs.readFileSync(recordPath, 'utf8')))
    .filter((record) => !args.onlyReplacements || record.replacedExistingCover)
    .sort((left, right) => left.recipeId.localeCompare(right.recipeId));
  if (records.length === 0) throw new Error('没有可生成联系表的封面记录');

  const columns = 5;
  const imageSize = 200;
  const labelHeight = 34;
  const tileHeight = imageSize + labelHeight;
  const rows = Math.ceil(records.length / columns);
  const width = columns * imageSize;
  const height = rows * tileHeight;
  const composites = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const left = (index % columns) * imageSize;
    const top = Math.floor(index / columns) * tileHeight;
    const imagePath = path.join(REPOSITORY_ROOT, ...record.outputPath.split('/'));
    const image = await sharp(imagePath).resize(imageSize, imageSize, { fit: 'cover' }).toBuffer();
    const label = Buffer.from(`<svg width="${imageSize}" height="${labelHeight}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#111827"/><text x="${imageSize / 2}" y="22" text-anchor="middle" font-family="Microsoft YaHei, sans-serif" font-size="16" fill="#ffffff">${escapeXml(record.recipeName)}</text></svg>`);
    composites.push({ input: image, left, top }, { input: label, left, top: top + imageSize });
  }
  const output = args.output ?? path.join(stagingRoot, args.onlyReplacements ? 'review-replacements.webp' : 'review-all.webp');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await sharp({ create: { width, height, channels: 3, background: '#e5e7eb' } })
    .composite(composites)
    .webp({ quality: 85 })
    .toFile(output);
  console.log(`已生成 ${records.length} 张封面联系表: ${output}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
