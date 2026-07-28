# HowToCook Data V2

## 目标

V2 解决四类问题：

1. 上游 Markdown 新增简介、卡路里、有序步骤和 GFM 表格后，旧正则转换器会丢数据。
2. 菜谱 ID 依赖源路径，文件移动会破坏收藏、笔记和用户修改记录。
3. 根目录原地更新会让旧 App 误读新结构，也可能受到 CDN 缓存混合版本影响。
4. 旧转换器在现有目录中覆盖，删除或移动菜谱时会残留旧文件。

## 数据保留策略

每份菜谱同时保留上游原貌和结构化投影：

| 上游板块 | 原始字段 | 结构化字段 |
|---|---|---|
| 必备原料和工具 | `requirementsMarkdown` | `requirements`、`tools` |
| 计算 | `calculationMarkdown` | `ingredients`、`calculationNotes` |
| 操作 | `operationMarkdown` | `steps` |
| 附加内容 | `additionalMarkdown` | `tips`、`warnings` |

`ingredients` 以“计算”板块为主要来源，因此水、盐等未列入“必备原料和工具”但出现在用量计算中的材料不会丢失。无法可靠结构化的内容仍保存在原始 Markdown 字段中。

上游多数菜谱没有明确区分原料和工具，因此 `requirements` 是权威字段。只有位于明确工具子标题下的条目才会标记为 `kind: "tool"` 并进入 `tools`；其余无法确定的条目标记为 `kind: "unknown"`，转换器不会用关键词制造虚假的确定分类。

操作板块的 Markdown 原序号保留在 `operationMarkdown`；结构化 `steps` 会移除最外层 `1. 2. 3.`，防止 Flutter 再次编号。

JSON Schema 位于：

- `schema/recipe-v2.schema.json`
- `schema/manifest-v2.schema.json`
- `schema/recipe-id-migration-v1.schema.json`

## ID 注册表

V2 菜谱 ID 使用 UUID v4，但 UUID 只在菜谱首次登记时生成一次，之后由 `data/recipe-id-registry.json` 永久保存。

规则：

- 路径移动、正文变化不更换 UUID。
- 已发布 UUID 永不复用。
- 删除菜谱必须先把注册表条目标记为 `retired`，ID 同时加入 `retiredIds`。
- 同分类重名、分类变化、无法匹配的路径变化都会让构建失败，要求人工确认。
- `data/recipe-exclusions.json` 记录明确排除的上游重复文件。

V1 到 V2 的映射位于：

```text
migrations/recipe-id-v1-to-v2.json
versions/2/{dataVersion}/migrations/recipe-id-v1-to-v2.json
```

Flutter 应在切换到 V2 前使用该映射迁移收藏、笔记、用户修改记录及相关缓存键。

## 版本和发布

目录布局：

```text
channels/
  v2-stable.json
versions/
  2/
    2026.07.28.1/
      manifest.json
      validation-report.json
      recipes/
      images/
      tips/
      migrations/
```

发布顺序：

1. 固定并记录 `origin` 的源提交。
2. 在干净目标版本目录全量构建。
3. 执行单元测试和全量校验。
4. 检查 Git diff 和 ID 变化报告。
5. 提交完整版本目录。
6. 最后更新 `channels/v2-stable.json`。

构建器默认拒绝覆盖已存在的版本目录。`--rebuild` 仅用于首次发布前验证相同输入能产生相同输出；版本一旦推送，后续修正必须提升 `dataVersion`。

GitHub Pages 当前从 `main` 托管，嵌套的 V2 文件会自动发布，不需要修改 Pages 设置。

## 校验门禁

`scripts/v2/validate.mjs` 会检查：

- UUID、旧 ID 映射和同分类重名；
- 简介、卡路里、难度、必备条目、计算食材和操作步骤；
- 结构化步骤不含源序号；
- JSON 与 manifest hash；
- 教程内部链接；
- 图片引用、WebP 格式和实际可解码性；
- 输出目录不存在未引用的残留图片；
- 《戚风蛋糕》等表格配方未丢失。

## 图片

V2 只转换上游正文实际引用的详情图，并统一生成 WebP。封面图不属于本轮 V2 构建；后续可根据菜谱简介重新生成并作为独立资源版本发布。
