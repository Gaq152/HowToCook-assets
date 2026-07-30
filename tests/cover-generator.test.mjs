import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCoverPrompt, extractEdibleIngredients, hashPrompt } from '../scripts/covers/lib/prompt.mjs';
import { KrillImagesClient } from '../scripts/covers/lib/krill-images.mjs';
import { isEmptyImageResponseError, isProviderDailyQuotaError } from '../scripts/covers/generate.mjs';

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

test('识别服务端每日额度耗尽并停止后续请求', () => {
  assert.equal(isProviderDailyQuotaError(new Error('今日免费生图次数已达上限')), true);
  assert.equal(isProviderDailyQuotaError(new Error('临时服务异常')), false);
});

test('识别空图片响应以触发连续失败熔断', () => {
  assert.equal(isEmptyImageResponseError(new Error('图片接口响应缺少 data[0].b64_json 或 data[0].url')), true);
  assert.equal(isEmptyImageResponseError(new Error('图片接口返回 HTTP 500')), false);
});
