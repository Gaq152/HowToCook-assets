#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../..');
const VERSION_PATTERN = /^\d{4}\.\d{2}\.\d{2}\.\d+$/;

function parseArgs(argv) {
  const result = { coverVersion: null, outputSize: 512, webpQuality: 80 };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--cover-version') result.coverVersion = argv[++index];
    else if (value === '--output-size') result.outputSize = Number(argv[++index]);
    else if (value === '--webp-quality') result.webpQuality = Number(argv[++index]);
    else throw new Error(`未知参数: ${value}`);
  }
  if (!VERSION_PATTERN.test(result.coverVersion ?? '')) throw new Error('必须提供 --cover-version YYYY.MM.DD.N');
  if (!Number.isInteger(result.outputSize) || result.outputSize < 256 || result.outputSize > 2048) {
    throw new Error('--output-size 必须是 256-2048');
  }
  if (!Number.isInteger(result.webpQuality) || result.webpQuality < 1 || result.webpQuality > 100) {
    throw new Error('--webp-quality 必须是 1-100');
  }
  return result;
}

function listJsonFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listJsonFiles(entryPath) : entry.name.endsWith('.json') ? [entryPath] : [];
  });
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const stagingRoot = path.join(REPOSITORY_ROOT, '.staging', 'covers', '2', args.coverVersion);
  const records = listJsonFiles(path.join(stagingRoot, 'records'));
  if (records.length === 0) throw new Error(`没有找到生成记录: ${stagingRoot}`);

  let optimized = 0;
  let originalBytes = 0;
  let optimizedBytes = 0;
  for (const recordPath of records) {
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    const imagePath = path.join(REPOSITORY_ROOT, ...record.outputPath.split('/'));
    if (!fs.existsSync(imagePath)) throw new Error(`生成图片不存在: ${imagePath}`);
    const input = fs.readFileSync(imagePath);
    const output = await sharp(input)
      .rotate()
      .resize(args.outputSize, args.outputSize, { fit: 'cover', position: 'attention' })
      .webp({ quality: args.webpQuality, effort: 5 })
      .toBuffer();
    const metadata = await sharp(output).metadata();
    fs.writeFileSync(imagePath, output);
    fs.writeFileSync(recordPath, `${JSON.stringify({
      ...record,
      outputSize: args.outputSize,
      webpQuality: args.webpQuality,
      sha256: sha256(output),
      bytes: output.length,
      width: metadata.width,
      height: metadata.height,
      optimizedAt: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8');
    optimized += 1;
    originalBytes += input.length;
    optimizedBytes += output.length;
  }

  console.log(`已优化 ${optimized} 张封面为 ${args.outputSize}x${args.outputSize} WebP（质量 ${args.webpQuality}）`);
  console.log(`体积: ${originalBytes} -> ${optimizedBytes} 字节（${((1 - optimizedBytes / originalBytes) * 100).toFixed(1)}% 减少）`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
