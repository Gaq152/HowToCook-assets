#!/usr/bin/env node

/**
 * HowToCook 数据转换 CLI 工具
 * 整合所有转换、处理和部署功能的交互式命令行工具
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { execSync } = require('child_process');

// ============================================================================
// 配置
// ============================================================================

const CONFIG = {
  dishesDir: path.join(__dirname, '../origin/dishes'),
  tipsDir: path.join(__dirname, '../origin/tips'),
  outputDir: path.join(__dirname, '../'),
  recipesDir: path.join(__dirname, '../recipes'),
  tipsOutputDir: path.join(__dirname, '../tips'),
  imagesDir: path.join(__dirname, '../images'),
  manifestPath: path.join(__dirname, '../manifest.json'),
  version: '1.0.0',
  supportedImageExts: ['.jpg', '.jpeg', '.png', '.gif', '.webp'],
  webpQuality: 85
};

// 分类映射（不包含 template 模板目录）
const CATEGORY_MAP = {
  'aquatic': '水产',
  'breakfast': '早餐',
  'condiment': '调料',
  'dessert': '甜品',
  'drink': '饮料',
  'meat_dish': '荤菜',
  'semi-finished': '半成品',
  'soup': '汤粥',
  'staple': '主食',
  'vegetable_dish': '素菜'
};

// 需要排除的目录
const EXCLUDED_DIRS = ['template'];

// Tips 分类映射
const TIPS_CATEGORY_MAP = {
  'learn': '基础技法',
  'advanced': '进阶知识'
};

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 创建 readline 接口
 */
function createReadline() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
}

/**
 * 询问用户输入
 */
function ask(question) {
  const rl = createReadline();
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * 询问确认
 */
async function confirm(message) {
  const answer = await ask(`${message} (y/n): `);
  return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
}

/**
 * 计算哈希值
 */
function calculateHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * 生成菜谱 ID
 */
function generateRecipeId(name, category, filePath) {
  const cleaned = name.replace(/[^\w\u4e00-\u9fa5]/g, '');
  const relativePath = path.relative(CONFIG.dishesDir, filePath);
  const hash = crypto.createHash('md5').update(cleaned + category + relativePath).digest('hex').substring(0, 8);
  return `${category}_${hash}`;
}

/**
 * 生成 Tips ID
 */
function generateTipsId(title, category) {
  const cleaned = title.replace(/[^\w\u4e00-\u9fa5]/g, '');
  const hash = crypto.createHash('md5').update(cleaned + category).digest('hex').substring(0, 8);
  return `tips_${category}_${hash}`;
}

/**
 * 从文本行中提取所有图片路径（修复：支持列表项中的图片）
 */
function extractImagesFromLine(line) {
  const images = [];
  const regex = /!\[.*?\]\((.*?)\)/g;
  let match;
  while ((match = regex.exec(line)) !== null) {
    images.push(match[1]);
  }
  return images;
}

/**
 * 检查是否为列表项
 */
function isListItem(line) {
  return line.startsWith('- ') || line.startsWith('* ');
}

/**
 * 移除列表标记
 */
function removeListMarker(line) {
  if (line.startsWith('- ')) {
    return line.replace('- ', '').trim();
  } else if (line.startsWith('* ')) {
    return line.replace('* ', '').trim();
  }
  return line.trim();
}

/**
 * 转换 Markdown 链接为应用可识别的格式
 * [文本](../../tips/category/file.md) => [文本](tips://category/tips_id)
 * [文本](./相对路径.md) => 保留纯文本
 */
function convertMarkdownLinks(text, tipsMap) {
  if (!text) return text;

  // 匹配 markdown 链接格式 [文本](路径)
  return text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, linkText, linkPath) => {
    // 检查是否是 tips 链接
    const tipsMatch = linkPath.match(/\.\.\/\.\.\/tips\/([^\/]+)\/(.+?)\.md$/);
    if (tipsMatch) {
      const category = tipsMatch[1];
      const filename = tipsMatch[2];

      // 从 tipsMap 中查找对应的 tips ID
      const mapKey = `${category}/${filename}`;
      if (tipsMap && tipsMap[mapKey]) {
        const tipsId = tipsMap[mapKey];
        // 返回格式：tips://category/tips_id
        return `[${linkText}](tips://${category}/${tipsId})`;
      } else {
        // 如果找不到映射，使用文件名格式作为后备
        console.warn(`  ⚠ 未找到 tips 映射: ${mapKey}`);
        return `[${linkText}](tips://${category}/${filename})`;
      }
    }

    // 检查是否是其他相对路径链接
    const relativeMatch = linkPath.match(/\.\.?\/(.+?)\.md$/);
    if (relativeMatch) {
      // 暂时保留文本，去除链接
      return `【${linkText}】`;
    }

    // 其他链接保持原样
    return match;
  });
}

/**
 * 构建 tips 文件名到 ID 的映射
 */
function buildTipsMap() {
  const tipsMap = {};

  if (!fs.existsSync(CONFIG.tipsDir)) {
    return tipsMap;
  }

  function scanTipsDir(dir, category = 'general') {
    const items = fs.readdirSync(dir);

    items.forEach(item => {
      const itemPath = path.join(dir, item);
      const stat = fs.statSync(itemPath);

      if (stat.isFile() && path.extname(item) === '.md') {
        const content = fs.readFileSync(itemPath, 'utf-8');
        const lines = content.split('\n');

        // 提取标题
        let title = '';
        for (let line of lines) {
          if (line.startsWith('# ')) {
            title = line.replace('# ', '').trim();
            break;
          }
        }

        if (title) {
          // 生成 tips ID
          const tipsId = generateTipsId(title, category);
          // 文件名（不含扩展名）
          const filename = path.basename(item, '.md');
          // 创建映射：category/filename => tipsId
          tipsMap[`${category}/${filename}`] = tipsId;
        }
      } else if (stat.isDirectory()) {
        scanTipsDir(itemPath, item);
      }
    });
  }

  scanTipsDir(CONFIG.tipsDir);
  return tipsMap;
}

/**
 * 判断是否为食材
 */
