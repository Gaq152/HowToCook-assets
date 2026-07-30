# HowToCook 静态数据仓库

本仓库同时维护两个互不干扰的数据通道：

- **V1（兼容通道）**：根目录的 `manifest.json`、`recipes/`、`images/`、`tips/`。为已发布的旧版 App 保持冻结。
- **V2（版本化通道）**：`channels/v2-stable.json` 指向 `versions/2/{dataVersion}/` 下的不可变全量数据。

V2 从 [Gaq152/HowToCook](https://github.com/Gaq152/HowToCook) 的固定提交构建，使用 Markdown AST 解析，完整保留上游原始板块，同时输出 Flutter 易于消费的结构化字段。

## V2 快速开始

```bash
git clone https://github.com/Gaq152/HowToCook-assets.git
cd HowToCook-assets
git clone https://github.com/Gaq152/HowToCook.git origin
npm ci

# YYYY.MM.DD.N 必须是一个尚未发布的数据版本
node scripts/v2/build.mjs \
  --source origin \
  --data-version 2026.07.28.1 \
  --update-registry

node scripts/v2/validate.mjs --data-version 2026.07.28.1
npm test
```

构建器只会清理目标 `versions/2/{dataVersion}`，不会修改根目录 V1 数据。构建与发布设计详见 [V2_DATA_FORMAT.md](V2_DATA_FORMAT.md)。

## V2 稳定入口

```text
https://gaq152.github.io/HowToCook-assets/channels/v2-stable.json
```

客户端先读取 channel，再读取其中 `manifestPath` 指向的版本化 manifest。版本目录发布后不可原地修改；需要修正数据时必须提升 `dataVersion`。

构建器默认拒绝覆盖已存在的版本目录。只有在首次发布前验证可复现性时才可添加 `--rebuild`；已经推送的版本禁止重建后覆盖。

## AI 封面生成（独立版本通道）

AI 封面与 V2 菜谱数据分开发布，避免重生成封面时修改已经发布的不可变数据目录。封面按稳定 UUID 命名，生成过程先写入 `.staging/`，只有全量校验通过并人工审核后才切换 `channels/v2-covers-stable.json`。

生成器使用 OpenAI Images 兼容接口，默认连接 `https://api.krill-ai.net/v1`，API Key 只从环境变量或已被 Git 忽略的仓库 `.env` 读取。可以复制 `.env.example` 后填写，也可以在当前终端设置：

```powershell
$env:KRILL_AI_API_KEY = '你的 API Key'
```

先生成完整计划，不会调用接口或消耗额度：

```bash
node scripts/covers/generate.mjs \
  --data-version 2026.07.28.1 \
  --cover-version 2026.07.29.1
```

生成器使用菜谱名称、简介和经过工具过滤的可食用食材进行文生图，不读取上游实拍图或操作步骤，也不会把 `tools` 字段及误混入食材列表的厨具传给模型。默认先处理当前 APP 中没有旧封面的菜谱，再按稳定 UUID 升序替换已有封面；输出统一压缩为适合移动端的 512×512 WebP（质量 80）。建议先选择少量菜谱试生成并审核风格：

```bash
node scripts/covers/generate.mjs \
  --data-version 2026.07.28.1 \
  --cover-version 2026.07.29.1 \
  --limit 3 \
  --execute
```

接口每天最多免费调用 100 次。生成器默认关闭单张图片的内部自动重试，并在暂存区追加记录每次调用；失败项会保留为待处理并在下次运行时优先重试。确认效果后去掉 `--limit`，脚本会自动使用当天剩余额度，最多调用 100 次：

```bash
node scripts/covers/generate.mjs \
  --data-version 2026.07.28.1 \
  --cover-version 2026.07.29.1 \
  --execute
```

第二天再次执行相同命令即可从未完成项继续，不会重复调用已经成功的菜谱。脚本默认单并发，失败项记录在 `.staging/covers/2/{coverVersion}/errors/`，每日调用流水记录在 `attempts.jsonl`。可使用 `--category` 或重复传入 `--id` 精确选择菜谱，也可用 `--daily-quota` 设置小于 100 的本地日限额。

每日批次结束后可先执行部分校验，并生成已有旧封面替换项的联系表做视觉审核：

```bash
node scripts/covers/validate.mjs --data-version 2026.07.28.1 --cover-version 2026.07.29.1 --allow-partial
node scripts/covers/review.mjs --cover-version 2026.07.29.1 --only-replacements --generated-on 2026-07-30
```

若第三方接口返回“今日免费生图次数已达上限”，生成器会立即停止尚未发出的请求；若连续 4 次返回空图片数据，也会临时熔断批次，避免接口波动时浪费整日额度。再次运行相同命令即可继续。

如需只调整已经生成图片的移动端尺寸和压缩质量（不会调用接口），可执行：

```bash
node scripts/covers/optimize.mjs \
  --cover-version 2026.07.29.1 \
  --output-size 512 \
  --webp-quality 80
```

审核通过并回写 Flutter 的 `assets/covers/` 后，可把 APP 当前完整封面快照同步到 GitHub Pages 兼容路径 `covers/{category}/{recipeName}.webp`：

```bash
node scripts/covers/sync-app-covers.mjs --data-version 2026.07.28.1
```

该同步命令会逐一校验 367 张图片均为正方形 WebP，不会切换尚未完成的 V2 UUID 封面稳定通道。

全量完成后校验：

```bash
node scripts/covers/validate.mjs \
  --data-version 2026.07.28.1 \
  --cover-version 2026.07.29.1
```

审核完成后发布不可变封面版本并切换稳定通道：

```bash
node scripts/covers/publish.mjs \
  --data-version 2026.07.28.1 \
  --cover-version 2026.07.29.1 \
  --update-channel
```

发布结构：

```text
channels/v2-covers-stable.json
covers/2/{coverVersion}/
  manifest.json
  images/{category}/{recipeUuid}.webp
```

生成提示词使用菜谱名称、简介和可食用食材约束成品外观，并明确禁止把菜名中的成语、地名或神话词按字面画出来，也禁止厨具、文字、水印和标志。暂存区中的 `generation-plan.json` 保存每份菜谱的完整提示词、缺图优先级和当日额度状态，方便调用接口前审核。

## V1 旧转换方案（仅保留历史说明）

以下内容描述旧版根目录数据和交互式 `scripts/cli.js`。该脚本不再用于构建 V2。

本文档说明如何将 HowToCook 菜谱数据转换为 Flutter 应用可用的 JSON 格式，并部署到 GitHub 作为静态资源。

## 📋 方案概述

### 目标
1. 将 Markdown 格式的菜谱转换为结构化的 JSON 数据
2. 处理菜谱图片（支持 jpg/png/jpeg/gif/webp）
3. 转换烹饪知识文档（tips 目录）
4. 生成版本控制的索引文件
5. 部署到 GitHub 作为静态资源托管
6. 支持 Flutter 应用的增量更新

### 数据流程

```
Markdown 菜谱 + 图片
         ↓
   [scripts/converter-full.js]
         ↓
flutter_output/
  ├── recipes/ (JSON)
  ├── images/ (图片)
  ├── tips/ (烹饪知识)
  └── manifest.json (索引)
         ↓
   [scripts/deploy.sh]
         ↓
   GitHub 仓库
         ↓
   GitHub Pages
         ↓
   Flutter App
```

## 🛠️ 使用方法

### 方式一：使用 CLI 工具（推荐）

```bash
# 需要 Node.js 16.0.0+
node --version

# 克隆 HowToCook 仓库
git clone https://github.com/Anduin2017/HowToCook.git
cd HowToCook

# 运行 CLI 工具
node scripts/cli.js
```

然后根据交互式菜单选择需要的操作：

```
==================================================
   HowToCook 数据转换工具
==================================================

请选择操作：

  1. 完整数据转换
  2. 增量数据转换
  3. 图片格式转换 (转为 WebP)
  4. 清理原始图片
  5. 清理 Emoji
  6. 查找缺失菜谱
  7. 完整流程（推荐）
  0. 退出

请输入选项 (0-7):
```

### 方式二：直接运行单独脚本

```bash
# 完整数据转换
node scripts/converter-full.js

# 增量转换
node scripts/converter-incremental.js

# Emoji 清理
node scripts/fix-emoji.js

# 查找缺失菜谱
node scripts/find-missing-recipe.js
```

**输出结果：**
- `recipes/` - 327 个菜谱 JSON 文件（约 1.4MB）
- `images/` - 所有图片（约 92MB）
- `tips/` - 18 个烹饪知识 JSON 文件（约 124KB）
- `manifest.json` - 总索引文件（约 92KB）

### CLI 工具功能说明

#### 1. 完整数据转换
- 转换所有 Markdown 菜谱为 JSON 格式
- 处理烹饪知识文档
- 复制并组织图片资源
- 生成 manifest.json 索引文件
- **已修复**：支持识别列表项中的图片（如 `- ![图片](./path.jpg)`）

#### 2. 增量数据转换
- 检查现有数据，只更新有变化的内容
- 提高转换效率，适合频繁更新

#### 3. 清理 Emoji
- 自动扫描所有 JSON 文件
- 移除 Emoji 表情符号
- 更新文件哈希值
- 保持数据一致性

#### 4. 查找缺失菜谱
- 对比源 Markdown 文件和已转换的 JSON
- 列出所有未成功转换的菜谱
- 帮助排查转换问题

#### 5. 完整流程（推荐）
自动依次执行：
1. 完整数据转换
2. Emoji 清理

适合一键完成所有处理步骤。

### 3. 部署到 GitHub

#### 方式一：使用部署脚本（推荐）

```bash
# 设置 GitHub 仓库 URL
export GITHUB_REPO_URL=https://github.com/your-username/howtocook-data.git

# 运行部署脚本
bash scripts/deploy.sh
```

#### 方式二：手动部署

```bash
cd flutter_output

# 初始化 Git 仓库
git init
git add .
git commit -m "Initial commit"

# 推送到 GitHub
git remote add origin https://github.com/your-username/howtocook-data.git
git push -u origin master
```

### 4. 启用 GitHub Pages

1. 进入 GitHub 仓库设置
2. 找到 "Pages" 设置
3. 选择 `master` 或 `main` 分支作为源
4. 保存设置

访问地址：`https://your-username.github.io/howtocook-data/manifest.json`

## 📁 输出目录结构

```
flutter_output/
├── manifest.json                    # 总索引（版本、菜谱列表、哈希）
├── recipes/                         # 菜谱 JSON
│   ├── aquatic/                    # 水产（24个）
│   │   ├── aquatic_xxx.json
│   │   └── ...
│   ├── breakfast/                  # 早餐（22个）
│   ├── condiment/                  # 调料（9个）
│   ├── dessert/                    # 甜品（18个）
│   ├── drink/                      # 饮料（21个）
│   ├── meat_dish/                  # 荤菜（98个）
│   ├── semi-finished/              # 半成品（10个）
│   ├── soup/                       # 汤粥（21个）
│   ├── staple/                     # 主食（48个）
│   ├── template/                   # 模板（1个）
│   └── vegetable_dish/             # 素菜（55个）
├── images/                          # 图片资源
│   ├── aquatic/
│   ├── breakfast/
│   └── ...
└── tips/                            # 烹饪知识
    ├── learn/                      # 基础技法（11个）
    ├── advanced/                   # 进阶知识（4个）
    └── general/                    # 基础知识（3个）
```

## 📊 数据结构

### manifest.json

```json
{
  "version": "1.0.0",
  "generatedAt": "2025-10-09T17:46:53.590Z",
  "totalRecipes": 327,
  "totalTips": 18,
  "categories": {
    "aquatic": { "name": "水产", "count": 24 },
    "breakfast": { "name": "早餐", "count": 22 }
    // ...
  },
  "tipsCategories": {
    "learn": { "name": "基础技法", "count": 11 }
    // ...
  },
  "recipes": [
    {
      "id": "aquatic_xxx",
      "name": "小龙虾",
      "category": "aquatic",
      "categoryName": "水产",
      "difficulty": 4,
      "hash": "sha256...",
      "hasImages": true
    }
    // ...
  ],
  "tips": [
    {
      "id": "tips_learn_xxx",
      "title": "炒/煎",
      "category": "learn",
      "categoryName": "基础技法",
      "hash": "sha256..."
    }
    // ...
  ]
}
```

### 菜谱 JSON (recipes/category/recipe_id.json)

```json
{
  "id": "aquatic_8030d58d",
  "name": "小龙虾",
  "category": "aquatic",
  "categoryName": "水产",
  "difficulty": 4,
  "images": ["images/aquatic/aquatic_xxx.jpg"],
  "ingredients": [
    "小龙虾",
    "小龙虾 = 2 斤",
    "油 = 70 毫升"
  ],
  "tools": [],
  "steps": [
    "小龙虾刷干净去虾线",
    "烧油，油微热, 下香叶、八角"
  ],
  "tips": "饭店应该都是油炸一遍...",
  "warnings": [],
  "hash": "sha256..."
}
```

### 烹饪知识 JSON (tips/category/tips_id.json)

```json
{
  "id": "tips_learn_18a7f609",
  "title": "炒/煎",
  "category": "learn",
  "categoryName": "基础技法",
  "content": "",
  "sections": [
    {
      "title": "器具",
      "content": "可使用普通金属制..."
    },
    {
      "title": "流程",
      "content": "开火——直接将锅平放于火上..."
    }
  ],
  "hash": "sha256..."
}
```

## 🔄 Flutter 应用集成

### 数据加载策略

#### 1. 首次安装
- 将 `flutter_output/` 打包到应用 assets 中
- 应用首次启动时，从 assets 加载数据到本地存储

#### 2. 更新检测
```dart
// 1. 获取远程 manifest
final remoteManifest = await fetchRemoteManifest(
  'https://your-username.github.io/howtocook-data/manifest.json'
);

// 2. 对比本地版本
final localVersion = await getLocalVersion();
if (remoteManifest['version'] != localVersion) {
  // 有新版本
  await updateData(remoteManifest);
}

// 3. 增量更新：对比哈希值
for (var recipe in remoteManifest['recipes']) {
  final localHash = await getLocalRecipeHash(recipe['id']);
  if (localHash != recipe['hash']) {
    // 下载更新的菜谱
    await downloadRecipe(recipe['id']);
  }
}
```

#### 3. 数据存储
```dart
// 使用 SharedPreferences 存储元数据
final prefs = await SharedPreferences.getInstance();
await prefs.setString('data_version', manifest['version']);
await prefs.setString('data_updated_at', manifest['generatedAt']);

// 使用本地文件存储 JSON 数据
final directory = await getApplicationDocumentsDirectory();
final recipePath = '${directory.path}/recipes/${recipe.id}.json';
await File(recipePath).writeAsString(jsonEncode(recipe));

// 使用 sqflite 存储索引（可选，用于快速查询）
await db.insert('recipes', {
  'id': recipe.id,
  'name': recipe.name,
  'category': recipe.category,
  'difficulty': recipe.difficulty,
  'hasImages': recipe.hasImages ? 1 : 0,
});
```

### 示例代码

```dart
// data_service.dart
class DataService {
  static const String baseUrl =
    'https://your-username.github.io/howtocook-data';

  // 检查更新
  Future<bool> checkForUpdates() async {
    final response = await http.get(Uri.parse('$baseUrl/manifest.json'));
    final manifest = jsonDecode(response.body);

    final prefs = await SharedPreferences.getInstance();
    final localVersion = prefs.getString('data_version') ?? '0.0.0';

    return manifest['version'] != localVersion;
  }

  // 下载菜谱
  Future<Recipe> downloadRecipe(String recipeId) async {
    // 从 manifest 中找到菜谱的分类
    final category = await getCategoryForRecipe(recipeId);

    final response = await http.get(
      Uri.parse('$baseUrl/recipes/$category/$recipeId.json')
    );

    return Recipe.fromJson(jsonDecode(response.body));
  }

  // 下载图片
  Future<void> downloadImage(String imagePath) async {
    final response = await http.get(Uri.parse('$baseUrl/$imagePath'));

    final directory = await getApplicationDocumentsDirectory();
    final file = File('${directory.path}/$imagePath');
    await file.create(recursive: true);
    await file.writeAsBytes(response.bodyBytes);
  }

  // 获取本地菜谱
  Future<Recipe> getLocalRecipe(String recipeId) async {
    final directory = await getApplicationDocumentsDirectory();
    final category = await getCategoryForRecipe(recipeId);
    final file = File('${directory.path}/recipes/$category/$recipeId.json');

    if (await file.exists()) {
      final json = jsonDecode(await file.readAsString());
      return Recipe.fromJson(json);
    }

    // 如果本地不存在，尝试从网络下载
    return await downloadRecipe(recipeId);
  }
}
```

## 🎯 最佳实践

### 1. 资源优化
```bash
# 图片压缩（可选）
# 使用 imagemagick 或其他工具压缩图片
for img in flutter_output/images/**/*.{jpg,png}; do
  convert "$img" -quality 85 "$img"
done
```

### 2. CDN 加速
- 使用 jsDelivr CDN 加速 GitHub 资源
- 格式：`https://cdn.jsdelivr.net/gh/username/repo@master/path/to/file`

### 3. 版本管理
- 使用语义化版本号（Semantic Versioning）
- 重大更新：主版本号 + 1（1.0.0 → 2.0.0）
- 新增功能：次版本号 + 1（1.0.0 → 1.1.0）
- Bug 修复：修订号 + 1（1.0.0 → 1.0.1）

### 4. 更新策略
- **启动时检查**：应用启动时检查更新
- **后台更新**：在后台下载数据，不阻塞用户
- **智能更新**：只下载变化的内容（使用哈希对比）
- **缓存策略**：设置合理的缓存时间

## 📝 维护流程

### 定期更新数据

```bash
# 1. 更新 HowToCook 仓库
cd HowToCook
git pull origin master

# 2. 重新转换数据
node scripts/converter-full.js

# 3. 更新版本号（在 scripts/converter-full.js 中修改 CONFIG.version）

# 4. 部署到 GitHub
bash scripts/deploy.sh
```

### 自动化（GitHub Actions）

创建 `.github/workflows/update-data.yml`：

```yaml
name: Update Flutter Data

on:
  schedule:
    # 每天凌晨 2 点自动运行
    - cron: '0 2 * * *'
  workflow_dispatch:  # 手动触发

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout HowToCook
        uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '16'

      - name: Convert Data
        run: node scripts/converter-full.js

      - name: Deploy to GitHub Pages
        run: |
          cd flutter_output
          git init
          git add .
          git commit -m "Auto update: $(date)"
          git push -f https://x-access-token:${{ secrets.GITHUB_TOKEN }}@github.com/${{ github.repository }}.git master:gh-pages
```

## 🐛 故障排查

### 转换失败
```bash
# 检查 Node.js 版本
node --version  # 需要 >= 16.0.0

# 查看详细错误
node scripts/converter-full.js 2>&1 | tee conversion.log
```

### 推送失败
```bash
# 检查远程仓库配置
git remote -v

# 检查认证
git config --global user.name "Your Name"
git config --global user.email "your.email@example.com"
```

### GitHub Pages 无法访问
1. 检查仓库设置中的 Pages 配置
2. 确认分支选择正确
3. 等待几分钟让 GitHub 构建完成
4. 检查浏览器控制台的错误信息

## 📚 相关资源

- [HowToCook 原项目](https://github.com/Anduin2017/HowToCook)
- [GitHub Pages 文档](https://docs.github.com/en/pages)
- [Flutter 本地存储](https://docs.flutter.dev/cookbook/persistence)
- [jsDelivr CDN](https://www.jsdelivr.com/)

## 📄 许可证

本方案基于 [HowToCook](https://github.com/Anduin2017/HowToCook) 项目，遵循 MIT License。

---

*最后更新: 2025-10-09*
