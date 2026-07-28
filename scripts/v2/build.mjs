#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import {
  normalizeSourcePath,
  parseRecipeFile,
  parseTipFile,
  replaceTipLinks,
  resolveLocalImages,
} from './lib/markdown.mjs';
import {
  assignRecipeIds,
  buildLegacyMigration,
  loadRegistry,
} from './lib/id-registry.mjs';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../..');
const CATEGORY_NAMES = {
  aquatic: '水产',
  breakfast: '早餐',
  condiment: '调料',
  dessert: '甜品',
  drink: '饮料',
  meat_dish: '荤菜',
  'semi-finished': '半成品',
  soup: '汤粥',
  staple: '主食',
  vegetable_dish: '素菜',
};
const TIP_CATEGORY_NAMES = {
  advanced: '进阶知识',
  learn: '基础技法',
  general: '基础知识',
};

function parseArgs(argv) {
  const result = { source: 'origin', version: null, updateRegistry: false, rebuild: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--source') result.source = argv[++index];
    else if (value === '--data-version') result.version = argv[++index];
    else if (value === '--update-registry') result.updateRegistry = true;
    else if (value === '--rebuild') result.rebuild = true;
    else throw new Error(`未知参数: ${value}`);
  }
  if (!result.version || !/^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(result.version)) {
    throw new Error('必须提供 --data-version YYYY.MM.DD.N');
  }
  return result;
}

function listFiles(root, extension) {
  const files = [];
  function scan(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) scan(fullPath);
      else if (entry.name.toLowerCase().endsWith(extension)) files.push(fullPath);
    }
  }
  scan(root);
  return files.sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function hashJson(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function assertSafeVersionTarget(target) {
  const versionsRoot = path.join(REPOSITORY_ROOT, 'versions', '2');
  const relative = path.relative(versionsRoot, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`拒绝清理非版本目录: ${target}`);
  }
}