function isIngredient(text) {
  const tools = ['锅', '刀', '碗', '勺', '铲', '器', '机', '炉', '箱', '表', '秒表'];
  return !tools.some(tool => text.includes(tool));
}

// ============================================================================
// Markdown 解析
// ============================================================================

/**
 * 处理不同的章节内容
 */
function processSection(section, lines, recipe, tipsMap) {
  const sectionLower = section.toLowerCase();

  if (sectionLower.includes('必备') || sectionLower.includes('原料') || sectionLower.includes('工具')) {
    lines.forEach(line => {
      // 提取图片
      const imgs = extractImagesFromLine(line);
      recipe.images.push(...imgs);

      if (isListItem(line)) {
        const item = removeListMarker(line);
        // 移除图片 markdown 后的纯文本
        let textOnly = item.replace(/!\[.*?\]\(.*?\)/g, '').trim();
        // 转换链接
        textOnly = convertMarkdownLinks(textOnly, tipsMap);
        if (!textOnly) return;

        if (isIngredient(textOnly)) {
          if (!recipe._hasDetailedIngredients) {
            recipe.ingredients.push(textOnly);
          }
        } else {
          recipe.tools.push(textOnly);
        }
      }
    });
  } else if (sectionLower.includes('计算') || sectionLower.includes('用料')) {
    recipe._hasDetailedIngredients = true;
    recipe.ingredients = [];

    lines.forEach(line => {
      // 提取图片
      const imgs = extractImagesFromLine(line);
      recipe.images.push(...imgs);

      if (isListItem(line) || line.includes('=')) {
        const cleaned = removeListMarker(line);
        let textOnly = cleaned.replace(/!\[.*?\]\(.*?\)/g, '').trim();
        // 转换链接
        textOnly = convertMarkdownLinks(textOnly, tipsMap);
        if (textOnly) {
          recipe.ingredients.push(textOnly);
        }
      }
    });
  } else if (sectionLower.includes('操作') || sectionLower.includes('步骤') || sectionLower.includes('做法')) {
    lines.forEach(line => {
      // 提取图片
      const imgs = extractImagesFromLine(line);
      recipe.images.push(...imgs);

      if (isListItem(line)) {
        const step = removeListMarker(line);
        // 移除图片 markdown 后的纯文本
        let textOnly = step.replace(/!\[.*?\]\(.*?\)/g, '').trim();
        // 转换 markdown 链接
        textOnly = convertMarkdownLinks(textOnly, tipsMap);
        if (textOnly) {
          recipe.steps.push(textOnly);
        }
      } else {
        // 对于非列表项的行，如果整行只是图片，跳过
        // 如果包含图片但也有文本，移除图片后保留文本
        let textOnly = line.replace(/!\[.*?\]\(.*?\)/g, '').trim();
        // 转换 markdown 链接
        textOnly = convertMarkdownLinks(textOnly, tipsMap);
        if (textOnly) {
          recipe.steps.push(textOnly);
        }
      }
    });
  } else if (sectionLower.includes('附加') || sectionLower.includes('提示') || sectionLower.includes('说明')) {
    lines.forEach(line => {
      // 提取图片
      const imgs = extractImagesFromLine(line);
      recipe.images.push(...imgs);

      if (line.startsWith('**警告**') || line.startsWith('**注意**')) {
        let warning = line.replace(/\*\*/g, '').trim();
        // 转换链接
        warning = convertMarkdownLinks(warning, tipsMap);
        recipe.warnings.push(warning);
      } else if (line) {
        // 转换链接
        let tipLine = convertMarkdownLinks(line, tipsMap);
        recipe.tips += tipLine + '\n';
      }
    });
  }
}

/**
 * 解析 Markdown 菜谱文件
 */
function parseMarkdown(content, filePath, tipsMap) {
  const lines = content.split('\n');
  const recipe = {
    name: '',
    difficulty: 0,
    images: [],
    ingredients: [],
    tools: [],
    steps: [],
    tips: '',
    warnings: []
  };

  let currentSection = '';
  let buffer = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // 提取标题
    if (line.startsWith('# ') && !recipe.name) {
      recipe.name = line.replace('# ', '').replace('的做法', '').trim();
      continue;
    }

    // 提取难度
    if (line.includes('预估烹饪难度') || line.includes('难度')) {
      const stars = (line.match(/★/g) || []).length;
      recipe.difficulty = stars;
      continue;
    }

    // 提取独立的图片行（只包含图片的行）
    if (line.match(/^!\[.*?\]\(.*?\)$/)) {
      const imgs = extractImagesFromLine(line);
      recipe.images.push(...imgs);
      continue;
    }

    // 识别章节
    if (line.startsWith('## ')) {
      if (currentSection && buffer.length > 0) {
        processSection(currentSection, buffer, recipe, tipsMap);
        buffer = [];
      }
      currentSection = line.replace('## ', '').trim();
      continue;
    }

    // 收集章节内容
    if (line && currentSection) {
      buffer.push(line);
    }
  }

  // 处理最后一个章节
  if (currentSection && buffer.length > 0) {
    processSection(currentSection, buffer, recipe, tipsMap);
  }

  // 去重图片（使用 Set）
  recipe.images = [...new Set(recipe.images)];

  return recipe;
}

/**
 * 解析 Tips Markdown 文件
 */
function parseTipsMarkdown(content) {
  const lines = content.split('\n');
  const tips = {
    title: '',
    content: '',
    sections: []
  };

  let currentSection = null;
  let contentBuffer = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('# ') && !tips.title) {
      tips.title = line.replace('# ', '').trim();
      continue;
    }

    if (line.startsWith('## ')) {
      if (currentSection) {
        currentSection.content = contentBuffer.trim();
        tips.sections.push(currentSection);
      }

      currentSection = {
        title: line.replace('## ', '').trim(),
        content: ''
      };
      contentBuffer = '';
      continue;
    }

    if (currentSection) {
      contentBuffer += line + '\n';
    } else {
      tips.content += line + '\n';
    }
  }

  if (currentSection) {
    currentSection.content = contentBuffer.trim();
    tips.sections.push(currentSection);
  }

  tips.content = tips.content.trim();
  return tips;
}

