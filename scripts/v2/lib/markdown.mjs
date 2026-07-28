import fs from 'node:fs';
import path from 'node:path';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { toString } from 'mdast-util-to-string';

const parser = unified().use(remarkParse).use(remarkGfm);

function normalizePath(value) {
  return value.replaceAll('\\', '/');
}

function nodeMarkdown(markdown, node) {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (start == null || end == null) return toString(node).trim();
  return markdown.slice(start, end).trim();
}

function headingText(node) {
  return toString(node).trim();
}

function isHeading(node, depth, title) {
  return node.type === 'heading' && node.depth === depth && headingText(node) === title;
}

function section(root, markdown, title) {
  const startIndex = root.children.findIndex((node) => isHeading(node, 2, title));
  if (startIndex < 0) return { nodes: [], markdown: '' };

  let endIndex = root.children.length;
  for (let index = startIndex + 1; index < root.children.length; index += 1) {
    const node = root.children[index];
    if (node.type === 'heading' && node.depth === 2) {
      endIndex = index;
      break;
    }
  }

  const nodes = root.children.slice(startIndex + 1, endIndex);
  if (nodes.length === 0) return { nodes, markdown: '' };
  const start = nodes[0].position?.start?.offset;
  const end = nodes.at(-1)?.position?.end?.offset;
  return {
    nodes,
    markdown: start == null || end == null ? '' : markdown.slice(start, end).trim(),
  };
}

function walk(node, visitor) {
  visitor(node);
  if (!Array.isArray(node.children)) return;
  for (const child of node.children) walk(child, visitor);
}

function paragraphContainsOnlyImages(node) {
  if (node.type !== 'paragraph' || !Array.isArray(node.children)) return false;
  return node.children.length > 0 && node.children.every((child) =>
    child.type === 'image' || (child.type === 'text' && child.value.trim() === ''));
}

function stripOwnListMarker(raw) {
  const lines = raw.replaceAll('\r', '').split('\n');
  if (lines.length === 0) return '';
  const match = lines[0].match(/^(\s*)(?:[-+*]|\d+[.)])\s+(.*)$/);
  if (!match) return raw.trim();
  const indent = match[1].length;
  lines[0] = match[2];
  for (let index = 1; index < lines.length; index += 1) {
    const removable = Math.min(lines[index].match(/^\s*/)?.[0].length ?? 0, indent + 2);
    lines[index] = lines[index].slice(removable);
  }
  return lines.join('\n').trim();
}

function directListItems(nodes, markdown, onItem) {
  let group = null;
  for (const node of nodes) {
    if (node.type === 'heading' && node.depth === 3) {
      group = headingText(node);
      continue;
    }
    if (node.type !== 'list') continue;
    for (const item of node.children ?? []) {
      const raw = stripOwnListMarker(nodeMarkdown(markdown, item));
      const text = toString(item).replace(/\s+/g, ' ').trim();
      if (text) onItem({ text, markdown: raw, group });
    }
  }
}

const toolPattern = /(炒锅|煎锅|汤锅|蒸锅|平底锅|电饭煲|压力锅|高压锅|空气炸锅|烤箱|微波炉|电磁炉|燃气灶|菜刀|剪刀|砧板|案板|打蛋器|搅拌机|料理机|破壁机|擀面杖|漏勺|锅铲|刮刀|汤勺|量勺|筛网|滤网|模具|烤盘|蒸笼|炖盅|电子秤|厨房秤|量杯|温度计|计时器|秒表|牙签|厨房纸|锡纸|保鲜膜|裱花袋|容器|盆|碗|盘|筷子)/;

function looksLikeTool(item) {
  if (item.group && /工具/.test(item.group)) return true;
  return toolPattern.test(item.text);
}

