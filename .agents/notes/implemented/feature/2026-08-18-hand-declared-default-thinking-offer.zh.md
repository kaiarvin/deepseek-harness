# Agent Note: Hand-declared models default to the off / high / max thinking offer

Status: implemented

[English](2026-08-18-hand-declared-default-thinking-offer.md) | 中文

## Problem

手工声明的 pi-ai 模型——即已安装 catalog 未描述、也就是通过 Web「模型」页「添加自定义提供方」卡片加入的每一个模型——除非其条目声明了 `reasoningEfforts`，否则都会被物化为 `reasoning: false`（[按模型推理声明](../feature/2026-08-08-pi-ai-per-model-reasoning-declarations.md)）。作曲器的思考档位选择器只渲染当前模型推理元数据实际提供的档位，因此自定义模型完全不显示思考控件，而 shipped 的 DeepSeek catalog 模型则提供 关闭 / 高 / 最高。部署以自定义网关为主的用户没有任何办法为它们挑选思考强度，而且修复并不可发现：需要手改 `settings.yaml`，给每个模型补一个 `reasoningEfforts` 块——该字段没有任何配置界面可编辑。

## Decision

条目未声明 `reasoningEfforts` 的手工声明模型，现在默认获得与 shipped DeepSeek catalog 模型相同的 off / high / max 三档，而不是「不推理」。当条目未声明且已安装 catalog 没有同 id 条目时，`packages/llm/llm-pi-ai/src/catalog.ts` 的 `resolveModelReasoning` 返回 `reasoning: true` 并携带 DeepSeek 同款映射 `{ minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: 'max' }`（每个模型一份新拷贝）。`off` 保持缺席于映射——受支持、什么也不发送——其余档位与声明一样固定为 `null`，因此 `getSupportedThinkingLevels` 报告 `['off', 'high', 'max']`，作曲器的思考选择器会以固定的三个档位出现在每个自定义模型旁。

wire 行为沿用既有分派：pi-ai 的 OpenAI 风格 `reasoning_effort` 路径会原样发送 `high` / `max`，对 `off` 则省略该参数；其余协议通过各自的分派映射该档位（anthropic 的 budget/adaptive thinking、google 的 level/budget 等）。选中某个档位会与模型选择一同经同一条 `session.selectModel` 路径记录，agent loop 会把该选择并入每一次请求。

catalog 模型不受影响：条目点名 catalog id 而未声明 `reasoningEfforts` 时仍继承该条目的能力（pi-ai 标记为不推理的 catalog 模型保持不推理），`reasoningEfforts: false` 仍声明不推理模型，声明的 dict 仍优先于默认。变更只落在 `base === undefined` 分支，因此之后新建的每一个自定义模型都会自动获得该档位；没有任何按路由或按模型的开关需要记住。

## Alternatives considered

- **只在描述层报告档位**（`resolveModelInfo` 返回 `off`/`high`/`max`，而物化模型仍为 `reasoning: false`）。否决：请求路径会按模型真实能力校验档位，任何选中的档位都会在网络 I/O 前以 `UNSUPPORTED_REASONING_EFFORT` 被拒绝——一个显示了却发不出去的档位选择器，正是旧的「不提供它无法兑现的控件」姿态要防止的误示。
- **只在 `openai-completions` 协议默认**。否决：档位映射与协议无关——各 pi-ai 分派都通过自己的 wire 形状映射档位——手工声明的 anthropic 或 responses 模型同样受益于此选择器。默认映射拼写的恰好是选择器显示的三个档位，因此没有协议会宣称一个它无法分派的档位。
- **让 Models 页为每个模型写入默认 `reasoningEfforts` 块**。否决：让配置界面写入解析层本来就能默认的东西会制造第二事实源，而且经其他途径创建的模型（手改 `settings.yaml`、组合 patch）依然没有该档位。
- **维持旧姿态并文档化 `reasoningEfforts` 逃生口**。否决：这留下报告的问题——用户可见能力对每个自定义模型缺席——未解决，且该字段依然没有界面可编辑。

## Consequences

- 每个手工声明模型——现有的与将来的——都在作曲器提供 关闭 / 高 / 最高，且每个档位都真正到达 wire。自定义网关用户获得与 shipped DeepSeek 模型相同的思考控件。
- `reasoningEfforts: false` 仍是「网关吃不下该参数的模型」的拼写，声明的 dict 仍按模型塑形档位。
- 拒绝 `reasoning_effort` 参数的自定义端点会在请求处响亮失败（提供方报错），而不是被隐藏；profile 的 `compat.supportsReasoningEffort: false` 仍是这类端点的运维逃生口，配置了路由级 `reasoning` 默认的部署仍以它优先。
- 选择器的固定三档是 DeepSeek 词汇（[思考档位选择](../feature/2026-08-16-thinking-level-select.md)）；自带不同原生档位词汇的手工声明模型仍通过声明 `reasoningEfforts` 改名 wire 拼写。