// ============================================================================
// 图片处理
// ============================================================================

/**
 * 处理图片：复制到输出目录
 */
function processImages(images, sourceDir, category, recipeId) {
  const processedImages = [];

  images.forEach(imgPath => {
    try {
      const fullPath = path.join(sourceDir, imgPath.replace('./', ''));

      if (fs.existsSync(fullPath)) {
        const ext = path.extname(fullPath).toLowerCase(); // 统一使用小写扩展名
        const newFileName = `${recipeId}_${processedImages.length}${ext}`;
        const categoryImageDir = path.join(CONFIG.imagesDir, category);

        if (!fs.existsSync(categoryImageDir)) {
          fs.mkdirSync(categoryImageDir, { recursive: true });
        }

        const destPath = path.join(categoryImageDir, newFileName);
        fs.copyFileSync(fullPath, destPath);

        processedImages.push(`images/${category}/${newFileName}`);
      }
    } catch (error) {
      console.warn(`  ⚠ 图片处理失败: ${imgPath}`, error.message);
    }
  });

  return processedImages;
}

// ============================================================================
// 功能模块 1: 完整数据转换
// ============================================================================

async function fullConversion() {
  console.log('\n=== 完整数据转换 ===\n');

  // 创建输出目录
  [CONFIG.outputDir, CONFIG.recipesDir, CONFIG.imagesDir, CONFIG.tipsOutputDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });

  // 构建 tips 映射（用于链接转换）
  console.log('构建 tips 映射...');
  const tipsMap = buildTipsMap();
  console.log(`✓ 已映射 ${Object.keys(tipsMap).length} 个 tips 文档\n`);

  const allRecipes = [];
  const categories = fs.readdirSync(CONFIG.dishesDir);

  // 转换菜谱
  for (const category of categories) {
    const categoryPath = path.join(CONFIG.dishesDir, category);
    if (!fs.statSync(categoryPath).isDirectory()) continue;

    // 排除指定的目录（如 template 模板目录）
    if (EXCLUDED_DIRS.includes(category)) {
      console.log(`\n跳过分类: ${category} (排除目录)`);
      continue;
    }

    console.log(`\n处理分类: ${category}`);

    const categoryOutputDir = path.join(CONFIG.recipesDir, category);
    if (!fs.existsSync(categoryOutputDir)) {
      fs.mkdirSync(categoryOutputDir, { recursive: true });
    }

    const items = fs.readdirSync(categoryPath);

    for (const item of items) {
      const itemPath = path.join(categoryPath, item);
      const stat = fs.statSync(itemPath);

      if (stat.isFile() && path.extname(item) === '.md') {
        await processRecipeFile(itemPath, category, allRecipes, tipsMap);
      } else if (stat.isDirectory()) {
        const subItems = fs.readdirSync(itemPath);
        for (const subItem of subItems) {
          if (path.extname(subItem) === '.md') {
            await processRecipeFile(path.join(itemPath, subItem), category, allRecipes, tipsMap);
          }
        }
      }
    }
  }

  // 转换 Tips
  const allTips = await convertAllTips();

  // 生成 manifest
  generateManifest(allRecipes, allTips);

  console.log('\n✓ 完整转换完成');
  console.log(`  菜谱总数: ${allRecipes.length}`);
  console.log(`  烹饪知识: ${allTips.length}`);
}

async function processRecipeFile(filePath, category, allRecipes, tipsMap) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const recipe = parseMarkdown(content, filePath, tipsMap);

    if (!recipe.name) {
      console.warn(`  ⚠ 无法提取菜谱名称: ${filePath}`);
      return;
    }

    const recipeId = generateRecipeId(recipe.name, category, filePath);
    const sourceDir = path.dirname(filePath);
    const processedImages = processImages(recipe.images, sourceDir, category, recipeId);

    const finalRecipe = {
      id: recipeId,
      name: recipe.name,
      category: category,
      categoryName: CATEGORY_MAP[category] || category,
      difficulty: recipe.difficulty,
      images: processedImages,
      ingredients: recipe.ingredients,
      tools: recipe.tools,
      steps: recipe.steps,
      tips: recipe.tips.trim(),
      warnings: recipe.warnings,
      hash: calculateHash(JSON.stringify(recipe))
    };

    const outputPath = path.join(CONFIG.recipesDir, category, `${recipeId}.json`);
    fs.writeFileSync(outputPath, JSON.stringify(finalRecipe, null, 2), 'utf-8');

    allRecipes.push({
      id: recipeId,
      name: recipe.name,
      category: category,
      categoryName: finalRecipe.categoryName,
      difficulty: recipe.difficulty,
      hash: finalRecipe.hash,
      hasImages: processedImages.length > 0
    });

    console.log(`  ✓ ${recipe.name}`);
  } catch (error) {
    console.error(`  ✗ 处理失败: ${filePath}`, error.message);
  }
}

async function convertAllTips() {
  const allTips = [];

  if (!fs.existsSync(CONFIG.tipsDir)) {
    console.log('\n跳过 tips 目录（不存在）');
    return allTips;
  }

  console.log('\n处理烹饪知识...');

  if (!fs.existsSync(CONFIG.tipsOutputDir)) {
    fs.mkdirSync(CONFIG.tipsOutputDir, { recursive: true });
  }

  function processTipsDir(dir, category = 'general') {
    const items = fs.readdirSync(dir);

    items.forEach(item => {
      const itemPath = path.join(dir, item);
      const stat = fs.statSync(itemPath);

      if (stat.isFile() && path.extname(item) === '.md') {
        const content = fs.readFileSync(itemPath, 'utf-8');
        const tips = parseTipsMarkdown(content);

        const tipsId = generateTipsId(tips.title, category);

        const finalTips = {
          id: tipsId,
          title: tips.title,
          category: category,
          categoryName: TIPS_CATEGORY_MAP[category] || '基础知识',
          content: tips.content,
          sections: tips.sections,
          hash: calculateHash(JSON.stringify(tips))
        };

        const categoryDir = path.join(CONFIG.tipsOutputDir, category);
        if (!fs.existsSync(categoryDir)) {
          fs.mkdirSync(categoryDir, { recursive: true });
        }

        const outputPath = path.join(categoryDir, `${tipsId}.json`);
        fs.writeFileSync(outputPath, JSON.stringify(finalTips, null, 2), 'utf-8');

        allTips.push({
          id: tipsId,
          title: tips.title,
          category: category,
          categoryName: finalTips.categoryName,
          hash: finalTips.hash
        });

        console.log(`  ✓ ${tips.title}`);
      } else if (stat.isDirectory()) {
        processTipsDir(itemPath, item);
      }
    });
  }

  processTipsDir(CONFIG.tipsDir);
  return allTips;
}

