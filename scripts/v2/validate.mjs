#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../..');
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseArgs(argv) {
  let version = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--data-version') version = argv[++index];
    else throw new Error(`未知参数: ${argv[index]}`);
  }
  if (!version) throw new Error('必须提供 --data-version');
  return { version };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function withoutHash(value) {
  const copy = structuredClone(value);
  delete copy.hash;
  return copy;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function listFiles(root, extension) {
  if (!fs.existsSync(root)) return [];
  const output = [];
  function scan(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) scan(fullPath);
      else if (entry.name.toLowerCase().endsWith(extension)) output.push(fullPath);
    }
  }
  scan(root);
  return output;
}

function collectStrings(value, output = []) {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, output));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => collectStrings(item, output));
  return output;
}

async function runPool(items, concurrency, worker) {
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
}

async function main() {
  const { version } = parseArgs(process.argv.slice(2));
  const root = path.join(REPOSITORY_ROOT, 'versions', '2', version);
  const manifestPath = path.join(root, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`manifest 不存在: ${manifestPath}`);

  const errors = [];
  const warnings = [];
  const fail = (message) => errors.push(message);
  const manifest = readJson(manifestPath);
  if (manifest.schemaVersion !== 2) fail('manifest.schemaVersion 必须为 2');
  if (manifest.dataVersion !== version) fail('manifest.dataVersion 与目录不一致');
  if (manifest.hash !== hashJson(withoutHash(manifest))) fail('manifest hash 不匹配');

  const recipeIds = new Set();
  const recipeNames = new Set();
  const legacyIds = new Set();
  const referencedImages = new Set();
  const recipes = [];
  for (const index of manifest.recipes ?? []) {
    const filePath = path.join(root, 'recipes', index.category, `${index.id}.json`);
    if (!fs.existsSync(filePath)) {
      fail(`菜谱文件不存在: ${index.id}`);
      continue;
    }
    const recipe = readJson(filePath);
    recipes.push(recipe);
    if (!UUID_V4.test(recipe.id)) fail(`菜谱不是 UUID v4: ${recipe.id}`);
    if (recipeIds.has(recipe.id)) fail(`重复菜谱 ID: ${recipe.id}`);
    recipeIds.add(recipe.id);
    const nameKey = `${recipe.category}\u0000${recipe.name}`;
    if (recipeNames.has(nameKey)) fail(`同分类重名菜谱: ${recipe.category}/${recipe.name}`);
    recipeNames.add(nameKey);
    for (const oldId of recipe.legacyIds ?? []) {
      if (legacyIds.has(oldId)) fail(`旧 ID 被映射多次: ${oldId}`);
      legacyIds.add(oldId);
    }
    if (recipe.schemaVersion !== 2) fail(`菜谱 schemaVersion 错误: ${recipe.name}`);
    if (!recipe.name?.trim()) fail(`菜谱名称为空: ${recipe.id}`);
    if (!recipe.description?.trim()) fail(`菜谱简介为空: ${recipe.name}`);
    if (!Number.isInteger(recipe.estimatedCaloriesKcal) || recipe.estimatedCaloriesKcal <= 0) {
      fail(`卡路里无效: ${recipe.name}`);
    }
    if (!Number.isInteger(recipe.difficulty) || recipe.difficulty < 1 || recipe.difficulty > 5) {
      fail(`难度无效: ${recipe.name}`);
    }
    if (!Array.isArray(recipe.requirements) || recipe.requirements.length === 0) {
      fail(`必备原料和工具为空: ${recipe.name}`);
    }
    if (!recipe.requirementsMarkdown?.trim()) fail(`requirementsMarkdown 为空: ${recipe.name}`);
    if (!Array.isArray(recipe.ingredients) || recipe.ingredients.length === 0) {
      fail(`计算后的食材为空: ${recipe.name}`);
    }
    if (!recipe.calculationMarkdown?.trim()) fail(`calculationMarkdown 为空: ${recipe.name}`);
    const actionableSteps = (recipe.steps ?? []).filter((step) => step.kind === 'step');
    if (actionableSteps.length === 0) fail(`操作步骤为空: ${recipe.name}`);
    for (const step of actionableSteps) {
      if (/^\s*\d+[.)]\s+/.test(step.description)) {
        fail(`步骤仍带源序号: ${recipe.name} -> ${step.description.slice(0, 40)}`);
      }
    }
    if (!recipe.operationMarkdown?.trim()) fail(`operationMarkdown 为空: ${recipe.name}`);
    if (recipe.hash !== hashJson(withoutHash(recipe))) fail(`菜谱 hash 不匹配: ${recipe.name}`);
    if (index.hash !== recipe.hash) fail(`manifest 菜谱 hash 不匹配: ${recipe.name}`);
    if (index.imageCount !== recipe.images.length) fail(`manifest 图片数不匹配: ${recipe.name}`);
    for (const image of recipe.images ?? []) {
      if (image.includes('\\')) fail(`图片路径包含反斜杠: ${recipe.name}/${image}`);
      if (!image.endsWith('.webp')) fail(`图片不是 WebP: ${recipe.name}/${image}`);
      referencedImages.add(image);
      if (!fs.existsSync(path.join(root, image))) fail(`图片不存在: ${recipe.name}/${image}`);
    }
  }

  const recipeFiles = listFiles(path.join(root, 'recipes'), '.json');
  if (recipeFiles.length !== manifest.totalRecipes) fail('菜谱文件数与 manifest.totalRecipes 不一致');
  if (recipeIds.size !== manifest.totalRecipes) fail('菜谱 ID 数与 manifest.totalRecipes 不一致');

  const tips = [];
  const tipIds = new Set();
  for (const index of manifest.tips ?? []) {
    const filePath = path.join(root, 'tips', index.category, `${index.id}.json`);
    if (!fs.existsSync(filePath)) {
      fail(`教程文件不存在: ${index.id}`);
      continue;
    }
    const tip = readJson(filePath);
    tips.push(tip);
    tipIds.add(tip.id);
    if (tip.hash !== hashJson(withoutHash(tip))) fail(`教程 hash 不匹配: ${tip.title}`);
    if (index.hash !== tip.hash) fail(`manifest 教程 hash 不匹配: ${tip.title}`);
  }
  if (tips.length !== manifest.totalTips) fail('教程文件数与 manifest.totalTips 不一致');

  const badTipLinks = [];
  for (const recipe of recipes) {
    for (const text of collectStrings(recipe)) {
      for (const match of text.matchAll(/tips:\/\/[^/\s]+\/([^)\s]+)/g)) {
        if (!tipIds.has(match[1])) badTipLinks.push(`${recipe.name}: ${match[0]}`);
      }
    }
  }
  badTipLinks.forEach((message) => fail(`教程链接无效: ${message}`));

  const imageFiles = listFiles(path.join(root, 'images'), '.webp');
  for (const imageFile of imageFiles) {
    const relative = path.relative(root, imageFile).replaceAll('\\', '/');
    if (!referencedImages.has(relative)) fail(`存在未引用的输出图片: ${relative}`);
  }
  if (imageFiles.length !== referencedImages.size) fail('输出图片数与引用数不一致');
  await runPool(imageFiles, 8, async (imageFile) => {
    try {
      const metadata = await sharp(imageFile).metadata();
      if (metadata.format !== 'webp' || !metadata.width || !metadata.height) {
        fail(`图片无法识别为有效 WebP: ${imageFile}`);
      }
    } catch (error) {
      fail(`图片解码失败: ${imageFile} (${error.message})`);
    }
  });

  const migrationPath = path.join(root, manifest.migrations?.recipeIdsV1ToV2 ?? '');
  if (!fs.existsSync(migrationPath)) fail('V1 -> V2 ID 迁移文件不存在');
  else {
    const migration = readJson(migrationPath);
    const mappedOldIds = new Set();
    for (const mapping of migration.mappings ?? []) {
      if (mappedOldIds.has(mapping.oldId)) fail(`迁移文件旧 ID 重复: ${mapping.oldId}`);
      mappedOldIds.add(mapping.oldId);
      if (!recipeIds.has(mapping.newId)) fail(`迁移目标 UUID 不存在: ${mapping.newId}`);
    }
    if (mappedOldIds.size !== legacyIds.size) fail('迁移映射数量与菜谱 legacyIds 不一致');
  }

  const chiffon = recipes.find((recipe) => recipe.name === '戚风蛋糕');
  if (!chiffon || chiffon.ingredients.length === 0 || !chiffon.calculationMarkdown.includes('|')) {
    fail('戚风蛋糕表格配方未完整保留');
  }

  const report = {
    schemaVersion: 1,
    dataVersion: version,
    validatedAt: manifest.generatedAt,
    status: errors.length === 0 ? 'passed' : 'failed',
    counts: {
      recipes: recipes.length,
      tips: tips.length,
      images: imageFiles.length,
      recipesWithoutImages: recipes.filter((recipe) => recipe.images.length === 0).length,
      legacyIdMappings: legacyIds.size,
      tipLinks: recipes.flatMap((recipe) => collectStrings(recipe)).reduce(
        (sum, text) => sum + [...text.matchAll(/tips:\/\//g)].length,
        0,
      ),
    },
    warnings,
    errors,
  };
  fs.writeFileSync(path.join(root, 'validation-report.json'), `${JSON.stringify(report, null, 2)}\n`);

  if (errors.length > 0) {
    console.error(`校验失败，共 ${errors.length} 项:`);
    errors.slice(0, 100).forEach((error) => console.error(`- ${error}`));
    process.exitCode = 1;
    return;
  }
  console.log(`校验通过: ${recipes.length} 个菜谱, ${tips.length} 个教程, ${imageFiles.length} 张图片`);
  console.log(`旧 ID 映射: ${legacyIds.size} 条；无图菜谱: ${report.counts.recipesWithoutImages} 个`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
