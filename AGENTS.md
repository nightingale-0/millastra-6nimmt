# AGENTS.md

给在本仓库里干活的人和 AI。保持简短，细节看 [docs/server-contract.md](docs/server-contract.md)。

## 约定

- 回复和文档用中文。
- 不提交个人信息：UID、昵称、本机路径、截图和录屏都不进仓库（`server-graph/gsts.local.json`、`.claude/`、`outputs/*` 已被忽略）。
- 改 `server-graph/src/main.ts` 后**不要自己注入**，等用户说「注入」；注入只在游戏和编辑器都关闭时做。
- 先 `npm test`，再谈真机。

## 目录

- `lua/core.lua` 规则真值；`lua/client.lua` 客户端界面；`lua/wire.lua` 仅测试宿主使用。
- `scripts/build.mjs` 生成界面（控件坐标全在这里）和 `outputs/*`；`scripts/lua-vm.mjs` 是测试用的服务端参考宿主。
- `server-graph/src/main.ts` 权威节点图。
- `outputs/publish/` 发布文案和封面；其余 `outputs/` 是构建产物。

## 部署流程（界面）

1. `node scripts/build.mjs`，它会把 gia 复制到 `…/BeyondLocal/Beyond_Local_Export/`（编辑器从这里导入）。
2. 用户在编辑器导入，并告诉你新的 NimmtRoot ID 和 main_N / boot_N 编号。
3. 把 `scripts/build.mjs` 的 `TEMPLATE_ID` 改成新 ID，重新构建，把 `outputs/sixnimmt-network.scripts.json` 里的 `six/main`、`six/boot` 源码（带 BOM）写进映射目录里最新的 `main_N.lua` / `boot_N.lua`。
4. 每次导入模板 ID 都会变，不要留旧 ID 当兜底。

## 节点图预算

- genshin-ts 把每个 `gstsServer*` 函数在**每个调用点各展开一份**：重逻辑只留一个调用点。
- 编辑器统计的节点数约为编译结果（`dist/src/main.json`）的 2.1 倍，上限 3000，所以编译结果要小于约 1400。
- 一次执行负载上限约 4400，超了会静默中止并让定时器停摆：每个 tick 只做一件重活；列表型自定义变量最多 100 项。

## 客户端踩过的坑

- 客户端脚本没有 `require`：`six/main` 自带模块垫片，内联 `core.lua`。
- 同级控件的层叠顺序和模拟器可能相反：构建时输出 `LAYERS`，启动时用 `SetAsFirstSibling` 显式排序。
- 文字只能贴框顶，框矮了整行不显示：用 `textBox()` 按顶部定位。图片只指定高度，保持等比。
- 大的 `cursor` 组会吞掉点击：大面板用普通矩形。
- GIA 写不进旋转：要倾斜的控件在 Lua 里设 `localRotationZ`。
- 游戏自带的退出、聊天（手机上还有听筒、麦克风）在我们界面**下面**，所以用外观相同的装饰牌盖住，点击会穿透。想让它们浮在上面，只能在编辑器里调（控件组「层级」最小是 0；切到时序渲染模式会让界面整个消失）。
- 背景比 1280×720 大三倍，避免宽屏露出场景。
- 结算：服务端每 90 秒、以及一局结束时，给场上所有人标 Victory，离开时各自结算。
- 表情和「已出牌」标记走独立的 `nimmt_emo`，不要塞回慢速的整桌发布。
