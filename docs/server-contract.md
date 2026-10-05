# 服务端接入契约

`server-graph/src/main.ts` 是权威节点图，`lua/core.lua` 是规则真值参考，`scripts/lua-vm.mjs` 是测试宿主。这里只记协议和限制。

## 拓扑

```text
客户端 Lua ──信号 NimmtAct──→ 服务端节点图：核对席位密钥 → 校验 → 状态机
                                      ↓ 发布
        关卡实体自定义变量（公共） + 各玩家实体自定义变量（本人私有）
                                      ↓
客户端 Lua ← RegisterCustomVariableChangedHandler / game.GetGlobalCustomVariableValue
```

- 信号只用来传意图：`NimmtSync`（无参数，请求重发）和 `NimmtAct`。
- 服务端的发送信号是全局广播，做不到定向，所以状态只走自定义变量。别人的手牌只写进本人玩家实体的 `nimmt_me`。
- `evt.signalSourceEntity` 认不出客户端玩家，所以不靠它识别座位：开局时给每个真人生成随机密钥，写进他自己的 `nimmt_me`，客户端每次发信号带上座位号和密钥，服务端核对。

## NimmtAct(seat, key, kind, token, value)

| kind | 含义 | value |
|---|---|---|
| 1 | 出牌 | 牌号（token 必须是当前轮的） |
| 2 | 收走某一行 | 1–4 |
| 3 | 结算页投票 | 1 = 再来一局 |
| 4 | 大厅准备 | 1 |
| 5 | 大厅设置（仅 1 号位） | 10×电脑数 + 100×模式 |
| 6 | 托管 | 1 开 / 0 关 |
| 7 | 背景音乐（只对发送者） | 音乐编号，0 = 暂停 |
| 8 | 表情 | 1–8 |

模式：0 单局、1 66 分、2 33 分。

## 自定义变量

| 实体 | 变量 | 类型 | 内容 |
|---|---|---|---|
| 关卡 | `nimmt_pub` | 整数列表 96 | 见下 |
| 关卡 | `nimmt_text` | 字符串列表 14 | phase, mode, endReason, 事件×3, 8 个座位的昵称 |
| 关卡 | `nimmt_rev` | 整数 | 每次发布最后写入，客户端监听它 |
| 关卡 | `nimmt_emo` | 整数列表 16 | [0–7] 每个座位的 序号×10+表情；[8–15] 每个座位已出牌的那一轮的 token。随事件**立即**写，不经过整桌发布 |
| 玩家 | `nimmt_me` | 整数列表 13 | seat, hand1..10（0 = 空）, key, 已锁定的牌 |

`nimmt_pub`（0 起始，须与 `PUB_*`、`lua/client.lua` 的 `viewFromVars()`、测试的 `publish()` 一致）：

```text
0 n  1 handNo  2 round  3 token  4 revision  5 cursor  6 waiting  7 humans
8 应到人数  9 保留  10 剩余秒数  11 设置(电脑数 + 10×模式)
12–31 rows（第 r 行第 j 张在 12+(r-1)*5+(j-1)）  32–39 scores  40–47 counts
48–55 ready  56–63 bot(0 真人 / 1 电脑 / 2 真人离开由电脑代打 / 3 托管)
64–71 voted  72–79 queueCard  80–87 queuePlayer  88–95 保留
```

选牌阶段 queue 全为 0，不泄露已出的牌号。

## 节奏

- `TICK_MS = 300`，一个定时器调度全部：在场检测、发牌、自动出牌、逐座位亮牌、结算推进、手末停顿（约 6 秒）、发布。
- 选牌 107 个 tick（约 32 秒）；客户端显示 30 秒，多出的 2 秒是网络缓冲。结算页投票 30 秒，过半数「再来一局」回大厅，否则统一结算。
- 开局前，服务端比较 `queryGameModeAndPlayerNumber().playerCount` 和已入场人数，等人到齐（有超时）才允许准备。
- 逃跑：每个 tick 对比在场玩家，离开的座位标 bot=2 由电脑代打，回来后收回。

## 限制（真机实测）

- 编辑器节点数 ≈ 编译结果的 2.1 倍，上限 3000；每个 `gstsServer*` 函数在每个调用点各展开一份，所以重逻辑只留一个调用点。
- 单次执行负载上限约 4400，超了会静默中止且定时器停摆。发布因此拆成多个 tick：表头 + 行 → 座位 / 队列 → 每 tick 一个玩家的手牌 → `nimmt_rev`。
- 列表类型自定义变量最多 100 项；循环边界不要读正在被修改的列表长度。
- 服务端资源与界面分开算：整套界面是**客户端控件模板**（根节点 `NimmtRoot`），服务端控件组里只有空的 `NimmtHost` 和启动脚本 `six/boot`，由它 `game.InstantiateClientUIControl(模板 ID, script.object)` 实例化。模板 ID 每次导入都会变。
- 结算：关卡里要把排名比较顺序设成越小越靠前（罚分越低越好）；服务端每 90 秒以及一局结束时给所有人标 Victory。

## 需要在编辑器里手工做的

- 关卡实体的自定义变量：`nimmt_pub`、`nimmt_text`、`nimmt_rev`、`nimmt_emo`；玩家实体：`nimmt_me`。
- 信号：`NimmtSync`、`NimmtAct`。
- 导入 gia 后记下新的 NimmtRoot ID 和脚本编号，见 [AGENTS.md](../AGENTS.md)。
