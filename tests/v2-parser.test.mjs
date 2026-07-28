import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseRecipeFile, resolveLocalImages } from '../scripts/v2/lib/markdown.mjs';

function fixture(markdown, files = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'howtocook-v2-'));
  const category = path.join(root, 'dessert');
  fs.mkdirSync(category, { recursive: true });
  const recipePath = path.join(category, '测试菜.md');
  fs.writeFileSync(recipePath, markdown, 'utf8');
  for (const file of files) fs.writeFileSync(path.join(category, file), 'fixture');
  return { root, recipePath };
}

test('保留三个原始板块并把表格计算转换为食材', () => {
  const { root, recipePath } = fixture(`# 测试菜的做法

这是一段足够清晰的菜谱简介。

预估烹饪难度：★★

预估卡路里：123 大卡

## 必备原料和工具

- 鸡蛋
- 白糖
- 打蛋器

## 计算

| 原料 | 1 份 | 3 份 |
| --- | --- | --- |
| 鸡蛋 | 1 个 | 3 个 |
| 水 | 20ml | 60ml |

## 操作

1. 加水
2. 搅拌

## 附加内容

- 注意温度
`);
  const recipe = parseRecipeFile(recipePath, root);
  assert.equal(recipe.estimatedCaloriesKcal, 123);
  assert.equal(recipe.requirements.length, 3);
  assert.deepEqual(recipe.ingredients.map((item) => item.name), ['鸡蛋', '水']);
  assert.match(recipe.calculationMarkdown, /\| 水 \|/);
  assert.match(recipe.operationMarkdown, /^1\. 加水/m);
});

test('结构化步骤移除上游有序列表编号', () => {
  const { root, recipePath } = fixture(`# 测试菜的做法

简介。

预估烹饪难度：★

预估卡路里：10 大卡

## 必备原料和工具

- 水

## 计算

- 水 100ml

## 操作

### 准备

1. 倒入水
2. 煮沸

## 附加内容
`);
  const recipe = parseRecipeFile(recipePath, root);
  assert.equal(recipe.steps[0].kind, 'section');
  assert.equal(recipe.steps[1].description, '倒入水');
  assert.equal(recipe.steps[2].description, '煮沸');
});

test('正确解析文件名中含括号的图片', () => {
  const { root, recipePath } = fixture(`# 测试菜的做法

![成品(微辣)](./成品(微辣).jpg)

简介。

预估烹饪难度：★

预估卡路里：10 大卡

## 必备原料和工具

- 水

## 计算

- 水 100ml

## 操作

1. 完成

## 附加内容
`, ['成品(微辣).jpg']);
  const recipe = parseRecipeFile(recipePath, root);
  const images = resolveLocalImages(recipe);
  assert.equal(images.local.length, 1);
  assert.equal(path.basename(images.local[0].absolutePath), '成品(微辣).jpg');
});
