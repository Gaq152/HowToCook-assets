#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { buildCoverPrompt, COVER_PROMPT_VERSION, hashPrompt } from './lib/prompt.mjs';
import { ImagesClient } from './lib/images-client.mjs';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../..');
const VERSION_PATTERN = /^\d{4}\.\d{2}\.\d{2}\.\d+$/;
const PROVIDERS = {
  krill: {
    baseUrl: 'https://api.krill-ai.net/v1',
    model: 'gpt-image-2',
    requestMode: 'sync',
    apiKeyNames: ['KRILL_AI_API_KEY'],
    baseUrlNames: ['KRILL_AI_BASE_URL'],
    modelNames: ['KRILL_AI_MODEL'],
  },
  aixoras: {
    baseUrl: 'https://api.aixoras.com/v1',
    model: 'gpt-image-2',
    requestMode: 'sync',
    apiKeyNames: ['AIXORAS_API_KEY', 'NEWAPI_TOKEN'],
    baseUrlNames: ['AIXORAS_API_BASE_URL'],
    modelNames: ['AIXORAS_API_MODEL'],
  },
  custom: {
    baseUrl: null,
    model: null,
    requestMode: 'sync',
    apiKeyNames: [],
    baseUrlNames: [],
    modelNames: [],
  },
};

