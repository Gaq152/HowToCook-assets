import crypto from 'node:crypto';

export const COVER_PROMPT_VERSION = 'food-photo-name-description-ingredients-v3';

const TOOL_PATTERN = /(锅|刀|砧板|案板|铲|勺|筷|碗|盘|碟|杯|盅|盆|烤箱|微波炉|空气炸锅|电饭煲|电压力锅|高压锅|料理机|破壁机|榨汁机|搅拌机|打蛋器|厨房秤|电子秤|模具|蒸箱|冰箱|保鲜膜|保鲜袋|滤网|漏勺|擀面杖|牙签|锡纸|烘焙纸|容器|煤气灶|燃气灶|电磁炉)/;

function cleanText(value) {
  return String(value ?? '')
    .replace(/\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(value, maxLength) {
  const text = cleanText(value);
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

export function extractEdibleIngredients(recipe, limit = 14) {
  const seen = new Set();
  const result = [];
  for (const item of recipe.ingredients ?? []) {
    const name = cleanText(item.name || item.text).replace(/[，,].*$/, '').trim();
    if (!name || TOOL_PATTERN.test(name) || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
    if (result.length >= limit) break;
  }
  return result;
}

export function buildCoverPrompt(recipe) {
  const ingredients = extractEdibleIngredients(recipe);
  return [
    'Create a square, photorealistic editorial food photograph for a mobile recipe app.',
    `菜谱名称（仅作标签）：${cleanText(recipe.name)}`,
    `菜谱简介（成品语义的唯一依据）：${truncate(recipe.description, 600)}`,
    ingredients.length > 0 ? `可食用食材（用于校正菜品内容）：${ingredients.join('、')}` : null,
    '',
    'Semantic rules:',
    '- Infer a plausible finished cooked dish from the recipe description. If the title and description could be interpreted differently, always follow the description.',
    '- Treat the recipe name only as a label. Never visualize the literal meaning of an idiom, place name, personal name, metaphor, animal nickname, or mythical word in the title.',
    '- Show food only. Do not add a mythical creature, living animal, landscape, person, story scene, or symbolic object suggested merely by the title.',
    '- Use the edible ingredient list only to improve food accuracy. Never depict cooking tools, appliances, containers, or preparation equipment as part of the dish.',
    '',
    'Visual direction:',
    '- One appetizing finished serving in appropriate tableware, photographed from a natural 45-degree angle with realistic proportions.',
    '- Soft directional window light, warm neutral dining background, realistic moisture and texture, restrained garnish, premium but believable food styling.',
    '- The dish is the clear focal point and fills most of the square frame, with clean margin suitable for a mobile card crop.',
    '- No text, Chinese characters, letters, numbers, labels, logos, signatures, watermarks, people, hands, packaging, cooking utensils, appliances, split panels, ingredient diagrams, or preparation steps.',
  ].filter((line) => line !== null).join('\n');
}

export function hashPrompt(prompt) {
  return crypto.createHash('sha256').update(prompt).digest('hex');
}
