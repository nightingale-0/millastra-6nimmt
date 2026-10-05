# Take 6 · 6 nimmt! for 千星奇域

把《6 nimmt!》（牛头王）做成 2–8 人的千星奇域多人小游戏：同时出牌、从小到大落位、收走整行、牛头最少者胜。

- **服务端**：一张权威节点图，用 [genshin-ts](https://github.com/josStorer/genshin-ts) 写在 `server-graph/`，注入关卡 `.gil`。
- **客户端**：一套 Lua 界面，`scripts/build.mjs` 生成客户端控件模板和脚本，导出成 `.gia`。
- **规则参考**：`lua/core.lua` 是纯 Lua 规则引擎，测试用它对照节点图的行为。

玩法：2–8 人（人数不够可加电脑），模式有单局、33 分、66 分；每轮 30 秒选牌，可托管、发表情、换音乐。发布文案和封面在 [outputs/publish/](outputs/publish/)。

## 开发

需要 Node.js 22+。

```sh
npm run setup   # 固定提交拉取本地模拟器到 work/（首次）
npm run build   # 生成 outputs/*.gia / *.save.json / *.scripts.json
npm test        # 规则 + 多客户端 + 界面回归
```

服务端节点图（只在关掉游戏和编辑器后注入）：

```sh
cd server-graph
npm install
echo '{ "playerId": <你的 UID>, "mapId": <关卡 mapId> }' > gsts.local.json   # 本地文件，不提交
npm run build                                       # 编译并注入关卡
```

导入、编号、踩坑等详见 [AGENTS.md](AGENTS.md)；协议与变量见 [docs/server-contract.md](docs/server-contract.md)；后续计划见 [docs/ROADMAP.md](docs/ROADMAP.md)。

## 许可与素材

本仓库不含官方游戏素材，也不含 6 nimmt! 的商业卡面；界面用的是编辑器内置图片库的编号。依赖 [miliastra-beyond-simulator](https://github.com/1475505/miliastra-beyond-simulator)（GPL-3.0），按固定提交下载到被忽略的 `work/`，未改动其源码。公开分发前请自行确认所用依赖和素材的许可。