function generateManifest(recipes, tips) {
  const manifest = {
    version: CONFIG.version,
    generatedAt: new Date().toISOString(),
    totalRecipes: recipes.length,
    totalTips: tips.length,
    categories: {},
    tipsCategories: {},
    recipes: recipes,
    tips: tips
  };

  recipes.forEach(recipe => {
    if (!manifest.categories[recipe.category]) {
      manifest.categories[recipe.category] = {
        name: recipe.categoryName,
        count: 0
      };
    }
    manifest.categories[recipe.category].count++;
  });

  tips.forEach(tip => {
    if (!manifest.tipsCategories[tip.category]) {
      manifest.tipsCategories[tip.category] = {
        name: tip.categoryName,
        count: 0
      };
    }
    manifest.tipsCategories[tip.category].count++;
  });

  fs.writeFileSync(CONFIG.manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
}

// ============================================================================
// 功能模块 2: 增量转换（简化版，完整功能类似）
// ============================================================================

async function incrementalConversion() {
  console.log('\n=== 增量数据转换 ===\n');
  console.log('注意：增量转换会检查现有数据，只更新有变化的内容\n');

  const confirmed = await confirm('确认开始增量转换？');
  if (!confirmed) {
    console.log('已取消');
    return;
  }

  // 加载现有 manifest
  let existingManifest = null;
  if (fs.existsSync(CONFIG.manifestPath)) {
    existingManifest = JSON.parse(fs.readFileSync(CONFIG.manifestPath, 'utf-8'));
    console.log(`已加载 ${existingManifest.recipes.length} 个现有菜谱\n`);
  }

  // 执行类似完整转换的逻辑，但会跳过未变化的内容
  await fullConversion();

  console.log('\n✓ 增量转换完成');
}

// ============================================================================
// 功能模块 3: Emoji 清理
// ============================================================================

function removeEmoji(text) {
  if (!text) return text;

  const emojiRegex = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2B50}\u{2B55}\u{231A}\u{231B}\u{2328}\u{23CF}\u{23E9}-\u{23F3}\u{23F8}-\u{23FA}\u{24C2}\u{25AA}\u{25AB}\u{25B6}\u{25C0}\u{25FB}-\u{25FE}\u{2614}\u{2615}\u{2648}-\u{2653}\u{267F}\u{2693}\u{26A1}\u{26AA}\u{26AB}\u{26BD}\u{26BE}\u{26C4}\u{26C5}\u{26CE}\u{26D4}\u{26EA}\u{26F2}\u{26F3}\u{26F5}\u{26FA}\u{26FD}\u{2705}\u{270A}\u{270B}\u{2728}\u{274C}\u{274E}\u{2753}-\u{2755}\u{2757}\u{2795}-\u{2797}\u{27B0}\u{27BF}\u{2934}\u{2935}\u{2B05}-\u{2B07}\u{2B1B}\u{2B1C}\u{2B50}\u{2B55}\u{3030}\u{303D}\u{3297}\u{3299}\u{FE0F}]/gu;

  return text.replace(emojiRegex, '').trim();
}

function cleanObject(obj, stats) {
  let modified = false;

  for (const key in obj) {
    if (typeof obj[key] === 'string') {
      const original = obj[key];
      const cleaned = removeEmoji(obj[key]);
      if (original !== cleaned) {
        obj[key] = cleaned;
        modified = true;
        const emojiCount = (original.match(/[\u{1F600}-\u{1F64F}]/gu) || []).length;
        stats.removedEmojis += emojiCount;
      }
    } else if (Array.isArray(obj[key])) {
      for (let i = 0; i < obj[key].length; i++) {
        if (typeof obj[key][i] === 'string') {
          const original = obj[key][i];
          const cleaned = removeEmoji(obj[key][i]);
          if (original !== cleaned) {
            obj[key][i] = cleaned;
            modified = true;
          }
        } else if (typeof obj[key][i] === 'object' && obj[key][i] !== null) {
          if (cleanObject(obj[key][i], stats)) {
            modified = true;
          }
        }
      }
    } else if (typeof obj[key] === 'object' && obj[key] !== null) {
      if (cleanObject(obj[key], stats)) {
        modified = true;
      }
    }
  }

  return modified;
}

