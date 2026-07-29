#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { validateStaging } from './validate.mjs';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../..');
const VERSION_PATTERN = /^\d{4}\.\d{2}\.\d{2}\.\d+$/;

function parseArgs(argv) {
  const result = { dataVersion: null, coverVersion: null, updateChannel: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--data-version') result.dataVersion = argv[++index];
    else if (value === '--cover-version') result.coverVersion = argv[++index];
    else if (value === '--update-channel') result.updateChannel = true;
    else throw new Error(`未知参数: ${value}`);
  }
  if (!VERSION_PATTERN.test(result.dataVersion ?? '')) throw new Error('必须提供 --data-version YYYY.MM.DD.N');
  if (!VERSION_PATTERN.test(result.coverVersion ?? '')) throw new Error('必须提供 --cover-version YYYY.MM.DD.N');
  return result;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { dataManifest, stagingRoot, records } = await validateStaging(args);
  const targetRoot = path.join(REPOSITORY_ROOT, 'covers', '2', args.coverVersion);
  const targetExists = fs.existsSync(targetRoot);
  if (targetExists && !args.updateChannel) {
    throw new Error(`封面版本已经发布，禁止覆盖: ${targetRoot}`);
  }

  const sorted = records.slice().sort((left, right) => left.recipe.id.localeCompare(right.recipe.id));
  const generatedTimes = sorted.map((item) => item.record.generatedAt).sort();
  const manifest = {
    schemaVersion: 2,
    mediaType: 'recipe-cover',
    coverVersion: args.coverVersion,
    dataVersion: args.dataVersion,
    generatedAt: generatedTimes.at(-1),
    sourceDataManifest: `versions/2/${args.dataVersion}/manifest.json`,
    promptVersion: sorted[0].record.promptVersion,
    totalCovers: sorted.length,
    totalBytes: sorted.reduce((sum, item) => sum + item.record.bytes, 0),
    covers: sorted.map(({ recipe, record }) => ({
      recipeId: recipe.id,
      recipeName: recipe.name,
      category: recipe.category,
      recipeHash: recipe.hash,
      path: `images/${recipe.category}/${recipe.id}.webp`,
      width: record.width,
      height: record.height,
      bytes: record.bytes,
      sha256: record.sha256,
      generationMode: record.generationMode,
      referenceImage: record.referenceImage,
      provider: record.provider,
      model: record.model,
      promptVersion: record.promptVersion,
      promptHash: record.promptHash,
    })),
  };
  if (!targetExists) {
    fs.mkdirSync(targetRoot, { recursive: true });
    fs.cpSync(path.join(stagingRoot, 'images'), path.join(targetRoot, 'images'), { recursive: true });
    writeJson(path.join(targetRoot, 'manifest.json'), manifest);
  } else {
    const existing = JSON.parse(fs.readFileSync(path.join(targetRoot, 'manifest.json'), 'utf8'));
    if (existing.coverVersion !== args.coverVersion
      || existing.dataVersion !== args.dataVersion
      || existing.totalCovers !== records.length) {
      throw new Error('已发布封面 manifest 与待切换通道的版本不一致');
    }
  }

  if (args.updateChannel) {
    writeJson(path.join(REPOSITORY_ROOT, 'channels', 'v2-covers-stable.json'), {
      schemaVersion: 2,
      channel: 'stable',
      mediaType: 'recipe-cover',
      coverVersion: args.coverVersion,
      dataVersion: args.dataVersion,
      manifestPath: `covers/2/${args.coverVersion}/manifest.json`,
      publishedAt: new Date().toISOString(),
    });
  }
  console.log(`${targetExists ? '复用' : '发布'}封面版本 covers/2/${args.coverVersion}`);
  console.log(args.updateChannel ? '稳定封面通道已切换。' : '稳定通道未切换；审核后再次执行并添加 --update-channel。');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
