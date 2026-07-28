import crypto from 'node:crypto';
import fs from 'node:fs';

function keyOf(category, name) {
  return `${category}\u0000${name}`;
}

function uniqueByKey(items, keySelector, label) {
  const map = new Map();
  for (const item of items) {
    const key = keySelector(item);
    if (map.has(key)) throw new Error(`${label} 重复: ${key}`);
    map.set(key, item);
  }
  return map;
}

export function loadRegistry(filePath) {
  if (!fs.existsSync(filePath)) {
    return { schemaVersion: 1, idFormat: 'uuid-v4', entries: [], retiredIds: [] };
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function assignRecipeIds({ recipes, registry, legacyManifest, updateRegistry }) {
  const activeEntries = registry.entries.filter((entry) => entry.status !== 'retired');
  const byPath = new Map();
  const byName = new Map();
  for (const entry of activeEntries) {
    for (const sourcePath of entry.sourcePaths ?? []) byPath.set(sourcePath, entry);
    const key = keyOf(entry.category, entry.canonicalName);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(entry);
  }

  const legacyByName = new Map();
  for (const item of legacyManifest.recipes ?? []) {
    const key = keyOf(item.category, item.name);
    if (!legacyByName.has(key)) legacyByName.set(key, []);
    legacyByName.get(key).push(item);
  }

  const occupiedIds = new Set(registry.retiredIds ?? []);
  for (const entry of registry.entries) {
    if (occupiedIds.has(entry.id)) throw new Error(`注册表 ID 被重复使用: ${entry.id}`);
    occupiedIds.add(entry.id);
  }

  const matchedEntries = new Set();
  const assigned = [];
  for (const recipe of recipes) {
    let entry = byPath.get(recipe.sourcePath);
    if (!entry) {
      const candidates = byName.get(keyOf(recipe.category, recipe.name)) ?? [];
      if (candidates.length === 1) entry = candidates[0];
      if (candidates.length > 1) {
        throw new Error(`注册表中存在多个同分类同名菜谱，无法匹配: ${recipe.category}/${recipe.name}`);
      }
    }

    if (!entry) {
      if (!updateRegistry) {
        throw new Error(`发现未登记菜谱 ${recipe.sourcePath}，请使用 --update-registry 审核并登记`);
      }
      let id;
      do id = crypto.randomUUID(); while (occupiedIds.has(id));
      const legacyMatches = legacyByName.get(keyOf(recipe.category, recipe.name)) ?? [];
      if (legacyMatches.length > 1) {
        throw new Error(`V1 清单中同分类同名条目不唯一: ${recipe.category}/${recipe.name}`);
      }
      entry = {
        id,
        category: recipe.category,
        canonicalName: recipe.name,
        sourcePaths: [recipe.sourcePath],
        legacyIds: legacyMatches.map((item) => item.id),
        status: 'active',
      };
      registry.entries.push(entry);
      occupiedIds.add(id);
      byPath.set(recipe.sourcePath, entry);
      if (!byName.has(keyOf(recipe.category, recipe.name))) {
        byName.set(keyOf(recipe.category, recipe.name), []);
      }
      byName.get(keyOf(recipe.category, recipe.name)).push(entry);
    } else if (!(entry.sourcePaths ?? []).includes(recipe.sourcePath)) {
      if (!updateRegistry) {
        throw new Error(`菜谱路径发生变化但注册表未更新: ${recipe.sourcePath}`);
      }
      entry.sourcePaths = [...(entry.sourcePaths ?? []), recipe.sourcePath];
    }

    if (entry.category !== recipe.category) {
      throw new Error(`菜谱分类变化需要人工迁移: ${recipe.sourcePath} (${entry.category} -> ${recipe.category})`);
    }
    matchedEntries.add(entry.id);
    assigned.push({ ...recipe, id: entry.id, legacyIds: [...(entry.legacyIds ?? [])] });
  }

  const missing = activeEntries.filter((entry) => !matchedEntries.has(entry.id));
  if (missing.length > 0) {
    throw new Error(`注册表中的活动菜谱在源数据中消失，必须显式标记 retired: ${missing.map((entry) => entry.canonicalName).join('、')}`);
  }

  uniqueByKey(assigned, (recipe) => recipe.id, 'UUID');
  uniqueByKey(assigned, (recipe) => recipe.sourcePath, '源路径');

  registry.entries.sort((left, right) =>
    left.category.localeCompare(right.category) ||
    left.canonicalName.localeCompare(right.canonicalName, 'zh-CN'));

  return { recipes: assigned, registry };
}

export function buildLegacyMigration(recipes, dataVersion) {
  const mappings = [];
  for (const recipe of recipes) {
    for (const oldId of recipe.legacyIds ?? []) {
      mappings.push({ oldId, newId: recipe.id, category: recipe.category, name: recipe.name });
    }
  }
  mappings.sort((left, right) => left.oldId.localeCompare(right.oldId));
  return {
    schemaVersion: 1,
    migrationId: `recipe-id-v1-to-v2-${dataVersion}`,
    fromSchemaVersion: 1,
    toSchemaVersion: 2,
    dataVersion,
    mappings,
  };
}
