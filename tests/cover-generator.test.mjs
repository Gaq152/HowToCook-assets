import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCoverPrompt, extractEdibleIngredients, hashPrompt } from '../scripts/covers/lib/prompt.mjs';
import { KrillImagesClient } from '../scripts/covers/lib/krill-images.mjs';
import { ImagesClient } from '../scripts/covers/lib/images-client.mjs';
import { isEmptyImageResponseError, isProviderDailyQuotaError, parseArgs } from '../scripts/covers/generate.mjs';

const recipe = {
  name: '朱雀汤',
  description: '一道以鸡肉、枸杞和清汤炖煮的家常汤品，汤色清亮，咸鲜温润。',
  category: 'soup',
  categoryName: '汤粥',
  ingredients: [
    { name: '鸡肉' },
    { name: '枸杞' },
    { name: '煲汤盅' },
    { name: '清水' },
  ],
  steps: [
    { kind: 'section', description: '操作' },
    { kind: 'step', description: '鸡肉焯水后与枸杞一起炖至汤色清亮。' },
  ],
};

test('封面提示词用菜谱语义约束菜名字面误读', () => {
  const prompt = buildCoverPrompt(recipe);
  assert.match(prompt, /朱雀汤/);
  assert.match(prompt, /一道以鸡肉、枸杞和清汤炖煮/);
  assert.match(prompt, /鸡肉、枸杞、清水/);
  assert.match(prompt, /Never visualize the literal meaning/);
  assert.match(prompt, /No text/);
  assert.doesNotMatch(prompt, /煲汤盅/);
  assert.doesNotMatch(prompt, /鸡肉焯水后/);
  assert.equal(hashPrompt(prompt).length, 64);
});

test('只提取可食用食材并过滤混入的工具', () => {
  assert.deepEqual(extractEdibleIngredients(recipe), ['鸡肉', '枸杞', '清水']);
});