function loadLocalEnv() {
  const envPath = path.join(REPOSITORY_ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([^#=\s]+)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

function aspectRatioFromSize(size) {
  const [width, height] = size.split('x').map(Number);
  let left = width;
  let right = height;
  while (right !== 0) [left, right] = [right, left % right];
  return `${width / left}:${height / left}`;
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
    provider: null,
    baseUrl: null,
    model: null,
    requestMode: null,
    size: '1024x1024',
    aspectRatio: null,
    quality: 'high',
    responseFormat: null,
    watermark: null,
    pollIntervalMs: 3000,
    taskTimeoutMs: 900000,
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
    else if (value === '--provider') result.provider = argv[++index];
    else if (value === '--base-url') result.baseUrl = argv[++index];
    else if (value === '--model') result.model = argv[++index];
    else if (value === '--async') result.requestMode = 'async';
    else if (value === '--sync') result.requestMode = 'sync';
    else if (value === '--size') result.size = argv[++index];
    else if (value === '--aspect-ratio') result.aspectRatio = argv[++index];
    else if (value === '--quality') result.quality = argv[++index];
    else if (value === '--response-format') result.responseFormat = argv[++index];
    else if (value === '--watermark') result.watermark = true;
    else if (value === '--no-watermark') result.watermark = false;
    else if (value === '--poll-interval-ms') result.pollIntervalMs = Number(argv[++index]);
    else if (value === '--task-timeout-ms') result.taskTimeoutMs = Number(argv[++index]);
    else if (value === '--output-size') result.outputSize = Number(argv[++index]);
    else if (value === '--webp-quality') result.webpQuality = Number(argv[++index]);
    else if (value === '--execute') result.execute = true;
    else if (value === '--overwrite') result.overwrite = true;
    else throw new Error(`未知参数: ${value}`);
  }

  const configuredBaseUrl = result.baseUrl || process.env.IMAGE_API_BASE_URL || null;
  if (!result.provider) {
    result.provider = process.env.IMAGE_API_PROVIDER
      || (configuredBaseUrl?.includes('aixoras.com') ? 'aixoras' : null)
      || (process.env.AIXORAS_API_KEY && !process.env.KRILL_AI_API_KEY ? 'aixoras' : 'krill');
  }
  result.provider = result.provider.toLowerCase();
  const profile = PROVIDERS[result.provider];
  if (!profile) throw new Error(`--provider 仅支持 ${Object.keys(PROVIDERS).join('、')}`);
  const firstEnvironmentValue = (names) => names.map((name) => process.env[name]).find(Boolean);
  result.baseUrl = result.baseUrl
    || process.env.IMAGE_API_BASE_URL
    || firstEnvironmentValue(profile.baseUrlNames)
    || profile.baseUrl;
  result.model = result.model
    || process.env.IMAGE_API_MODEL
    || firstEnvironmentValue(profile.modelNames)
    || profile.model;
  result.apiKey = process.env.IMAGE_API_KEY || firstEnvironmentValue(profile.apiKeyNames) || null;
  result.requestMode = result.requestMode
    || process.env.IMAGE_API_MODE
    || profile.requestMode;
  result.aspectRatio ||= process.env.IMAGE_API_ASPECT_RATIO || aspectRatioFromSize(result.size);
  result.responseFormat ||= process.env.IMAGE_API_RESPONSE_FORMAT || (result.provider === 'aixoras' ? 'url' : null);
  if (result.watermark === null && process.env.IMAGE_API_WATERMARK) {
    result.watermark = process.env.IMAGE_API_WATERMARK.toLowerCase() === 'true';
  }
  if (result.watermark === null && result.provider === 'aixoras') result.watermark = false;
  if (!result.baseUrl) throw new Error('必须通过 --base-url 或 IMAGE_API_BASE_URL 提供图片接口地址');
  if (!result.model) throw new Error('必须通过 --model 或 IMAGE_API_MODEL 提供图片模型名称');
  try {
    result.providerName = new URL(result.baseUrl).hostname;
  } catch {
    throw new Error('--base-url 必须是有效的 HTTP(S) URL');
  }
  if (!/^https?:\/\//.test(result.baseUrl)) throw new Error('--base-url 必须是 HTTP(S) URL');
  if (!VERSION_PATTERN.test(result.dataVersion ?? '')) throw new Error('必须提供 --data-version YYYY.MM.DD.N');
  if (!VERSION_PATTERN.test(result.coverVersion ?? '')) throw new Error('必须提供 --cover-version YYYY.MM.DD.N');
  if (result.limit !== null && (!Number.isInteger(result.limit) || result.limit < 1)) {
    throw new Error('--limit 必须是正整数');
  }
  if (!Number.isInteger(result.dailyQuota) || result.dailyQuota < 1) {
    throw new Error('--daily-quota 必须是正整数');
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
  if (!/^\d+:\d+$/.test(result.aspectRatio)) throw new Error('--aspect-ratio 格式必须是 WIDTH:HEIGHT');
  if (!['sync', 'async'].includes(result.requestMode)) throw new Error('IMAGE_API_MODE 只能是 sync 或 async');
  if (result.responseFormat && !['url', 'b64_json'].includes(result.responseFormat)) {
    throw new Error('--response-format 只能是 url 或 b64_json');
  }
  if (!Number.isInteger(result.pollIntervalMs) || result.pollIntervalMs < 250) {
    throw new Error('--poll-interval-ms 必须是不小于 250 的整数');
  }
  if (!Number.isInteger(result.taskTimeoutMs) || result.taskTimeoutMs < 1000) {
    throw new Error('--task-timeout-ms 必须是不小于 1000 的整数');
  }
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

export function isProviderDailyQuotaError(error) {
  const details = `${error?.message ?? ''} ${JSON.stringify(error?.body ?? {})}`;
  return /今日.*(?:免费)?(?:生图)?(?:次数|额度).*(?:上限|用完|耗尽)|daily\s+(?:free\s+)?(?:image\s+)?(?:limit|quota)/i.test(details);
}

export function isEmptyImageResponseError(error) {
  return /响应缺少\s+data\[0\]\.b64_json\s+或\s+data\[0\]\.url|image generation service unavailable|图片生成服务不可用/i.test(error?.message ?? '');
}

function reconcileDanglingAttempts(filePath, attempts) {
  const completed = new Set(attempts.filter((item) => item.kind === 'result').map((item) => item.attemptId));
  const tasksByAttempt = new Map(
    attempts.filter((item) => item.kind === 'task').map((item) => [item.attemptId, item]),
  );
  const dangling = attempts.filter((item) => item.kind === 'attempt' && !completed.has(item.attemptId));
  const resumable = [];
  let abandoned = 0;
  for (const attempt of dangling) {
    const task = tasksByAttempt.get(attempt.attemptId);
    if (task?.taskId) {
      resumable.push({ ...attempt, ...task });
      continue;
    }
    appendAttempt(filePath, {
      kind: 'result',
      attemptId: attempt.attemptId,
      localDate: attempt.localDate,
      completedAt: new Date().toISOString(),
      recipeId: attempt.recipeId,
      recipeName: attempt.recipeName,
      success: false,
      status: null,
      message: '上次生成进程在请求完成前中断，保留为待处理',
      model: attempt.model,
      provider: attempt.provider,
    });
    abandoned += 1;
  }
  return { abandoned, resumable };
}

function isReusableRecord(record, plan) {
  return record
    && record.recipeHash === plan.recipeHash
    && record.promptHash === plan.promptHash
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
      provider: args.providerName,
      providerId: args.provider,
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
  let attempts = readAttempts(attemptsPath);
  const reconciliation = reconcileDanglingAttempts(attemptsPath, attempts);
  if (reconciliation.abandoned > 0) {
    console.warn(`已补记 ${reconciliation.abandoned} 次未取得任务 ID 的中断请求，相关菜谱继续保留为待处理`);
    attempts = readAttempts(attemptsPath);
  }
  const resumableByRecipe = new Map();
  const heldByRecipe = new Map();
  for (const attempt of reconciliation.resumable) {
    const attemptProvider = attempt.provider ?? 'krill-ai.net';
    const attemptMode = attempt.requestMode ?? 'sync';
    if (attemptProvider === args.providerName
      && attempt.model === args.model
      && attemptMode === args.requestMode) {
      resumableByRecipe.set(attempt.recipeId, attempt);
    } else {
      heldByRecipe.set(attempt.recipeId, attempt);
    }
  }
  for (const plan of pending) {
    plan.resumeAttempt = resumableByRecipe.get(plan.recipe.id) ?? null;
    plan.heldAttempt = plan.resumeAttempt ? null : (heldByRecipe.get(plan.recipe.id) ?? null);
  }
  const usedToday = attempts.filter((item) => (
    item.localDate === today
    && item.kind === 'attempt'
    && (item.provider ?? 'krill-ai.net') === args.providerName
  )).length;
  const remainingToday = Math.max(0, args.dailyQuota - usedToday);
  const resumablePending = pending.filter((item) => item.resumeAttempt);
  const heldPending = pending.filter((item) => item.heldAttempt);
  const newPending = pending.filter((item) => !item.resumeAttempt && !item.heldAttempt);
  const requestedBatchSize = args.limit ?? (resumablePending.length + remainingToday);
  const resumeBatch = resumablePending.slice(0, requestedBatchSize);
  const newBatchSize = Math.min(
    Math.max(0, requestedBatchSize - resumeBatch.length),
    remainingToday,
    newPending.length,
  );
  const batch = [...resumeBatch, ...newPending.slice(0, newBatchSize)];

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
      resumedTasks: resumeBatch.length,
      heldTasks: heldPending.length,
      newRequests: newBatchSize,
    },
    settings: {
      provider: args.provider,
      providerName: args.providerName,
      baseUrl: args.baseUrl,
      model: args.model,
      requestMode: args.requestMode,
      size: args.size,
      aspectRatio: args.aspectRatio,
      quality: args.quality,
      responseFormat: args.responseFormat,
      watermark: args.watermark,
      pollIntervalMs: args.pollIntervalMs,
      taskTimeoutMs: args.taskTimeoutMs,
      outputSize: args.outputSize,
      webpQuality: args.webpQuality,
      promptVersion: COVER_PROMPT_VERSION,
      existingCoverRoot: args.existingCoverRoot,
      inputFields: ['name', 'description', 'ingredients (edible only)'],
      generationMode: 'generate',
      automaticSubmissionRetries: 0,
      transientEmptyResponseCircuitBreaker: 4,
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
      resumeTaskId: item.resumeAttempt?.taskId ?? null,
      heldTaskId: item.heldAttempt?.taskId ?? null,
      heldTaskModel: item.heldAttempt?.model ?? null,
      heldTaskMode: item.heldAttempt?.requestMode ?? null,
      selectedToday: batch.includes(item),
      promptHash: item.promptHash,
      prompt: item.prompt,
    })),
  });

  console.log(`封面版本: ${args.coverVersion}`);
  console.log(`数据版本: ${args.dataVersion}`);
  console.log(`图片接口: ${args.providerName} (${args.requestMode})，模型 ${args.model}`);
  console.log(`总计 ${plans.length}：旧封面缺失 ${plans.filter((x) => !x.hadPreviousCover).length}，已有旧封面 ${plans.filter((x) => x.hadPreviousCover).length}`);
  console.log(`进度: 已完成 ${completed.length}，待生成 ${pending.length}`);
  console.log(`今日额度: 已记录 ${usedToday}/${args.dailyQuota}，本轮新请求 ${newBatchSize} 次，续查异步任务 ${resumeBatch.length} 个，挂起其他配置任务 ${heldPending.length} 个`);
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
  if (remainingToday === 0 && resumeBatch.length === 0) {
    throw new Error(`本机记录显示 ${today} 在 ${args.providerName} 的 ${args.dailyQuota} 次额度已用完，请明天继续`);
  }
  if (batch.length === 0 && heldPending.length > 0) {
    throw new Error(`本轮没有可生成项目；${heldPending.length} 个菜谱仍有其他模型或模式的异步任务，请使用原参数续查`);
  }
  if (batch.length === 0) throw new Error('本轮没有可生成项目');

  const client = new ImagesClient({
    apiKey: args.apiKey,
    baseUrl: args.baseUrl,
    model: args.model,
    provider: args.provider,
    asyncMode: args.requestMode === 'async',
    aspectRatio: args.aspectRatio,
    responseFormat: args.responseFormat,
    watermark: args.watermark,
    maxAttempts: 1,
    timeoutMs: 180000,
    pollIntervalMs: args.pollIntervalMs,
    taskTimeoutMs: args.taskTimeoutMs,
  });
  let generated = 0;
  let attempted = 0;
  let resumed = 0;
  let stoppedByProviderQuota = false;
  let stoppedByTransientFailures = false;
  let consecutiveEmptyResponses = 0;
  const failures = [];

  await runPool(batch, args.concurrency, async (plan, index) => {
    if (stoppedByProviderQuota || stoppedByTransientFailures) return;
    let success = false;
    let failure = null;
    const attemptedAt = plan.resumeAttempt ? new Date(plan.resumeAttempt.attemptedAt) : new Date();
    const attemptId = plan.resumeAttempt?.attemptId ?? crypto.randomUUID();
    let taskId = plan.resumeAttempt?.taskId ?? null;
    if (plan.resumeAttempt) {
      resumed += 1;
      console.log(`[${index + 1}/${batch.length}] 续查 ${plan.recipe.name}：${taskId}`);
    } else {
      attempted += 1;
      // 在请求发出前占用一次本地额度，即使进程中断也不会在当天重复超额调用。
      appendAttempt(attemptsPath, {
        kind: 'attempt',
        attemptId,
        localDate: localDate(attemptedAt),
        attemptedAt: attemptedAt.toISOString(),
        recipeId: plan.recipe.id,
        recipeName: plan.recipe.name,
        model: args.model,
        provider: args.providerName,
        requestMode: args.requestMode,
      });
    }
    try {
      const rawImage = await client.generate({
        prompt: plan.prompt,
        size: args.size,
        quality: args.quality,
        resumeTaskId: taskId,
        onTaskCreated: ({ taskId: createdTaskId, body }) => {
          taskId = createdTaskId;
          appendAttempt(attemptsPath, {
            kind: 'task',
            attemptId,
            localDate: localDate(attemptedAt),
            createdAt: new Date().toISOString(),
            recipeId: plan.recipe.id,
            recipeName: plan.recipe.name,
            taskId,
            taskStatus: body?.status ?? body?.raw_status ?? null,
            model: args.model,
            provider: args.providerName,
            requestMode: args.requestMode,
          });
          console.log(`[${index + 1}/${batch.length}] 已创建 ${plan.recipe.name} 异步任务：${taskId}`);
        },
      });
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
        provider: args.providerName,
        providerId: args.provider,
        requestMode: args.requestMode,
        taskId,
        model: args.model,
        size: args.size,
        aspectRatio: args.aspectRatio,
        quality: args.quality,
        responseFormat: args.responseFormat,
        watermark: args.watermark,
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
      consecutiveEmptyResponses = 0;
      success = true;
      console.log(`[${index + 1}/${batch.length}] 完成 ${plan.recipe.name}`);
    } catch (error) {
      failure = error;
      if (isProviderDailyQuotaError(error)) stoppedByProviderQuota = true;
      if (isEmptyImageResponseError(error)) {
        consecutiveEmptyResponses += 1;
        if (consecutiveEmptyResponses >= 4) stoppedByTransientFailures = true;
      } else {
        consecutiveEmptyResponses = 0;
      }
      failures.push({ id: plan.recipe.id, name: plan.recipe.name, message: error.message });
      writeJson(plan.errorPath, {
        recipeId: plan.recipe.id,
        recipeName: plan.recipe.name,
        occurredAt: new Date().toISOString(),
        message: error.message,
        status: error.status ?? null,
        taskId: error.taskId ?? taskId,
        recoverable: error.recoverable ?? false,
        body: error.body ?? null,
      });
      console.error(`[${index + 1}/${batch.length}] 失败 ${plan.recipe.name}: ${error.message}`);
    } finally {
      // 仍在服务端执行的异步任务不结案，下次运行会用原 taskId 继续查询。
      if (!(failure?.recoverable && taskId)) {
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
          taskId,
          model: args.model,
          provider: args.providerName,
          requestMode: args.requestMode,
        });
      }
    }
  });

  console.log(`本轮新调用 ${attempted} 次、续查 ${resumed} 个任务：成功 ${generated}，失败 ${failures.length}`);
  console.log(`${args.providerName} 今日本机累计记录: ${usedToday + attempted}/${args.dailyQuota}`);
  if (stoppedByProviderQuota && attempted < batch.length) {
    console.warn(`服务端日额度已用完，已停止后续 ${batch.length - attempted} 项，未发出请求也未占用本地额度`);
  }
  if (stoppedByTransientFailures && attempted < batch.length) {
    console.warn(`连续 ${consecutiveEmptyResponses} 次收到空图片响应，已熔断后续 ${batch.length - attempted} 项；稍后可再次运行继续`);
  }
  if (failures.length > 0) {
    process.exitCode = 1;
    console.error(`失败项已记录，下一次运行会优先重试: ${relativeFromRoot(path.join(stagingRoot, 'errors'))}`);
  }
  return {
    planned: plans.length,
    selected: batch.length,
    attempted,
    resumed,
    generated,
    completed: completed.length + generated,
    failed: failures.length,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