function cleanVersionTarget(target, rebuild) {
  assertSafeVersionTarget(target);
  if (fs.existsSync(target) && !rebuild) {
    throw new Error(`版本目录已存在且不可原地覆盖: ${target}；仅在发布前验证可复现性时使用 --rebuild`);
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
}

function legacyTipId(title, category) {
  const cleaned = title.replace(/[^\w\u4e00-\u9fa5]/g, '');
  const digest = crypto.createHash('md5').update(cleaned + category).digest('hex').slice(0, 8);
  return `tips_${category}_${digest}`;
}

function sourceCommitInfo(sourceRoot) {
  const commit = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const committedAt = execFileSync(
    'git',
    ['-C', sourceRoot, 'show', '-s', '--format=%cI', 'HEAD'],
    { encoding: 'utf8' },
  ).trim();
  return { commit, committedAt };
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function transformRecipeStrings(recipe, tipsPathToId) {
  const convert = (value) => replaceTipLinks(value, recipe.sourceFile, tipsPathToId);
  return {
    ...recipe,
    requirements: recipe.requirements.map((item) => ({
      ...item,
      text: convert(item.text),
      markdown: convert(item.markdown),
    })),
    ingredients: recipe.ingredients.map((item) => ({ ...item, text: convert(item.text) })),
    calculationNotes: recipe.calculationNotes.map(convert),
    steps: recipe.steps.map((item) => ({ ...item, description: convert(item.description) })),
    tools: recipe.tools.map(convert),
    tips: convert(recipe.tips),
    requirementsMarkdown: convert(recipe.requirementsMarkdown),
    calculationMarkdown: convert(recipe.calculationMarkdown),
    operationMarkdown: convert(recipe.operationMarkdown),
    additionalMarkdown: convert(recipe.additionalMarkdown),
  };
}

async function runPool(items, concurrency, worker) {
  let nextIndex = 0;
  async function run() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
}

function categorySummary(items, nameMap) {
  const summary = {};
  for (const item of items) {
    summary[item.category] ??= { name: nameMap[item.category] ?? item.category, count: 0 };
    summary[item.category].count += 1;
  }
  return Object.fromEntries(Object.entries(summary).sort(([left], [right]) => left.localeCompare(right)));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceRoot = path.resolve(REPOSITORY_ROOT, args.source);
  const dishesRoot = path.join(sourceRoot, 'dishes');
  const tipsRoot = path.join(sourceRoot, 'tips');
  const outputRoot = path.join(REPOSITORY_ROOT, 'versions', '2', args.version);
  const registryPath = path.join(REPOSITORY_ROOT, 'data', 'recipe-id-registry.json');
  const exclusionsPath = path.join(REPOSITORY_ROOT, 'data', 'recipe-exclusions.json');
  const legacyManifestPath = path.join(REPOSITORY_ROOT, 'manifest.json');

  if (!fs.existsSync(dishesRoot) || !fs.existsSync(tipsRoot)) {
    throw new Error(`源数据不完整: ${sourceRoot}`);
  }

  const { commit, committedAt } = sourceCommitInfo(sourceRoot);
  const exclusions = JSON.parse(fs.readFileSync(exclusionsPath, 'utf8'));
  const excludedPaths = new Set(exclusions.recipes.map((item) => normalizeSourcePath(item.sourcePath)));
  const legacyManifest = JSON.parse(fs.readFileSync(legacyManifestPath, 'utf8'));
  // 使用源提交时间保证同一 dataVersion 的全量构建可复现。
  const generatedAt = committedAt;

  console.log(`源提交: ${commit}`);
  console.log(`数据版本: ${args.version}`);
  cleanVersionTarget(outputRoot, args.rebuild);

  const legacyTips = new Map(
    (legacyManifest.tips ?? []).map((item) => [`${item.category}\u0000${item.title}`, item]),
  );
  const parsedTips = listFiles(tipsRoot, '.md').map((filePath) => parseTipFile(filePath, tipsRoot));
  const tips = parsedTips.map((tip) => {
    const old = legacyTips.get(`${tip.category}\u0000${tip.title}`);
    return { ...tip, id: old?.id ?? legacyTipId(tip.title, tip.category) };
  });
  const tipsPathToId = new Map(
    tips.map((tip) => [normalizeSourcePath(path.resolve(tipsRoot, tip.sourcePath)), tip]),
  );

  const sourceRecipeFiles = listFiles(dishesRoot, '.md').filter((filePath) => {
    const relative = normalizeSourcePath(path.relative(dishesRoot, filePath));
    return !relative.startsWith('template/') && !excludedPaths.has(relative);
  });
  const parsedRecipes = sourceRecipeFiles.map((filePath) => parseRecipeFile(filePath, dishesRoot));

  const duplicateNames = new Map();
  for (const recipe of parsedRecipes) {
    const key = `${recipe.category}\u0000${recipe.name}`;
    if (!duplicateNames.has(key)) duplicateNames.set(key, []);
    duplicateNames.get(key).push(recipe.sourcePath);
  }
  const duplicates = [...duplicateNames.entries()].filter(([, paths]) => paths.length > 1);
  if (duplicates.length > 0) {
    throw new Error(`存在未处理的同分类同名菜谱: ${JSON.stringify(duplicates)}`);
  }

  const registry = loadRegistry(registryPath);
  const assignment = assignRecipeIds({
    recipes: parsedRecipes,
    registry,
    legacyManifest,
    updateRegistry: args.updateRegistry,
  });
  const recipes = assignment.recipes.map((recipe) => transformRecipeStrings(recipe, tipsPathToId));
  if (args.updateRegistry) writeJson(registryPath, assignment.registry);

  const migration = buildLegacyMigration(recipes, args.version);
  writeJson(path.join(outputRoot, 'migrations', 'recipe-id-v1-to-v2.json'), migration);
  writeJson(path.join(REPOSITORY_ROOT, 'migrations', 'recipe-id-v1-to-v2.json'), migration);

  const imageJobs = [];
  for (const recipe of recipes) {
    const resolved = resolveLocalImages(recipe);
    recipe.externalImages = resolved.external;
    recipe.images = resolved.local.map((image, index) => {
      if (!fs.existsSync(image.absolutePath)) {
        throw new Error(`图片不存在: ${recipe.sourcePath} -> ${image.rawUrl}`);
      }
      const relativeOutput = `images/${recipe.category}/${recipe.id}_${index}.webp`;
      imageJobs.push({ source: image.absolutePath, target: path.join(outputRoot, relativeOutput) });
      return relativeOutput;
    });
  }

  console.log(`转换图片: ${imageJobs.length} 张`);
  await runPool(imageJobs, 4, async (job) => {
    fs.mkdirSync(path.dirname(job.target), { recursive: true });
    await sharp(job.source).rotate().webp({ quality: 85 }).toFile(job.target);
  });

  const recipeOutputs = [];
  for (const recipe of recipes) {
    const output = {
      schemaVersion: 2,
      id: recipe.id,
      legacyIds: recipe.legacyIds,
      name: recipe.name,
      description: recipe.description,
      category: recipe.category,
      categoryName: CATEGORY_NAMES[recipe.category] ?? recipe.category,
      difficulty: recipe.difficulty,
      estimatedCaloriesKcal: recipe.estimatedCaloriesKcal,
      requirements: recipe.requirements,
      requirementsMarkdown: recipe.requirementsMarkdown,
      ingredients: recipe.ingredients,
      tools: uniqueStrings(recipe.tools),
      calculationMarkdown: recipe.calculationMarkdown,
      calculationNotes: recipe.calculationNotes,
      steps: recipe.steps,
      operationMarkdown: recipe.operationMarkdown,
      tips: recipe.tips,
      warnings: recipe.warnings,
      additionalMarkdown: recipe.additionalMarkdown,
      images: recipe.images,
      externalImages: recipe.externalImages,
      source: {
        repository: 'https://github.com/Gaq152/HowToCook',
        commit,
        path: `dishes/${recipe.sourcePath}`,
      },
    };
    output.hash = hashJson(output);
    writeJson(path.join(outputRoot, 'recipes', recipe.category, `${recipe.id}.json`), output);
    recipeOutputs.push(output);
  }

  const tipOutputs = [];
  for (const tip of tips) {
    const output = {
      schemaVersion: 2,
      id: tip.id,
      title: tip.title,
      category: tip.category,
      categoryName: TIP_CATEGORY_NAMES[tip.category] ?? tip.category,
      content: tip.content,
      sections: tip.sections,
      source: {
        repository: 'https://github.com/Gaq152/HowToCook',
        commit,
        path: `tips/${tip.sourcePath}`,
      },
    };
    output.hash = hashJson(output);
    writeJson(path.join(outputRoot, 'tips', tip.category, `${tip.id}.json`), output);
    tipOutputs.push(output);
  }

  recipeOutputs.sort((left, right) =>
    left.category.localeCompare(right.category) || left.name.localeCompare(right.name, 'zh-CN'));
  tipOutputs.sort((left, right) =>
    left.category.localeCompare(right.category) || left.title.localeCompare(right.title, 'zh-CN'));

  const manifest = {
    schemaVersion: 2,
    dataVersion: args.version,
    generatedAt,
    source: {
      repository: 'https://github.com/Gaq152/HowToCook',
      commit,
      committedAt,
    },
    recipeIdFormat: 'uuid-v4-registry',
    basePath: `versions/2/${args.version}`,
    migrations: {
      recipeIdsV1ToV2: 'migrations/recipe-id-v1-to-v2.json',
    },
    totalRecipes: recipeOutputs.length,
    totalTips: tipOutputs.length,
    totalImages: imageJobs.length,
    categories: categorySummary(recipeOutputs, CATEGORY_NAMES),
    tipsCategories: categorySummary(tipOutputs, TIP_CATEGORY_NAMES),
    recipes: recipeOutputs.map((recipe) => ({
      id: recipe.id,
      legacyIds: recipe.legacyIds,
      name: recipe.name,
      description: recipe.description,
      category: recipe.category,
      categoryName: recipe.categoryName,
      difficulty: recipe.difficulty,
      estimatedCaloriesKcal: recipe.estimatedCaloriesKcal,
      imageCount: recipe.images.length,
      hash: recipe.hash,
    })),
    tips: tipOutputs.map((tip) => ({
      id: tip.id,
      title: tip.title,
      category: tip.category,
      categoryName: tip.categoryName,
      hash: tip.hash,
    })),
  };
  manifest.hash = hashJson(manifest);
  writeJson(path.join(outputRoot, 'manifest.json'), manifest);

  const channel = {
    schemaVersion: 2,
    channel: 'stable',
    dataVersion: args.version,
    manifestPath: `versions/2/${args.version}/manifest.json`,
    sourceCommit: commit,
    publishedAt: new Date().toISOString(),
    compatibility: {
      legacyRootSchemaVersion: 1,
      legacyRootUnchanged: true,
    },
  };
  writeJson(path.join(REPOSITORY_ROOT, 'channels', 'v2-stable.json'), channel);

  console.log(`完成: ${recipeOutputs.length} 个菜谱, ${tipOutputs.length} 个教程, ${imageJobs.length} 张图片`);
  console.log(`V1 -> V2 ID 映射: ${migration.mappings.length} 条`);
  console.log(`无原始图片菜谱: ${recipeOutputs.filter((recipe) => recipe.images.length === 0).length} 个`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
