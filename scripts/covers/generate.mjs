#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { buildCoverPrompt, COVER_PROMPT_VERSION, hashPrompt } from './lib/prompt.mjs';
import { KrillImagesClient } from './lib/krill-images.mjs';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../..');
const VERSION_PATTERN = /^\d{4}\.\d{2}\.\d{2}\.\d+$/;

function loadLocalEnv() {
  const envPath = path.join(REPOSITORY_ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([^#=\s]+)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

export function parseArgs(argv) {
  const result = {
    dataVersion: null,
    coverVersion: null,
    category: null,
    ids: [],
    limit: null,
    dailyQuota: 100,
    concurrency: 1,
    existingCoverRoot: path.resolve(REPOSITORY_ROOT, '..', 'assets', 'covers'),
    baseUrl: process.env.KRILL_AI_BASE_URL || 'https://api.krill-ai.net/v1',
    model: process.env.KRILL_AI_MODEL || 'gpt-image-2',
    size: '1024x1024',
    quality: 'high',
    outputSize: 512,
    webpQuality: 80,
    execute: false,
    overwrite: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--data-version') result.dataVersion = argv[++index];
    else if (value === '--cover-version') result.coverVersion = argv[++index];
    else if (value === '--category') result.category = argv[++index];
    else if (value === '--id') result.ids.push(argv[++index]);
    else if (value === '--limit') result.limit = Number(argv[++index]);
    else if (value === '--daily-quota') result.dailyQuota = Number(argv[++index]);
    else if (value === '--concurrency') result.concurrency = Number(argv[++index]);
    else if (value === '--existing-cover-root') result.existingCoverRoot = path.resolve(argv[++index]);
    else if (value === '--base-url') result.baseUrl = argv[++index];
    else if (value === '--model') result.model = argv[++index];
    else if (value === '--size') result.size = argv[++index];
    else if (value === '--quality') result.quality = argv[++index];
    else if (value === '--output-size') result.outputSize = Number(argv[++index]);
    else if (value === '--webp-quality') result.webpQuality = Number(argv[++index]);
    else if (value === '--execute') result.execute = true;
    else if (value === '--overwrite') result.overwrite = true;
    else throw new Error(`未知参数: ${value}`);
  }
  if (!VERSION_PATTERN.test(result.dataVersion ?? '')) throw new Error('必须提供 --data-version YYYY.MM.DD.N');
  if (!VERSION_PATTERN.test(result.coverVersion ?? '')) throw new Error('必须提供 --cover-version YYYY.MM.DD.N');
  if (result.limit !== null && (!Number.isInteger(result.limit) || result.limit < 1)) {
    throw new Error('--limit 必须是正整数');
  }
  if (!Number.isInteger(result.dailyQuota) || result.dailyQuota < 1 || result.dailyQuota > 100) {
    throw new Error('--daily-quota 必须是 1-100');
  }
  if (!Number.isInteger(result.concurrency) || result.concurrency < 1 || result.concurrency > 4) {
    throw new Error('--concurrency 必须是 1-4');
  }
  if (!Number.isInteger(result.outputSize) || result.outputSize < 256 || result.outputSize > 2048) {
    throw new Error('--output-size 必须是 256-2048');
  }
  if (!Number.isInteger(result.webpQuality) || result.webpQuality < 1 || result.webpQuality > 100) {
    throw new Error('--webp-quality 必须是 1-100');
  }
  if (!/^\d+x\d+$/.test(result.size)) throw new Error('--size 格式必须是 WIDTHxHEIGHT');
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

function relativeFromRoot(filePath) {
  return path.relative(REPOSITORY_ROOT, filePath).replaceAll('\\', '/');
}

function localDate(value = new Date()) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function readAttempts(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`调用记录损坏: ${filePath}`);
      }
    });
}

function appendAttempt(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
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

function isReusableRecord(record, plan) {
  return record
    && record.recipeHash === plan.recipeHash
    && record.promptHash === plan.promptHash
    && record.model === plan.model
    && record.size === plan.size
    && record.quality === plan.quality
    && record.outputSize === plan.outputSize
    && record.webpQuality === plan.webpQuality
    && record.generationMode === 'generate';
}

function planState(plan, overwrite) {
  const hasImage = fs.existsSync(plan.imagePath);
  const hasRecord = fs.existsSync(plan.recordPath);
  if (overwrite) return 'pending';
  if (!hasImage && !hasRecord) return 'pending';
  if (hasImage && hasRecord && isReusableRecord(readJson(plan.recordPath), plan)) return 'completed';
  return 'stale';
}

export async function main(argv = process.argv.slice(2)) {
  loadLocalEnv();
  const args = parseArgs(argv);
  const dataRoot = path.join(REPOSITORY_ROOT, 'versions', '2', args.dataVersion);
  const dataManifestPath = path.join(dataRoot, 'manifest.json');
  if (!fs.existsSync(dataManifestPath)) throw new Error(`V2 manifest 不存在: ${dataManifestPath}`);
  const dataManifest = readJson(dataManifestPath);
  if (dataManifest.dataVersion !== args.dataVersion) throw new Error('数据版本与 manifest 不一致');

  const idFilter = new Set(args.ids);
  let indexes = dataManifest.recipes.filter((recipe) => {
    if (args.category && recipe.category !== args.category) return false;
    if (idFilter.size > 0 && !idFilter.has(recipe.id)) return false;
    return true;
  }).map((recipe, sourceOrder) => {
    const oldCoverPath = path.join(args.existingCoverRoot, recipe.category, `${recipe.name}.webp`);
    return { ...recipe, sourceOrder, oldCoverPath, hadPreviousCover: fs.existsSync(oldCoverPath) };
  }).sort((left, right) => {
    if (left.hadPreviousCover !== right.hadPreviousCover) return left.hadPreviousCover ? 1 : -1;
    return left.id.localeCompare(right.id);
  });
  if (indexes.length === 0) throw new Error('筛选后没有待处理菜谱');

  const stagingRoot = path.join(REPOSITORY_ROOT, '.staging', 'covers', '2', args.coverVersion);
  const attemptsPath = path.join(stagingRoot, 'attempts.jsonl');
  const plans = indexes.map((index, priorityOrder) => {
    const recipePath = path.join(dataRoot, 'recipes', index.category, `${index.id}.json`);
    const recipe = readJson(recipePath);
    const prompt = buildCoverPrompt(recipe);
    const plan = {
      recipe,
      recipeHash: recipe.hash,
      prompt,
      promptHash: hashPrompt(prompt),
      promptVersion: COVER_PROMPT_VERSION,
      generationMode: 'generate',
      hadPreviousCover: index.hadPreviousCover,
      oldCoverPath: index.oldCoverPath,
      priorityOrder,
      model: args.model,
      size: args.size,
      quality: args.quality,
      outputSize: args.outputSize,
      webpQuality: args.webpQuality,
      imagePath: path.join(stagingRoot, 'images', recipe.category, `${recipe.id}.webp`),
      recordPath: path.join(stagingRoot, 'records', recipe.category, `${recipe.id}.json`),
      errorPath: path.join(stagingRoot, 'errors', recipe.category, `${recipe.id}.json`),
    };
    plan.state = planState(plan, args.overwrite);
    return plan;
  });

  const stale = plans.filter((item) => item.state === 'stale');
  if (stale.length > 0) {
    throw new Error(`发现 ${stale.length} 份结果与当前提示词或设置不一致；确认后使用 --overwrite`);
  }
  const pending = plans.filter((item) => item.state === 'pending');
  const completed = plans.filter((item) => item.state === 'completed');
  const today = localDate();
  const attempts = readAttempts(attemptsPath);
  const usedToday = attempts.filter((item) => item.localDate === today && item.kind === 'attempt').length;
  const remainingToday = Math.max(0, args.dailyQuota - usedToday);
  const requestedBatchSize = args.limit ?? remainingToday;
  const batchSize = Math.min(requestedBatchSize, remainingToday, pending.length);
  const batch = pending.slice(0, batchSize);

  writeJson(path.join(stagingRoot, 'generation-plan.json'), {
    schemaVersion: 1,
    coverVersion: args.coverVersion,
    dataVersion: args.dataVersion,
    createdAt: new Date().toISOString(),
    execute: args.execute,
    total: plans.length,
    completedCount: completed.length,
    pendingCount: pending.length,
    missingPreviousCoverCount: plans.filter((item) => !item.hadPreviousCover).length,
    existingPreviousCoverCount: plans.filter((item) => item.hadPreviousCover).length,
    dailyBudget: {
      localDate: today,
      quota: args.dailyQuota,
      used: usedToday,
      remaining: remainingToday,
      selected: batch.length,
    },
    settings: {
      baseUrl: args.baseUrl,
      model: args.model,
      size: args.size,
      quality: args.quality,
      outputSize: args.outputSize,
      webpQuality: args.webpQuality,
      promptVersion: COVER_PROMPT_VERSION,
      existingCoverRoot: args.existingCoverRoot,
      inputFields: ['name', 'description', 'ingredients (edible only)'],
      generationMode: 'generate',
      automaticRetries: 0,
    },
    recipes: plans.map((item) => ({
      id: item.recipe.id,
      name: item.recipe.name,
      category: item.recipe.category,
      recipeHash: item.recipeHash,
      priorityOrder: item.priorityOrder,
      hadPreviousCover: item.hadPreviousCover,
      previousCoverPath: item.hadPreviousCover ? item.oldCoverPath : null,
      state: item.state,
      selectedToday: batch.includes(item),
      promptHash: item.promptHash,
      prompt: item.prompt,
    })),
  });

  console.log(`封面版本: ${args.coverVersion}`);
  console.log(`数据版本: ${args.dataVersion}`);
  console.log(`总计 ${plans.length}：旧封面缺失 ${plans.filter((x) => !x.hadPreviousCover).length}，已有旧封面 ${plans.filter((x) => x.hadPreviousCover).length}`);
  console.log(`进度: 已完成 ${completed.length}，待生成 ${pending.length}`);
  console.log(`今日额度: 已记录 ${usedToday}/${args.dailyQuota}，本轮最多调用 ${batch.length} 次`);
  console.log(`计划文件: ${relativeFromRoot(path.join(stagingRoot, 'generation-plan.json'))}`);
  if (!fs.existsSync(args.existingCoverRoot)) {
    console.warn(`警告: 旧封面目录不存在，无法判断缺图优先级: ${args.existingCoverRoot}`);
  }
  if (!args.execute) {
    console.log('当前为计划模式，没有调用图片接口。确认后添加 --execute。');
    return { planned: plans.length, selected: batch.length, generated: 0, completed: completed.length, failed: 0 };
  }
  if (pending.length === 0) {
    console.log('所有封面均已生成，无需调用接口。');
    return { planned: plans.length, selected: 0, generated: 0, completed: completed.length, failed: 0 };
  }
  if (remainingToday === 0) throw new Error(`本机记录显示 ${today} 的 ${args.dailyQuota} 次额度已用完，请明天继续`);
  if (batch.length === 0) throw new Error('本轮没有可生成项目');

  const client = new KrillImagesClient({
    apiKey: process.env.KRILL_AI_API_KEY,
    baseUrl: args.baseUrl,
    model: args.model,
    maxAttempts: 1,
    timeoutMs: 180000,
  });
  let generated = 0;
  const failures = [];

  await runPool(batch, args.concurrency, async (plan, index) => {
    let success = false;
    let failure = null;
    const attemptedAt = new Date();
    const attemptId = crypto.randomUUID();
    // 在请求发出前占用一次本地额度，即使进程中断也不会在当天重复超额调用。
    appendAttempt(attemptsPath, {
      kind: 'attempt',
      attemptId,
      localDate: localDate(attemptedAt),
      attemptedAt: attemptedAt.toISOString(),
      recipeId: plan.recipe.id,
      recipeName: plan.recipe.name,
      model: args.model,
    });
    try {
      const rawImage = await client.generate({ prompt: plan.prompt, size: args.size, quality: args.quality });
      const output = await sharp(rawImage)
        .rotate()
        .resize(args.outputSize, args.outputSize, { fit: 'cover', position: 'attention' })
        .webp({ quality: args.webpQuality, effort: 5 })
        .toBuffer();
      fs.mkdirSync(path.dirname(plan.imagePath), { recursive: true });
      fs.writeFileSync(plan.imagePath, output);
      const metadata = await sharp(output).metadata();
      writeJson(plan.recordPath, {
        schemaVersion: 1,
        recipeId: plan.recipe.id,
        recipeName: plan.recipe.name,
        category: plan.recipe.category,
        recipeHash: plan.recipeHash,
        coverVersion: args.coverVersion,
        dataVersion: args.dataVersion,
        promptVersion: plan.promptVersion,
        promptHash: plan.promptHash,
        prompt: plan.prompt,
        generationMode: 'generate',
        referenceImage: null,
        replacedExistingCover: plan.hadPreviousCover,
        provider: 'krill-ai.net',
        model: args.model,
        size: args.size,
        quality: args.quality,
        outputSize: args.outputSize,
        webpQuality: args.webpQuality,
        outputPath: relativeFromRoot(plan.imagePath),
        sha256: sha256(output),
        bytes: output.length,
        width: metadata.width,
        height: metadata.height,
        generatedAt: new Date().toISOString(),
      });
      fs.rmSync(plan.errorPath, { force: true });
      generated += 1;
      success = true;
      console.log(`[${index + 1}/${batch.length}] 完成 ${plan.recipe.name}`);
    } catch (error) {
      failure = error;
      failures.push({ id: plan.recipe.id, name: plan.recipe.name, message: error.message });
      writeJson(plan.errorPath, {
        recipeId: plan.recipe.id,
        recipeName: plan.recipe.name,
        occurredAt: new Date().toISOString(),
        message: error.message,
        status: error.status ?? null,
        body: error.body ?? null,
      });
      console.error(`[${index + 1}/${batch.length}] 失败 ${plan.recipe.name}: ${error.message}`);
    } finally {
      appendAttempt(attemptsPath, {
        kind: 'result',
        attemptId,
        localDate: localDate(attemptedAt),
        completedAt: new Date().toISOString(),
        recipeId: plan.recipe.id,
        recipeName: plan.recipe.name,
        success,
        status: failure?.status ?? null,
        message: failure?.message ?? null,
        model: args.model,
      });
    }
  });

  console.log(`本轮调用 ${batch.length} 次：成功 ${generated}，失败 ${failures.length}`);
  console.log(`今日本机累计记录: ${usedToday + batch.length}/${args.dailyQuota}`);
  if (failures.length > 0) {
    process.exitCode = 1;
    console.error(`失败项已记录，下一次运行会优先重试: ${relativeFromRoot(path.join(stagingRoot, 'errors'))}`);
  }
  return { planned: plans.length, selected: batch.length, generated, completed: completed.length + generated, failed: failures.length };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