test('文生图客户端兼容 b64_json 响应', async () => {
  const expected = Buffer.from('fake-image');
  let request;
  const client = new KrillImagesClient({
    apiKey: 'test-key',
    fetchImpl: async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({ data: [{ b64_json: expected.toString('base64') }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const actual = await client.generate({ prompt: 'test' });
  assert.deepEqual(actual, expected);
  assert.equal(request.url, 'https://api.krill-ai.net/v1/images/generations');
  assert.equal(request.init.headers.Authorization, 'Bearer test-key');
  assert.equal(JSON.parse(request.init.body).model, 'gpt-image-2');
});

test('Aixoras 配置默认使用实测可用的同步模型、1:1 比例和 URL 响应', () => {
  const args = parseArgs([
    '--data-version', '2026.07.28.1',
    '--cover-version', '2026.07.31.1',
    '--provider', 'aixoras',
  ]);
  assert.equal(args.baseUrl, 'https://api.aixoras.com/v1');
  assert.equal(args.providerName, 'api.aixoras.com');
  assert.equal(args.model, 'gpt-image-2');
  assert.equal(args.requestMode, 'sync');
  assert.equal(args.aspectRatio, '1:1');
  assert.equal(args.responseFormat, 'url');
  assert.equal(args.watermark, false);
});

test('Aixoras 异步文生图会创建任务、轮询并下载 URL 结果', async () => {
  const image = Buffer.from('async-image');
  const requests = [];
  let pollCount = 0;
  const client = new ImagesClient({
    apiKey: 'test-key',
    baseUrl: 'https://api.aixoras.com/v1',
    model: 'gpt-image-2-1k',
    provider: 'aixoras',
    asyncMode: true,
    pollIntervalMs: 0,
    sleepImpl: async () => {},
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith('/images/generations/async')) {
        return new Response(JSON.stringify({ id: 'task_123', status: 'queued' }), { status: 200 });
      }
      if (url.endsWith('/images/tasks/task_123')) {
        pollCount += 1;
        return new Response(JSON.stringify(pollCount === 1
          ? { id: 'task_123', status: 'processing', progress: '50%' }
          : { id: 'task_123', status: 'completed', result: { data: [{ url: 'https://cdn.example/cover.png' }] } }), { status: 200 });
      }
      if (url === 'https://cdn.example/cover.png') return new Response(image, { status: 200 });
      throw new Error(`意外请求: ${url}`);
    },
  });
  let createdTaskId;
  const actual = await client.generate({
    prompt: 'test',
    onTaskCreated: ({ taskId }) => { createdTaskId = taskId; },
  });
  assert.deepEqual(actual, image);
  assert.equal(createdTaskId, 'task_123');
  assert.equal(pollCount, 2);
  const payload = JSON.parse(requests[0].init.body);
  assert.equal(payload.aspect_ratio, '1:1');
  assert.equal(payload.response_format, 'url');
  assert.equal(payload.watermark, false);
  assert.equal('size' in payload, false);
});

test('Aixoras 同步文生图同时发送计费所需的 size', async () => {
  const expected = Buffer.from('sync-image');
  let payload;
  const client = new ImagesClient({
    apiKey: 'test-key',
    baseUrl: 'https://api.aixoras.com/v1',
    model: 'gpt-image-2',
    provider: 'aixoras',
    asyncMode: false,
    fetchImpl: async (_url, init) => {
      payload = JSON.parse(init.body);
      return new Response(JSON.stringify({ data: [{ b64_json: expected.toString('base64') }] }), { status: 200 });
    },
  });
  const actual = await client.generate({ prompt: 'test', size: '1024x1024' });
  assert.deepEqual(actual, expected);
  assert.equal(payload.size, '1024x1024');
  assert.equal(payload.aspect_ratio, '1:1');
});

test('已有 Aixoras taskId 只续查任务，不会重复创建生图请求', async () => {
  const requests = [];
  const expected = Buffer.from('resumed-image');
  const client = new ImagesClient({
    apiKey: 'test-key',
    baseUrl: 'https://api.aixoras.com/v1',
    model: 'gpt-image-2-1k',
    provider: 'aixoras',
    asyncMode: true,
    pollIntervalMs: 0,
    sleepImpl: async () => {},
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({
        id: 'task_resume',
        status: 'completed',
        data: [{ b64_json: expected.toString('base64') }],
      }), { status: 200 });
    },
  });
  const actual = await client.generate({ prompt: 'ignored', resumeTaskId: 'task_resume' });
  assert.deepEqual(actual, expected);
  assert.deepEqual(requests.map((item) => [item.url, item.init.method]), [
    ['https://api.aixoras.com/v1/images/tasks/task_resume', 'GET'],
  ]);
});

test('Aixoras 异步任务明确失败时不会继续轮询', async () => {
  let requests = 0;
  const client = new ImagesClient({
    apiKey: 'test-key',
    baseUrl: 'https://api.aixoras.com/v1',
    model: 'gpt-image-2-1k',
    provider: 'aixoras',
    pollIntervalMs: 0,
    sleepImpl: async () => {},
    fetchImpl: async () => {
      requests += 1;
      return new Response(JSON.stringify({
        task_id: 'task_failed',
        raw_status: 'FAILURE',
        message: 'generation failed',
      }), { status: 200 });
    },
  });
  await assert.rejects(
    client.waitForTask('task_failed'),
    (error) => error.taskId === 'task_failed' && error.recoverable === false,
  );
  assert.equal(requests, 1);
});

test('Aixoras 图片编辑兼容返回异步任务', async () => {
  const expected = Buffer.from('edited-image');
  let editForm;
  const client = new ImagesClient({
    apiKey: 'test-key',
    baseUrl: 'https://api.aixoras.com/v1',
    model: 'gpt-image-2-2k',
    provider: 'aixoras',
    pollIntervalMs: 0,
    sleepImpl: async () => {},
    fetchImpl: async (url, init) => {
      if (url.endsWith('/images/edits')) {
        editForm = init.body;
        return new Response(JSON.stringify({ task_id: 'task_edit', status: 'queued' }), { status: 200 });
      }
      if (url.endsWith('/images/tasks/task_edit')) {
        return new Response(JSON.stringify({
          task_id: 'task_edit',
          status: 'completed',
          data: [{ b64_json: expected.toString('base64') }],
        }), { status: 200 });
      }
      throw new Error(`意外请求: ${url}`);
    },
  });
  const actual = await client.edit({ image: Buffer.from('source'), prompt: '修改背景' });
  assert.deepEqual(actual, expected);
  assert.equal(editForm.get('model'), 'gpt-image-2-2k');
  assert.equal(editForm.get('watermark'), 'false');
  assert.equal(editForm.get('response_format'), 'url');
  assert.equal(editForm.get('size'), '1024x1024');
  assert.equal(editForm.get('image').name, 'reference.png');
});

test('识别服务端每日额度耗尽并停止后续请求', () => {
  assert.equal(isProviderDailyQuotaError(new Error('今日免费生图次数已达上限')), true);
  assert.equal(isProviderDailyQuotaError(new Error('临时服务异常')), false);
});

test('识别空图片响应以触发连续失败熔断', () => {
  assert.equal(isEmptyImageResponseError(new Error('图片接口响应缺少 data[0].b64_json 或 data[0].url')), true);
  assert.equal(isEmptyImageResponseError(new Error('image generation service unavailable')), true);
  assert.equal(isEmptyImageResponseError(new Error('图片接口返回 HTTP 500')), false);
});