function ingredientName(text) {
  const cleaned = text
    .replace(/\[可选\]|（可选）|\(可选\)/g, '')
    .replace(/[*_`#]/g, '')
    .trim();
  const match = cleaned.match(/^(.+?)(?:\s*[=＝:：,，；;]|\s+\d|\s+[Nn]\b|$)/);
  return (match?.[1] ?? cleaned).trim();
}

function ingredientRecord(text, source, extra = {}) {
  return {
    name: ingredientName(text),
    text: text.trim(),
    optional: /可选/.test(text),
    source,
    ...extra,
  };
}

function parseRequirements(nodes, markdown) {
  const requirements = [];
  directListItems(nodes, markdown, (item) => {
    const kind = item.group && /工具/.test(item.group)
      ? 'tool'
      : item.group && /(原料|食材|材料|配料|香料)/.test(item.group)
        ? 'ingredient'
        : 'unknown';
    requirements.push({ ...item, kind });
  });
  // 上游大部分菜谱把原料和工具混在同一列表。只输出明确分组的工具，
  // 避免用关键词把“清水（蒸锅用）”之类的食材误判为工具。
  const tools = requirements.filter((item) => item.kind === 'tool').map((item) => item.text);
  return { requirements, tools };
}

function parseCalculation(nodes, markdown, requirements, tools) {
  const items = [];
  const notes = [];

  for (const node of nodes) {
    if (node.type === 'list') {
      for (const item of node.children ?? []) {
        const text = toString(item).replace(/\s+/g, ' ').trim();
        if (text) items.push(ingredientRecord(text, 'calculation-list'));
      }
      continue;
    }

    if (node.type === 'table') {
      const rows = node.children ?? [];
      const headers = (rows[0]?.children ?? []).map((cell) => toString(cell).trim());
      for (const row of rows.slice(1)) {
        const cells = (row.children ?? []).map((cell) => toString(cell).trim());
        if (!cells[0] || /^:?-+:?$/.test(cells[0])) continue;
        const details = cells.slice(1)
          .map((value, index) => value ? `${headers[index + 1] || `列${index + 2}`}=${value}` : '')
          .filter(Boolean)
          .join('；');
        const text = details ? `${cells[0]}：${details}` : cells[0];
        items.push(ingredientRecord(text, 'calculation-table', {
          table: Object.fromEntries(headers.map((header, index) => [header || `列${index + 1}`, cells[index] ?? ''])),
        }));
      }
      continue;
    }

    if (node.type === 'paragraph' || node.type === 'blockquote' || node.type === 'code') {
      const raw = nodeMarkdown(markdown, node);
      if (raw) notes.push(raw);
    }
  }

  if (items.length === 0) {
    for (const item of requirements) {
      if (!looksLikeTool(item)) {
        items.push(ingredientRecord(item.text, 'requirements-fallback'));
      }
    }
  }

  return { ingredients: items, calculationNotes: notes };
}

function parseOperation(nodes, markdown) {
  const steps = [];
  for (const node of nodes) {
    if (node.type === 'heading' && node.depth >= 3) {
      steps.push({
        kind: 'section',
        title: headingText(node),
        description: `${'#'.repeat(node.depth)} ${headingText(node)}`,
      });
      continue;
    }
    if (node.type === 'list') {
      for (const item of node.children ?? []) {
        const description = stripOwnListMarker(nodeMarkdown(markdown, item));
        if (description) steps.push({ kind: 'step', description });
      }
      continue;
    }
    if (paragraphContainsOnlyImages(node)) continue;
    if (['paragraph', 'blockquote', 'code'].includes(node.type)) {
      const description = nodeMarkdown(markdown, node);
      if (description) steps.push({ kind: 'note', description });
    }
  }
  return steps;
}

function extractPreamble(root, markdown) {
  const h1Index = root.children.findIndex((node) => node.type === 'heading' && node.depth === 1);
  const name = h1Index >= 0 ? headingText(root.children[h1Index]).replace(/的做法$/, '').trim() : '';
  let difficulty = 0;
  let estimatedCaloriesKcal = null;
  const descriptionParts = [];

  for (const node of root.children.slice(h1Index + 1)) {
    if (node.type === 'heading' && node.depth === 2) break;
    if (paragraphContainsOnlyImages(node)) continue;
    if (node.type !== 'paragraph') continue;
    const raw = nodeMarkdown(markdown, node);
    const descriptionLines = [];
    for (const line of raw.split(/\r?\n/)) {
      const text = line.trim();
      if (/^预估烹饪难度[：:]/.test(text)) {
        difficulty = (text.match(/★/g) ?? []).length;
        continue;
      }
      const calorieMatch = text.match(/^预估卡路里[：:]\s*(\d+)\s*大卡/);
      if (calorieMatch) {
        estimatedCaloriesKcal = Number.parseInt(calorieMatch[1], 10);
        continue;
      }
      if (text) descriptionLines.push(line);
    }
    if (descriptionLines.length > 0) descriptionParts.push(descriptionLines.join('\n').trim());
  }

  return {
    name,
    description: descriptionParts.join('\n\n').trim(),
    difficulty,
    estimatedCaloriesKcal,
  };
}

function extractImageUrls(root) {
  const urls = [];
  walk(root, (node) => {
    if (node.type === 'image' && node.url && !urls.includes(node.url)) urls.push(node.url);
  });
  return urls;
}

function warningLines(markdown) {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:[-*]\s*)?\*\*(?:警告|注意)\*\*/.test(line))
    .map((line) => line.replace(/^[-*]\s*/, '').replaceAll('**', '').trim());
}

export function parseRecipeFile(filePath, dishesRoot) {
  const markdown = fs.readFileSync(filePath, 'utf8');
  const root = parser.parse(markdown);
  const sourcePath = normalizePath(path.relative(dishesRoot, filePath));
  const category = sourcePath.split('/')[0];
  const preamble = extractPreamble(root, markdown);

  const requirementsSection = section(root, markdown, '必备原料和工具');
  const calculationSection = section(root, markdown, '计算');
  const operationSection = section(root, markdown, '操作');
  const additionalSection = section(root, markdown, '附加内容');
  const { requirements, tools } = parseRequirements(requirementsSection.nodes, markdown);
  const { ingredients, calculationNotes } = parseCalculation(
    calculationSection.nodes,
    markdown,
    requirements,
    tools,
  );

  return {
    ...preamble,
    category,
    sourcePath,
    sourceFile: filePath,
    requirements,
    tools,
    ingredients,
    calculationNotes,
    steps: parseOperation(operationSection.nodes, markdown),
    warnings: warningLines(additionalSection.markdown),
    tips: additionalSection.markdown,
    requirementsMarkdown: requirementsSection.markdown,
    calculationMarkdown: calculationSection.markdown,
    operationMarkdown: operationSection.markdown,
    additionalMarkdown: additionalSection.markdown,
    imageUrls: extractImageUrls(root),
  };
}

export function parseTipFile(filePath, tipsRoot) {
  const markdown = fs.readFileSync(filePath, 'utf8');
  const root = parser.parse(markdown);
  const sourcePath = normalizePath(path.relative(tipsRoot, filePath));
  const parts = sourcePath.split('/');
  const category = parts.length > 1 ? parts[0] : 'general';
  const heading = root.children.find((node) => node.type === 'heading' && node.depth === 1);
  const title = heading ? headingText(heading) : path.basename(filePath, '.md');
  const contentStart = heading?.position?.end?.offset ?? 0;
  const content = markdown.slice(contentStart).trim();
  const sections = [];

  for (let index = 0; index < root.children.length; index += 1) {
    const node = root.children[index];
    if (node.type !== 'heading' || node.depth < 2) continue;
    let end = markdown.length;
    for (let next = index + 1; next < root.children.length; next += 1) {
      const candidate = root.children[next];
      if (candidate.type === 'heading' && candidate.depth <= node.depth) {
        end = candidate.position?.start?.offset ?? end;
        break;
      }
    }
    const start = node.position?.end?.offset ?? 0;
    sections.push({ title: headingText(node), content: markdown.slice(start, end).trim() });
  }

  return { title, category, sourcePath, sourceFile: filePath, content, sections };
}

export function resolveLocalImages(recipe) {
  const local = [];
  const external = [];
  for (const rawUrl of recipe.imageUrls) {
    if (/^[a-z]+:\/\//i.test(rawUrl)) {
      external.push(rawUrl);
      continue;
    }
    let decoded = rawUrl;
    try {
      decoded = decodeURIComponent(rawUrl);
    } catch {
      // Keep the original URL and let the existence validator report it.
    }
    const clean = decoded.split(/[?#]/, 1)[0];
    const absolutePath = path.resolve(path.dirname(recipe.sourceFile), clean);
    if (!local.some((item) => item.absolutePath === absolutePath)) {
      local.push({ rawUrl, absolutePath });
    }
  }
  return { local, external };
}

export function replaceTipLinks(markdown, sourceFile, tipsPathToId) {
  if (!markdown) return markdown;
  return markdown.replace(/\[([^\]]+)]\(([^)\n]+\.md)\)/g, (whole, label, target) => {
    if (/^[a-z]+:\/\//i.test(target)) return whole;
    const absolute = normalizePath(path.resolve(path.dirname(sourceFile), target));
    const tip = tipsPathToId.get(absolute);
    return tip ? `[${label}](tips://${tip.category}/${tip.id})` : whole;
  });
}

export function normalizeSourcePath(value) {
  return normalizePath(value);
}
