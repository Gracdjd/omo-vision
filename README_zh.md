# omo-vision

**[OhMyOpenCode (OMO)](https://github.com/code-yeongyu/oh-my-openagent) 专用零配置视觉桥接插件** —— 让纯文本模型也能处理粘贴的图片。

当前模型不支持图像输入时，omo-vision 自动：

1. **保存**粘贴的图片到系统临时目录（`…/omo-vision/image{N}/`，Linux 下即 `/tmp/omo-vision/`）
2. 在用户消息中**注入路径提示**（瞬态注入，不写入聊天历史）
3. **指导模型**调用 OMO 内置的 `look_at` 工具分析图片 —— 它会运行 `multimodal-looker` agent（视觉模型）并返回分析结果

```
用户粘贴图片 + "这是什么？"
  ↓
omo-vision 插件 (experimental.chat.messages.transform)
  ├─ base64 → /tmp/omo-vision/image1/<hash>.png
  └─ 追加提示: "[omo-vision: Image #1 … — analyze with look_at(file_path=…)]"
  ↓
纯文本模型读到提示 → 调用 look_at(file_path=…)
  ↓
look_at 运行 multimodal-looker（视觉模型）→ 分析结果返回主模型
```

原生视觉模型通过模型元数据自动识别，完全不受影响 —— 它们直接收到原始图片 part，永远看不到提示。

## 为什么需要它

- 粘贴的图片是消息里 **inline 的 base64 part，不在文件系统上** —— 纯文本模型"自己保存图片"在逻辑上不成立：它根本看不到这个 part（OpenCode 会标记为 unsupported part）。保存 + 注入必须在 prompt 到达模型之前由 hook 完成。
- OMO 官方支持的多模态路径就是 `look_at` 工具（[oh-my-openagent#2952](https://github.com/code-yeongyu/oh-my-openagent/issues/2952)）。走 `look_at` 还能绕开上游 OpenCode 的 subtask prompt 丢弃 file part 的 bug —— omo-vision 传递的是**文件路径**，视觉 agent 自己从磁盘读文件。
- 与 [opencode-vision](https://github.com/JochenYang/opencode-vision)（此 hook 模式的开创者，致谢）不同，omo-vision **不需要外部 VLM API key、不需要额外定义 agent**：直接复用 OMO 自带的能力。

## 安装

```bash
npx github:Gracdjd/omo-vision
```

手动安装：

```bash
git clone https://github.com/Gracdjd/omo-vision
cp omo-vision/plugins/omo-vision.ts ~/.config/opencode/plugins/
```

卸载：

```bash
npx github:Gracdjd/omo-vision --uninstall
```

安装后**重启 OpenCode** —— 插件在启动时加载。

## 验证

1. 切换到纯文本模型（如无视觉能力的 coding-plan 模型）
2. 粘贴一张图片并问"这是什么？"
3. 预期：模型调用 `look_at(file_path="/tmp/omo-vision/image1/<hash>.png")` 并基于返回的分析作答

## 配置（全部可选 —— 默认值即 OMO 配置）

| 环境变量 | 默认值 | 用途 |
|---|---|---|
| `OMO_VISION_TOOL` | `look_at` | 提示中推荐的分析工具 |
| `OMO_VISION_AGENT` | `multimodal-looker` | task 委派的兜底子代理 |
| `OMO_VISION_MAX_IMAGES` | `100` | 保存图片目录的 LRU 上限 |
| `OMO_VISION_DIR` | `<系统临时目录>/omo-vision` | 图片保存目录 |

### 原生 OpenCode（非 OMO）使用

把 agent/工具名指向你自己的配置：

```bash
export OMO_VISION_TOOL=read            # 或你自己的视觉工具
export OMO_VISION_AGENT=image-reader   # 任何配置了视觉模型的 subagent
```

## 行为说明

- 去重：相同内容（全量 base64 的 MD5）复用同一个临时文件
- LRU 淘汰：磁盘上最多保留 `OMO_VISION_MAX_IMAGES` 个图片目录
- 每次 transform 都会清理旧提示，会话中从纯文本模型切到视觉模型不会泄漏旧提示
- 跳过压缩/摘要消息
- 写盘失败降级为跳过 —— 保存失败不会中断对话轮次

## 开发

```bash
git clone https://github.com/Gracdjd/omo-vision
cd omo-vision
bun test        # 17 个单元/集成测试
```

插件源码单文件：[`plugins/omo-vision.ts`](plugins/omo-vision.ts)。**只导出 `default`** —— OpenCode 加载器会把命名导出当 hook 调用，所以辅助函数保持模块私有。测试直接驱动 hooks 并对文件系统断言。

## 许可

[MIT](LICENSE) —— 机制参考自 [@jochenyang/opencode-vision](https://github.com/JochenYang/opencode-vision)（MIT）。