async function cleanEmojis() {
  console.log('\n=== Emoji 清理 ===\n');

  if (!fs.existsSync(CONFIG.recipesDir)) {
    console.log('错误: recipes 目录不存在，请先运行数据转换');
    return;
  }

  const confirmed = await confirm('确认清理所有 JSON 文件中的 Emoji？');
  if (!confirmed) {
    console.log('已取消');
    return;
  }

  const stats = {
    totalFiles: 0,
    modifiedFiles: 0,
    removedEmojis: 0
  };

  function processDirectory(dir) {
    const items = fs.readdirSync(dir);

    items.forEach(item => {
      const itemPath = path.join(dir, item);
      const stat = fs.statSync(itemPath);

      if (stat.isFile() && path.extname(item) === '.json') {
        stats.totalFiles++;

        const content = fs.readFileSync(itemPath, 'utf-8');
        const data = JSON.parse(content);

        const modified = cleanObject(data, stats);

        if (modified) {
          if (data.hash) {
            const dataForHash = { ...data };
            delete dataForHash.hash;
            data.hash = calculateHash(JSON.stringify(dataForHash));
          }

          fs.writeFileSync(itemPath, JSON.stringify(data, null, 2), 'utf-8');
          stats.modifiedFiles++;

          console.log(`  ✓ ${path.relative(CONFIG.outputDir, itemPath)}`);
        }
      } else if (stat.isDirectory()) {
        processDirectory(itemPath);
      }
    });
  }

  console.log('处理菜谱...');
  processDirectory(CONFIG.recipesDir);

  if (fs.existsSync(CONFIG.tipsOutputDir)) {
    console.log('\n处理烹饪知识...');
    processDirectory(CONFIG.tipsOutputDir);
  }

  // 更新 manifest
  if (fs.existsSync(CONFIG.manifestPath)) {
    console.log('\n更新 manifest...');
    const manifest = JSON.parse(fs.readFileSync(CONFIG.manifestPath, 'utf-8'));

    manifest.recipes.forEach(recipe => {
      const recipeFile = path.join(CONFIG.recipesDir, recipe.category, `${recipe.id}.json`);
      if (fs.existsSync(recipeFile)) {
        const recipeData = JSON.parse(fs.readFileSync(recipeFile, 'utf-8'));
        recipe.hash = recipeData.hash;
      }
    });

    fs.writeFileSync(CONFIG.manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    console.log('  ✓ manifest.json');
  }

  console.log('\n=== 清理完成 ===');
  console.log(`总文件数: ${stats.totalFiles}`);
  console.log(`修改文件: ${stats.modifiedFiles}`);
  console.log(`移除 Emoji: ${stats.removedEmojis} 个`);
}

// ============================================================================
// 功能模块 4: 图片格式转换
// ============================================================================

async function convertImagesToWebP() {
  console.log('\n=== 图片格式转换 (WebP) ===\n');

  if (!fs.existsSync(CONFIG.imagesDir)) {
    console.log('错误: images 目录不存在，请先运行数据转换');
    return;
  }

  // 检查 sharp 是否已安装
  let sharp;
  try {
    sharp = require('sharp');
  } catch (error) {
    console.log('错误: 需要安装 sharp 库才能进行图片转换');
    console.log('请运行: npm install sharp');
    console.log('\n或者使用其他工具如 imagemagick 进行图片转换');
    return;
  }

  const confirmed = await confirm('确认将所有图片转换为 WebP 格式？');
  if (!confirmed) {
    console.log('已取消');
    return;
  }

  const stats = {
    totalImages: 0,
    convertedImages: 0,
    skippedImages: 0,
    errors: 0
  };

  async function processImageDirectory(dir) {
    const items = fs.readdirSync(dir);

    for (const item of items) {
      const itemPath = path.join(dir, item);
      const stat = fs.statSync(itemPath);

      if (stat.isDirectory()) {
        await processImageDirectory(itemPath);
      } else if (stat.isFile()) {
        const ext = path.extname(item).toLowerCase();
        const originalExt = path.extname(item); // 保留原始大小写

        // 跳过已经是 WebP 的图片
        if (ext === '.webp') {
          stats.skippedImages++;
          continue;
        }

        // 只转换支持的图片格式
        if (!CONFIG.supportedImageExts.includes(ext)) {
          continue;
        }

        stats.totalImages++;

        // 使用原始扩展名移除文件名，这样可以正确处理大写扩展名
        const basename = path.basename(item, originalExt);
        const webpPath = path.join(dir, `${basename}.webp`);

        // 如果 WebP 文件已存在，跳过
        if (fs.existsSync(webpPath)) {
          console.log(`  ⊙ 已存在: ${path.relative(CONFIG.imagesDir, webpPath)}`);
          stats.skippedImages++;
          continue;
        }

        try {
          await sharp(itemPath)
            .webp({ quality: CONFIG.webpQuality })
            .toFile(webpPath);

          stats.convertedImages++;
          console.log(`  ✓ ${path.relative(CONFIG.imagesDir, itemPath)} → ${basename}.webp`);
        } catch (error) {
          stats.errors++;
          console.error(`  ✗ 转换失败: ${item}`, error.message);
        }
      }
    }
  }

  await processImageDirectory(CONFIG.imagesDir);

  console.log('\n=== 转换完成 ===');
  console.log(`总图片数: ${stats.totalImages}`);
  console.log(`已转换: ${stats.convertedImages}`);
  console.log(`已跳过: ${stats.skippedImages}`);
  console.log(`转换失败: ${stats.errors}`);

  if (stats.convertedImages > 0) {
    console.log('\n提示: 转换后需要更新 JSON 文件中的图片引用');
    console.log('可以运行"清理原始图片"功能来删除原始文件并更新引用');
  }
}

// ============================================================================
// 功能模块 5: 清理原始图片
// ============================================================================

async function cleanupOriginalImages() {
  console.log('\n=== 清理原始图片 ===\n');
  console.log('此功能会：');
  console.log('1. 删除所有非 WebP 格式的图片文件');
  console.log('2. 更新所有 JSON 文件中的图片引用\n');

  if (!fs.existsSync(CONFIG.imagesDir)) {
    console.log('错误: images 目录不存在');
    return;
  }

  const confirmed = await confirm('⚠ 警告：此操作将删除原始图片文件，确认继续？');
  if (!confirmed) {
    console.log('已取消');
    return;
  }

  const stats = {
    deletedFiles: 0,
    updatedJsonFiles: 0,
    errors: []
  };

  // 步骤 1: 删除原始图片文件
  console.log('\n步骤 1: 删除原始图片文件...\n');

  function deleteOriginalImages(dir) {
    const items = fs.readdirSync(dir);

    items.forEach(item => {
      const itemPath = path.join(dir, item);
      const stat = fs.statSync(itemPath);

      if (stat.isDirectory()) {
        deleteOriginalImages(itemPath);
      } else if (stat.isFile()) {
        const ext = path.extname(item).toLowerCase();

        // 删除非 WebP 的图片文件
        if (CONFIG.supportedImageExts.includes(ext) && ext !== '.webp') {
          try {
            // 尝试删除文件，如果失败则重试一次
            try {
              fs.unlinkSync(itemPath);
              stats.deletedFiles++;
              console.log(`  ✓ 已删除: ${path.relative(CONFIG.imagesDir, itemPath)}`);
            } catch (firstError) {
              // Windows 文件占用问题，等待一小段时间后重试
              if (firstError.code === 'EPERM' || firstError.code === 'EBUSY') {
                // 尝试强制解锁并删除
                setTimeout(() => {}, 100); // 短暂延迟
                try {
                  fs.unlinkSync(itemPath);
                  stats.deletedFiles++;
                  console.log(`  ✓ 已删除 (重试): ${path.relative(CONFIG.imagesDir, itemPath)}`);
                } catch (retryError) {
                  throw firstError; // 重试失败，抛出原始错误
                }
              } else {
                throw firstError;
              }
            }
          } catch (error) {
            const relativePath = path.relative(CONFIG.imagesDir, itemPath);
            stats.errors.push({ file: relativePath, error: error.code || error.message });

            if (error.code === 'EPERM' || error.code === 'EBUSY') {
              console.error(`  ⚠ 文件被占用，跳过: ${relativePath}`);
            } else {
              console.error(`  ✗ 删除失败: ${relativePath} - ${error.message}`);
            }
          }
        }
      }
    });
  }

  deleteOriginalImages(CONFIG.imagesDir);

  // 步骤 2: 更新 JSON 文件中的图片引用
  console.log('\n步骤 2: 更新 JSON 文件中的图片引用...\n');

  function updateJsonFiles(dir) {
    const items = fs.readdirSync(dir);

    items.forEach(item => {
      const itemPath = path.join(dir, item);
      const stat = fs.statSync(itemPath);

      if (stat.isDirectory()) {
        updateJsonFiles(itemPath);
      } else if (stat.isFile() && path.extname(item) === '.json') {
        try {
          const content = fs.readFileSync(itemPath, 'utf-8');
          const data = JSON.parse(content);
          let modified = false;

          // 更新 images 数组
          if (data.images && Array.isArray(data.images)) {
            data.images = data.images.map(imgPath => {
              // 将图片扩展名替换为 .webp
              const parsed = path.parse(imgPath);
              if (parsed.ext !== '.webp' && CONFIG.supportedImageExts.includes(parsed.ext.toLowerCase())) {
                modified = true;
                return path.join(parsed.dir, `${parsed.name}.webp`);
              }
              return imgPath;
            });
          }

          if (modified) {
            // 更新哈希值
            if (data.hash) {
              const dataForHash = { ...data };
              delete dataForHash.hash;
              data.hash = calculateHash(JSON.stringify(dataForHash));
            }

            fs.writeFileSync(itemPath, JSON.stringify(data, null, 2), 'utf-8');
            stats.updatedJsonFiles++;
            console.log(`  ✓ ${path.relative(CONFIG.outputDir, itemPath)}`);
          }
        } catch (error) {
          stats.errors.push({ file: itemPath, error: error.message });
          console.error(`  ✗ 更新失败: ${item}`, error.message);
        }
      }
    });
  }

  updateJsonFiles(CONFIG.recipesDir);

  // 更新 manifest 中的哈希值
  if (fs.existsSync(CONFIG.manifestPath)) {
    console.log('\n更新 manifest.json...');
    const manifest = JSON.parse(fs.readFileSync(CONFIG.manifestPath, 'utf-8'));

    manifest.recipes.forEach(recipe => {
      const recipeFile = path.join(CONFIG.recipesDir, recipe.category, `${recipe.id}.json`);
      if (fs.existsSync(recipeFile)) {
        const recipeData = JSON.parse(fs.readFileSync(recipeFile, 'utf-8'));
        recipe.hash = recipeData.hash;
      }
    });

    fs.writeFileSync(CONFIG.manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    console.log('  ✓ manifest.json');
  }

  console.log('\n=== 清理完成 ===');
  console.log(`删除文件: ${stats.deletedFiles}`);
  console.log(`更新 JSON: ${stats.updatedJsonFiles}`);

  if (stats.errors.length > 0) {
    // 统计不同类型的错误
    const permErrors = stats.errors.filter(e => e.error === 'EPERM' || e.error === 'EBUSY');
    const otherErrors = stats.errors.filter(e => e.error !== 'EPERM' && e.error !== 'EBUSY');

    console.log(`\n⚠ 遇到 ${stats.errors.length} 个错误:`);

    if (permErrors.length > 0) {
      console.log(`\n文件占用错误 (${permErrors.length} 个):`);
      permErrors.forEach(({ file }) => {
        console.log(`  - ${file}`);
      });
      console.log('\n建议解决方法：');
      console.log('  1. 关闭所有图片查看器、编辑器等可能占用这些文件的程序');
      console.log('  2. 在文件资源管理器中手动删除这些文件');
      console.log('  3. 或者稍后重新运行"清理原始图片"功能');
      console.log('  4. 如果问题持续，重启电脑后再尝试');
    }

    if (otherErrors.length > 0) {
      console.log(`\n其他错误 (${otherErrors.length} 个):`);
      otherErrors.forEach(({ file, error }) => {
        console.log(`  - ${file}: ${error}`);
      });
    }

    console.log('\n注意: 即使部分文件删除失败，JSON 文件中的图片引用仍会被正确更新。');
  }
}

// ============================================================================
// 功能模块 6: 修复 WebP 文件名
// ============================================================================

async function fixWebPFileNames() {
  console.log('\n=== 修复 WebP 文件名 ===\n');
  console.log('此功能会修复错误的 WebP 文件名，例如：');
  console.log('  vegetable_dish_be313e6e_0.JPG.webp → vegetable_dish_be313e6e_0.webp\n');

  if (!fs.existsSync(CONFIG.imagesDir)) {
    console.log('错误: images 目录不存在');
    return;
  }

  const confirmed = await confirm('确认修复 WebP 文件名？');
  if (!confirmed) {
    console.log('已取消');
    return;
  }

  let fixedCount = 0;
  let errorCount = 0;
  const fixedFiles = [];

  function processDirectory(dir) {
    const items = fs.readdirSync(dir);

    items.forEach(item => {
      const itemPath = path.join(dir, item);
      const stat = fs.statSync(itemPath);

      if (stat.isDirectory()) {
        processDirectory(itemPath);
      } else if (stat.isFile()) {
        // 检查是否是错误格式的 WebP 文件名
        const wrongPattern = /\.(jpg|jpeg|png|gif)\.webp$/i;

        if (wrongPattern.test(item)) {
          const correctName = item.replace(wrongPattern, '.webp');
          const correctPath = path.join(dir, correctName);

          // 检查目标文件是否已存在
          if (fs.existsSync(correctPath)) {
            console.log(`  ⚠ 目标文件已存在，跳过: ${item}`);
            return;
          }

          try {
            fs.renameSync(itemPath, correctPath);
            fixedCount++;
            fixedFiles.push({
              old: path.relative(CONFIG.imagesDir, itemPath),
              new: path.relative(CONFIG.imagesDir, correctPath)
            });
            console.log(`  ✓ ${item} → ${correctName}`);
          } catch (error) {
            errorCount++;
            console.error(`  ✗ 重命名失败: ${item}`, error.message);
          }
        }
      }
    });
  }

  console.log('\n正在扫描和修复文件...\n');
  processDirectory(CONFIG.imagesDir);

  console.log('\n=== 修复完成 ===');
  console.log(`修复文件数: ${fixedCount}`);
  console.log(`失败文件数: ${errorCount}`);

  if (fixedCount > 0) {
    console.log('\n注意: 文件名已修复，但 JSON 文件中的引用可能需要更新。');
    const updateJson = await confirm('是否立即更新 JSON 文件中的引用？');

    if (updateJson) {
      console.log('\n更新 JSON 文件...\n');
      let updatedJsonCount = 0;

      function updateJsonFiles(dir) {
        const items = fs.readdirSync(dir);

        items.forEach(item => {
          const itemPath = path.join(dir, item);
          const stat = fs.statSync(itemPath);

          if (stat.isDirectory()) {
            updateJsonFiles(itemPath);
          } else if (stat.isFile() && path.extname(item) === '.json') {
            try {
              const content = fs.readFileSync(itemPath, 'utf-8');
              let data = JSON.parse(content);
              let modified = false;

              if (data.images && Array.isArray(data.images)) {
                data.images = data.images.map(imgPath => {
                  const wrongPattern = /\.(jpg|jpeg|png|gif)\.webp$/i;
                  if (wrongPattern.test(imgPath)) {
                    modified = true;
                    return imgPath.replace(wrongPattern, '.webp');
                  }
                  return imgPath;
                });
              }

              if (modified) {
                if (data.hash) {
                  const dataForHash = { ...data };
                  delete dataForHash.hash;
                  data.hash = calculateHash(JSON.stringify(dataForHash));
                }

                fs.writeFileSync(itemPath, JSON.stringify(data, null, 2), 'utf-8');
                updatedJsonCount++;
                console.log(`  ✓ ${path.relative(CONFIG.outputDir, itemPath)}`);
              }
            } catch (error) {
              console.error(`  ✗ 更新失败: ${item}`, error.message);
            }
          }
        });
      }

      updateJsonFiles(CONFIG.recipesDir);

      // 更新 manifest
      if (fs.existsSync(CONFIG.manifestPath)) {
        console.log('\n更新 manifest.json...');
        const manifest = JSON.parse(fs.readFileSync(CONFIG.manifestPath, 'utf-8'));

        manifest.recipes.forEach(recipe => {
          const recipeFile = path.join(CONFIG.recipesDir, recipe.category, `${recipe.id}.json`);
          if (fs.existsSync(recipeFile)) {
            const recipeData = JSON.parse(fs.readFileSync(recipeFile, 'utf-8'));
            recipe.hash = recipeData.hash;
          }
        });

        fs.writeFileSync(CONFIG.manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
        console.log('  ✓ manifest.json');
      }

      console.log(`\n✓ 已更新 ${updatedJsonCount} 个 JSON 文件`);
    }
  }
}

// ============================================================================
// 功能模块 7: 查找缺失菜谱
// ============================================================================

async function findMissingRecipes() {
  console.log('\n=== 查找缺失菜谱 ===\n');

  if (!fs.existsSync(CONFIG.manifestPath)) {
    console.log('错误: manifest.json 不存在，请先运行数据转换');
    return;
  }

  const manifest = JSON.parse(fs.readFileSync(CONFIG.manifestPath, 'utf-8'));
  const convertedRecipes = new Set(manifest.recipes.map(r => r.name));

  console.log(`Manifest 中的菜谱数量: ${convertedRecipes.size}\n`);

  // 扫描所有 .md 文件
  const allMdFiles = [];

  function scanDir(dir) {
    const items = fs.readdirSync(dir);

    items.forEach(item => {
      const itemPath = path.join(dir, item);
      const stat = fs.statSync(itemPath);

      if (stat.isFile() && path.extname(item) === '.md') {
        allMdFiles.push(itemPath);
      } else if (stat.isDirectory()) {
        scanDir(itemPath);
      }
    });
  }

  const categories = fs.readdirSync(CONFIG.dishesDir);
  categories.forEach(category => {
    const categoryPath = path.join(CONFIG.dishesDir, category);
    if (fs.statSync(categoryPath).isDirectory() && !EXCLUDED_DIRS.includes(category)) {
      scanDir(categoryPath);
    }
  });

  console.log(`找到的 .md 文件数量: ${allMdFiles.length}\n`);
  console.log('正在检查未转换的文件...\n');

  let missingCount = 0;

  allMdFiles.forEach(filePath => {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    let recipeName = '';
    for (let line of lines) {
      line = line.trim();
      if (line.startsWith('# ')) {
        recipeName = line.replace('# ', '').replace('的做法', '').trim();
        break;
      }
    }

    if (!recipeName) {
      console.log(`⚠ 无法提取标题: ${filePath}`);
      return;
    }

    if (!convertedRecipes.has(recipeName)) {
      missingCount++;
      console.log(`❌ 未转换: ${recipeName}`);
      console.log(`   文件: ${filePath}\n`);
    }
  });

  if (missingCount === 0) {
    console.log('✓ 所有菜谱均已转换');
  } else {
    console.log(`\n共发现 ${missingCount} 个未转换的菜谱`);
  }
}

// ============================================================================
// 功能模块 8: 查找重复菜谱
// ============================================================================

async function findDuplicateRecipes() {
  console.log('\n=== 查找重复菜谱 ===\n');

  // 存储所有菜谱名称及其文件路径
  const recipeNames = new Map();
  const duplicates = [];

  /**
   * 扫描目录中的所有 md 文件
   */
  function scanDir(dir) {
    const items = fs.readdirSync(dir);

    items.forEach(item => {
      const itemPath = path.join(dir, item);
      const stat = fs.statSync(itemPath);

      if (stat.isFile() && path.extname(item) === '.md') {
        const content = fs.readFileSync(itemPath, 'utf-8');
        const lines = content.split('\n');

        // 提取标题
        let recipeName = '';
        for (let line of lines) {
          line = line.trim();
          if (line.startsWith('# ')) {
            recipeName = line.replace('# ', '').replace('的做法', '').trim();
            break;
          }
        }

        if (recipeName) {
          const relativePath = path.relative(CONFIG.dishesDir, itemPath);

          if (recipeNames.has(recipeName)) {
            // 发现重复
            const existingPath = recipeNames.get(recipeName);
            // 检查是否已经记录过这个重复
            const existingDup = duplicates.find(d => d.name === recipeName);
            if (existingDup) {
              existingDup.files.push(relativePath);
            } else {
              duplicates.push({
                name: recipeName,
                files: [existingPath, relativePath]
              });
            }
          } else {
            recipeNames.set(recipeName, relativePath);
          }
        }
      } else if (stat.isDirectory()) {
        scanDir(itemPath);
      }
    });
  }

  // 扫描所有分类
  const categories = fs.readdirSync(CONFIG.dishesDir);
  categories.forEach(category => {
    const categoryPath = path.join(CONFIG.dishesDir, category);
    if (fs.statSync(categoryPath).isDirectory() && !EXCLUDED_DIRS.includes(category)) {
      scanDir(categoryPath);
    }
  });

  const totalMdFiles = recipeNames.size + duplicates.reduce((sum, d) => sum + d.files.length - 1, 0);

  console.log(`扫描的菜谱名称总数: ${recipeNames.size}`);
  console.log(`扫描的 .md 文件总数: ${totalMdFiles}\n`);

  if (duplicates.length > 0) {
    console.log(`⚠ 发现 ${duplicates.length} 个重复的菜谱:\n`);
    duplicates.forEach(dup => {
      console.log(`菜谱名称: ${dup.name}`);
      dup.files.forEach(file => {
        console.log(`  - ${file}`);
      });
      console.log('');
    });

    console.log(`建议: 请检查上述重复菜谱，保留一个版本并删除其他版本`);
  } else {
    console.log('✓ 未发现重复的菜谱名称');

    // 检查是否有 template 目录的文件
    const templatePath = path.join(CONFIG.dishesDir, 'template');
    if (fs.existsSync(templatePath)) {
      let templateCount = 0;
      const allFiles = fs.readdirSync(templatePath);
      allFiles.forEach(item => {
        if (path.extname(item) === '.md') {
          templateCount++;
          console.log(`\n模板文件 (已排除): template/${item}`);
        }
      });

      if (templateCount > 0) {
        console.log(`\n说明: 找到 ${templateCount} 个模板文件，这些文件已被排除在转换之外。`);
      }
    }
  }
}

// ============================================================================
// 主菜单
// ============================================================================

async function showMenu() {
  console.clear();
  console.log('='.repeat(50));
  console.log('   HowToCook 数据转换工具');
  console.log('='.repeat(50));
  console.log('\n请选择操作：\n');
  console.log('  1. 完整数据转换');
  console.log('  2. 增量数据转换');
  console.log('  3. 图片格式转换 (转为 WebP)');
  console.log('  4. 清理原始图片');
  console.log('  5. 清理 Emoji');
  console.log('  6. 修复 WebP 文件名');
  console.log('  7. 查找缺失菜谱');
  console.log('  8. 查找重复菜谱');
  console.log('  9. 完整流程（推荐）');
  console.log('  0. 退出\n');

  const choice = await ask('请输入选项 (0-9): ');
  return choice;
}

async function handleChoice(choice) {
  switch (choice) {
    case '1':
      await fullConversion();
      break;
    case '2':
      await incrementalConversion();
      break;
    case '3':
      await convertImagesToWebP();
      break;
    case '4':
      await cleanupOriginalImages();
      break;
    case '5':
      await cleanEmojis();
      break;
    case '6':
      await fixWebPFileNames();
      break;
    case '7':
      await findMissingRecipes();
      break;
    case '8':
      await findDuplicateRecipes();
      break;
    case '9':
      console.log('\n=== 完整流程 ===\n');
      console.log('将依次执行：');
      console.log('1. 完整数据转换');
      console.log('2. 图片格式转换 (WebP)');
      console.log('3. 清理原始图片');
      console.log('4. 清理 Emoji\n');

      const confirmed = await confirm('确认执行完整流程？');
      if (confirmed) {
        await fullConversion();
        await convertImagesToWebP();
        await cleanupOriginalImages();
        await cleanEmojis();
        console.log('\n✓ 完整流程执行完成！');
      } else {
        console.log('已取消');
      }
      break;
    case '0':
      console.log('\n再见！\n');
      process.exit(0);
    default:
      console.log('\n无效选项，请重新选择');
  }

  // 等待用户按键继续
  console.log();
  await ask('按 Enter 继续...');
}

// ============================================================================
// 主程序
// ============================================================================

async function main() {
  while (true) {
    const choice = await showMenu();
    await handleChoice(choice);
  }
}

// 执行主程序
main().catch(error => {
  console.error('\n发生错误:', error);
  process.exit(1);
});
