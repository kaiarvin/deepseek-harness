# Agent Note：ThinkingSelect —— 模型芯片旁的快捷三档思考级别下拉

Status: implemented

[English](2026-08-16-thinking-level-select.md) | 中文

## 问题

模型菜单其实已经能调推理强度，但要多钻一层菜单，且每个级别显示的是适配器提供的原始名称（Off / High / Max）。用户想要的是 composer 里模型选择器旁边一个一键可调的思考强度控件，且只有三个固定的中文档位——关闭 / 高 / 最高——对应 DeepSeek 的思考级别。

## 决策

在 `ui-model-selection` 的 composer 座席内做一个纯客户端的快捷下拉（`ThinkingSelect`），紧挨现有模型触发器渲染：

- **档位**：DeepSeek 三档思考级别按升序——`off` → 关闭、`high` → 高、`max` → 最高——使用插件 `model` 命名空间里固定的本地化文案（`thinking.off/high/max`）。控件只显示当前模型真正提供的档位（例如部署被锁定为不思考时只显示「关闭」，不支持推理或档位词汇不同的模型则完全不显示）。
- **模型芯片只负责选模型**：原有的两级 Model/Effort 菜单已移除——打开座席直接展开按提供方分组的模型列表，触发器只显示模型名。思考芯片是 composer 里唯一的推理强度面板，两个控件不会再重复或打架。
- **提交**：选档位与点模型芯片一样，是一次模型选择——经由同一个会话级共享 `ModelDirectory` 调用 `session.selectModel` 并携带 `reasoningEffort`，宿主随模型选择一并持久化，agent loop 会在后续每次 LLM 请求中带上它。宿主与 LLM 包零改动：整条线缆契约（`ModelSelection.reasoningEffort`、请求头 config、`llm-deepseek` 的 `thinking`/`reasoning_effort` 序列化）本就存在。
- **状态与文案**：触发器显示生效档位（选择 ?? 适配器默认值），菜单复用座席现有的 chip/menu/option 样式，失败走座席既有的瞬时 toast，`locked`（无会话／已移除）与模型芯片同策略禁用触发器。下拉内嵌在模型座席里，因此自动继承座席的 slot 注册、locale seat 与会话作用域，无需新增任何管道。

## 备选方案

**扩展现有模型菜单里的推理强度面板。** 否决：用户要的是模型选择器旁的一个控件，而不是再钻一层菜单；而且该面板显示适配器原始名称并带有「provider default」行，是固定三档刻意去掉的。待思考芯片成为唯一推理强度面板后，该面板被整体移除。

**新增一个 `conversation.input.*` composer slot。** 否决：为一个芯片重复座席的会话级目录、block 策略与 locale 接线得不偿失；内嵌在模型座席里保持一份状态、一条提交路径、一个锁定策略。

## 影响

DeepSeek 用户可在模型芯片旁一键切换思考强度；该选择随模型选择按会话持久化，并在下一次请求到达 provider。模型菜单不再重复这一面板。新增覆盖：`model-select.client.spec.tsx`（固定三档菜单、提供档位子集、隐藏状态、锁定、Escape 关闭、拒绝 toast；模型列表直接展开、无推理强度面板）。无需宿主改动；该功能是纯客户端对既有选择契约的组装。
