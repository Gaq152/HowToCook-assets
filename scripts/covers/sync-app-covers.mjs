#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../..');
const VERSION_PATTERN = /^\d{4}\.\d{2}\.\d{2}\.\d+$/;

function parseArgs(argv) {
  const result = {
    dataVersion: null,
    source: path.resolve(REPOSITORY_ROOT, '..', 'assets', 'covers'),
    target: path.join(REPOSITORY_ROOT, 'covers'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--data-version') result.dataVersion = argv[++index];
    else if (value === '--source') result.source = path.resolve(argv[++index]);
    else if (value === '--target') result.target = path.resolve(argv[++index]);
    else throw new Error(`未知参数: ${value}`);
  }
  if (!VERSION_PATTERN.test(result.dataVersion ?? '')) throw new Error('必须提供 --data-version YYYY.MM.DD.N');
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const manifestPath = path.join(REPOSITORY_ROOT, 'versions', '2', args.dataVersion, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`V2 manifest 不存在: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
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
    copied += 1;
    bytes += fs.statSync(source).size;
  }
  console.log(`已同步 ${copied} 张 APP 封面到静态兼容路径，共 ${bytes} bytes`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
