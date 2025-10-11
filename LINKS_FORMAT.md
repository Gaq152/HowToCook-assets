# 链接格式说明

在转换过程中，Markdown 链接会被转换为 Flutter 应用可识别的格式。

## 转换规则

### 1. Tips 文档链接

**原始格式（Markdown）：**
```markdown
[学习炒与煎](../../tips/learn/学习炒与煎.md)
```

**转换后（JSON）：**
```json
"[学习炒与煎](tips://learn/tips_learn_8cedf993)"
```

**协议说明：**
- `tips://` - 协议标识，表示这是一个指向 tips 文档的链接
- `learn/` - tips 分类（learn, advanced, general 等）
- `tips_learn_8cedf993` - tips 的实际 ID（从文档标题生成的唯一标识符）

**重要：** 链接中使用的是实际的 tips ID，而不是文件名。这样即使文件名改变，链接依然有效。

### 2. 其他相对路径链接

**原始格式：**
```markdown
[某个菜谱](../meat_dish/红烧肉.md)
```

**转换后：**
```json
"【某个菜谱】"
```

保留文本内容，但移除路径（因为跨菜谱引用较少）。

### 3. 外部链接

**原始格式：**
```markdown
[GitHub](https://github.com)
```

**转换后：**
```json
"[GitHub](https://github.com)"
```

保持不变，由 Flutter 应用决定如何处理外部链接。

## Flutter 应用处理建议

### 解析 tips:// 链接

```dart
String parseStepText(String text) {
  // 匹配 tips:// 链接格式：tips://category/tipsId
  final tipsRegex = RegExp(r'\[([^\]]+)\]\(tips://([^/]+)/([^)]+)\)');

  return text.replaceAllMapped(tipsRegex, (match) {
    final linkText = match.group(1);
    final category = match.group(2);
    final tipsId = match.group(3);

    // 渲染为可点击的链接
    return '<link category="$category" tipsId="$tipsId">$linkText</link>';
  });
}
```

### 跳转到 Tips 文档

```dart
void onTipsLinkTap(String category, String tipsId) {
  // 直接使用 tipsId 跳转，无需从 manifest 查找
  // 因为链接中已经包含了完整的 tipsId

  Navigator.push(
    context,
    MaterialPageRoute(
      builder: (context) => TipsDetailPage(
        category: category,
        tipsId: tipsId,
      ),
    ),
  );
}

// 或者如果需要验证 tips 是否存在
void onTipsLinkTapWithValidation(String category, String tipsId) {
  final tip = manifest.tips.firstWhere(
    (t) => t.id == tipsId,
    orElse: () => null,
  );

  if (tip != null) {
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (context) => TipsDetailPage(tipsId: tip.id),
      ),
    );
  } else {
    // 提示用户找不到对应的 tips
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('提示'),
        content: Text('找不到对应的烹饪知识'),
      ),
    );
  }
}
```

## 示例

### 原始 Markdown

```markdown
## 操作

- 将鱼放进盆里，然后将大姜切片
- 如果不明白为何要这样做，请查看[学习炒与煎](../../tips/learn/学习炒与煎.md)中的翻炒辅料。
- 加入调料，翻炒均匀
```

### 转换后的 JSON

```json
{
  "steps": [
    "将鱼放进盆里，然后将大姜切片",
    "如果不明白为何要这样做，请查看[学习炒与煎](tips://learn/tips_learn_8cedf993)中的翻炒辅料。",
    "加入调料，翻炒均匀"
  ]
}
```

### Flutter 渲染效果

```
步骤 2: 如果不明白为何要这样做，请查看 [学习炒与煎] 中的翻炒辅料。
                                      ↑ 蓝色可点击链接
```

点击链接后直接跳转到 ID 为 `tips_learn_8cedf993` 的 tips 文档（学习炒与煎）。

## 注意事项

1. **链接文本保留**：链接的显示文本会完整保留，方便阅读
2. **使用真实 ID**：链接中包含的是 tips 的实际 ID，而不是文件名，更加稳定可靠
3. **路径转换**：相对路径被转换为 `tips://category/tipsId` 格式，便于识别和处理
4. **向后兼容**：如果应用不支持链接，也能以纯文本形式显示
5. **统一格式**：所有内部链接统一使用 `tips://` 协议
6. **自动映射**：转换过程中会自动构建文件名到 ID 的映射，无需手动维护
