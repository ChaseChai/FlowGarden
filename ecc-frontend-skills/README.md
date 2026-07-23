# ECC 前端技能包 (ecc-frontend-skills)

来自 [affaan-m/ECC](https://github.com/affaan-m/ECC)（everything-claude-code）仓库的前端相关技能合集，打包为 Qoder 原生插件。

## 包含的技能（11 个）

| 技能 | 用途 |
|------|------|
| `frontend-design-direction` | 为生产级 UI 设定明确的设计方向与审美判断 |
| `frontend-patterns` | React/Next.js 工程模式、状态管理、性能优化 |
| `frontend-a11y` | 无障碍：语义 HTML、ARIA、键盘导航、焦点管理 |
| `frontend-slides` | 从零或从 PPTX 生成富动画的 HTML 演示文稿 |
| `design-system` | 生成/审计设计系统，检查视觉一致性 |
| `liquid-glass-design` | iOS 26 液态玻璃设计体系（模糊/反射/交互变形） |
| `make-interfaces-feel-better` | 界面手感打磨：间距、字体、阴影、命中区、交互态 |
| `motion-foundations` | 动效基础层：token、弹簧预设、性能与无障碍规则 |
| `motion-patterns` | 常用动效模式：按钮/弹窗/toast/stagger/页面过渡 |
| `motion-ui` | React/Next.js 生产级 UI 动效系统 |
| `motion-advanced` | 高级动效：拖拽、手势、文字动画、SVG 路径绘制 |

## 来源与出处

- 源仓库：https://github.com/affaan-m/ECC （main 分支，通过 git sparse-checkout 获取）
- 各 `SKILL.md` 与其同目录支持文件按原样复制，未改写工作流、触发条件与约束。
- Logo：本插件自绘的花园渐变 SVG（非源仓库素材）。

## 支持文件

- `skills/frontend-slides/`：`STYLE_PRESETS.md`、`animation-patterns.md`、`html-template.md`、`viewport-base.css`、`scripts/export-pdf.sh`、`scripts/extract-pptx.py`
- 其余 10 个技能均为单文件 `SKILL.md`，源目录无附加支持文件。

## 省略说明

- 未包含源仓库中的非前端技能（共 278 个技能，仅按用户选择打包前端相关 11 个）。
- `frontend-slides/scripts/export-pdf.sh` 为 bash 脚本，Windows 下需 Git Bash/WSL 运行。
- `liquid-glass-design` 面向 SwiftUI/UIKit，Web 项目仅可借鉴其玻璃材质设计原则。

## 使用说明

将本目录复制到 Qoder 插件目录后即可被技能系统发现；技能按各自 `SKILL.md` 中 `description` 描述的场景自动或手动触发。

## 验证

- 已通过 create-plugin 附带的离线校验脚本 `validate_qoder_plugin.py`（结果见交付说明）。
