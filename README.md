# dsh-quote-shot

**按 id 引用整条消息**：点助手消息下方的引号图标，输入框里只多一行
`[引用消息 <id>——请先调用 quote_read 读取全文，再回答]`，
模型按需调 `quote_read` 读全文——**不把几百字塞进 prompt**。

和官方内置的「选中文字 → `> ` blockquote」是两条不同的路：

| | 官方 `dsh-message-quotes` | 本插件 |
|---|---|---|
| 触发 | 必须先选中文字 | 一键引用整条 |
| 内容 | **全文写进输入框** | **只传一行 id** |
| 模型知道出处 | ❌ 只看到一段文本 | ✅ 知道是哪条消息 |
| context 成本 | 全文（几百~几千 token） | **25 字符** |

两者注册点不同，**可以共存**：引一句用官方，引整条用本插件。

## 安装

```sh
git clone https://github.com/Twelve212/dsh-quote-shot.git
cd dsh-quote-shot
node install.mjs          # 链接进 profile 并写入 dsh.profile.bundles
```

`install.mjs` 通过 `DSH_HOME`（默认 `~/.dsh`）和 `DSH_PROFILE`（默认 `desktop`）
定位 profile，不写死路径。

装完**重启 DSH**。回滚：`node install.mjs --uninstall`。

**要求**：DSH `>= 0.2.1-rc.1`，Node `>= 20`。

---

## 引用：怎么用

1. 在助手消息下方点引号图标
2. 输入框上方出现一张 **引用卡片**（一行预览 + ×）
3. 正常写问题并发送 —— **卡片随后自动收起**

**两种粒度**：先选中一段文字再点 → 只引用那段；直接点 → 引用整条消息。

**取消**：点卡片右侧的 × 只移除卡片。**注入发生在点击那一刻，撤不回**（DSH 会话是 append-only）。详见「已知边界」。

---

## 实现

### 链路

```
点图标 → 读消息正文（DOM）
       → POST /quote-shot/inject { sessionId, text }
       → Host: ctx.agents.get(sessionId).inject({ role:'user', content, source:{form:'notice', summary} })
       → 注入一条折叠的上下文行（UI 显示 summary，模型读 content）
       → 前端添加卡片；发送后清空
```

`source.summary` 是卡片上那行预览，`content.text` 才是模型读到的全文 —— 两者分离，输入框全程干净。

### 三个必须知道的实现细节

**1. 消息正文是「动作栏最外层祖先的前兄弟」，不是最近的那个**

实测 DOM 结构：

```
button
└ span
  └ span            prev = button
    └ div           prev = button
      └ div.actions prev = div(10 字，不够长)
        └ div.root  prev = null
          └ div     prev = null
            └ div.flowItem   ★ prev = div.flowItem(897 字) ← 正文在这
```

- **深度要到 7**（原来写 6，永远够不到）
- **必须取最外层候选**，不能「第一个够长的就返回」—— 消息里夹带文件路径/代码片段这类小容器时，会在浅层先命中（实测抓到过 87 字符的路径而不是 897 字符的正文）

**2. `sessionId` 有两种形态**

registry 的 key 是 `session-<uuid>`，客户端 slot 给的是裸 `<uuid>`。Host 端做了双向兼容（先原样查，再补/去 `session-` 前缀）。

**3. 发送完成信号 = 输入框从「有字」变「空」**

`useInput` 的 published state **没有 `phase` 字段**（它藏在 composer 内部的 snapshot 里），所以拿不到"提交中"状态。改用 400ms 轮询输入框长度：
`上次 > 0 且 这次 == 0` → 认为发送完成 → 清卡片。

**边界**：引用后一个字都不打直接发送，检测不到（输入框一直是空的）。

---

## 九个坑（都踩过，别再踩）

### 外部插件注册工具的三个专属坑

写外部插件（`~/.dsh/profiles/*/plugins/`）时，下面三条**第一次写工具的人必踩**，而且都**不会报错给你看**：

| # | 坑 | 后果 | 教训 |
|---|---|---|---|
| 7 | `import { defineTool } from '@deepseek-ai/dsh-tools'` | **整个插件不加载**：路由 404、UI 全消失 | 该包在 `app.asar` 里，外部插件 `ERR_MODULE_NOT_FOUND`。**手写 tool 对象，别 import** |
| 8 | 工具注册失败时 `throw error` | 小失败放大成插件崩溃 | `ctx.effect` 里**绝不重抛**：`catch → trace + return () => {}` |
| 9 | `output.render` 返回字符串 | 调用时 `content.some is not a function` | `render` 必须返回**内容分片数组** `[{ type:'text', text }]` |

**手写 tool 对象的完整形态**（`defineTool` 只是包装器，`register` 直接吃这个）：

```js
ctx.tools.register({
  name, description,
  parameters: { type:'object', additionalProperties:false, properties:{...}, required:[...] },
  output: {
    schema: { type:'object', additionalProperties:false, properties:{...}, required:[...] },
    render(args, value) { return [{ type:'text', text: '...' }] }   // ← 必须是数组
  },
  async execute(args) { /* return 一个符合 schema 的对象 */ }
})
```

### 引用功能本身的六个坑

| # | 坑 | 后果 | 教训 |
|---|---|---|---|
| 1 | 从 `inject` 里删掉 `agents` | 每次引用 409，功能全废 | **Cordis 的 `inject` 是服务访问的唯一开关**，删了不报错只静默失效 |
| 2 | 用裸 uuid 查 registry | 永远 `agent-unavailable` | registry key 带 `session-` 前缀，先看 `available` 再写代码 |
| 3 | 前端失败静默 `return` | 「点了没反应」，无从排查 | **每个提前 return 的分支都要上报 + UI 反馈** |
| 4 | DOM 提取深度只到 6 | 找不到正文 | 没看过真实 DOM 就别猜深度 |
| 5 | 「第一个够长就返回」 | 抓到路径碎片（87 字） | 取**最外层**候选，不是最近的 |
| 6 | 用 `useInput` 的 `phase` 判断发送 | 那个字段不存在 | **未验证的 API 假设 = 建在沙子上** |

### 贯穿全局的一条

**先埋可观测性再交付。** 这次连续失灵四轮、每次都要用户重启，根因不是难，是**故障不可见**。现在的形态：

- Host 每条请求、每个拒绝分支写一行到 `~/.dsh/logs/quote-shot.log`
- 409 时一并返回 `available: [...]`（实际可用值，省一轮诊断）
- 前端每个失败分支 POST 到 `/quote-shot/log`，并在按钮旁闪 ✕

**判据：如果一个功能失败时你既看不到日志也看不到 UI 变化，它就不算「做完」，只算「还没验证过」。**

---

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | Host：注入路由 + 客户端日志路由 + `quote_read` 工具 |
| `session-reader.js` | 从会话日志按 message id 取全文（多帧 zstd + 索引缓存） |
| `client.js` | 浏览器：引用按钮、卡片、DOM 提取、发送检测 |
| `test.mjs` | 离线单测（格式化、DOM 提取、注入调用、slot 注册） |
| `verify.mjs` | 安装预检（manifest、patch、bundle、profile 接线） |
| `install.mjs` | 幂等安装/卸载 |
| `cordis.patch.yml` | 一条 `insert` 行 |

## 按 id 读消息（`quote_read`，已实现并验证）

模型可调用的工具，用来解决「引用不可撤回」的地基问题。

```
quote_read(messageId) → { found, messageId, text }
```

**实测性能**（4.7 MB / 5683 条事件的会话）：

| 项 | 耗时 |
|---|---|
| 首次读（解压 + 建索引） | **197 ms** |
| 二次读（缓存命中） | **0 ms** |

**实现要点**（`session-reader.js`）：

- 会话日志是**多帧 zstd**（每次追加一帧），普通解压只出第一帧，必须扫 magic `28 B5 2F FD` 逐帧解开
- 消息 id 位置：`user/message → data.id`，`assistant/message → data.message.id`
- 同一 id 可能跨多条事件（流式分片），文本要**累加**而非覆盖
- 按文件 `mtimeMs` 缓存索引，会话增长时才重建
- 工具拿不到 sessionId（`exec` 只带 `signal`），用 `ctx.agents.list()` 取**最近注册的活跃 agent** 反查

**已验证**：`quote_read('eb3fc73f-...')` 返回 113 字符原文，与日志里的 `len=113` 一致。

## 开发

```sh
node test.mjs      # 离线测试
node verify.mjs    # 安装预检
node install.mjs   # 安装 / 刷新
```

- 改 `client.js` → **刷新页面**（Ctrl+R）即可
- 改 `index.js` / `session-reader.js` → **必须重启 DSH**
- 日志：`~/.dsh/logs/quote-shot.log`
- 紧急回滚：桌面 `回滚引用插件.lnk`

---

## 引用：可撤回模式（当前默认，已实测通过）

```
点引用 → 读文本（仅卡片预览）→ 草稿插入 [引用消息 <id>——请先调用 quote_read 读取全文，再回答]
点 ×   → 从草稿删掉标记 → 真正撤回
发送   → 标记随消息带出 → 模型调 quote_read 取全文
```

- ✅ **可撤回**：发送前会话从未被写过
- ✅ **省 context**：消息里只有一行标记，不是几百字全文
- ✅ **卡片有内容**：预览从 DOM 读，不需要注入
- ⚠️ **代价**：草稿里会多一行标记（DSH 没有 before-send 钩子，标记必须点击时就位）

### ⚠️ 标记必须带祈使句（这条是血的教训）

**裸标记 `[引用消息 <id>]` 会失效。** 实测：用户在「开机动画」会话连发 3 次，`quote_read` 调用次数 **= 0**（工具在列表里、标记也在消息里，模型就是不读）。

**原因**：模型判断"这条内容不需要，凭上下文能答"——对它来说判断**是正确的**，但用户的意图是"请你看一下"。

**修法**：把标记写成**显式指令**：

```
[引用消息 <id>]                                    ← 失效
[引用消息 <id>——请先调用 quote_read 读取全文，再回答]  ← 生效
```

**对照实验**（同一会话、同一个 message id `93a9d3e7`）：

| 标记形态 | 结果 |
|---|---|
| 裸标记 | `quote_read` 调用 0 次 |
| 显式指令 | ✅ 调用，`len=2318` |

**可复用的通用经验**：给模型配工具时，想让它「总是调用」，**不要写条件许可**（"当…时调用"），**要写显式指令**（"请先调用…再…"）。前者是选项，后者是要求——服从度不是一个量级。

**旧模式（代码保留，可回滚）：全文注入**

`injectQuote()` 仍在 `client.js` 里但不再被调用。它把全文作为 `role:'user'` 消息注入会话，卡片只做提示——**即时响应、输入框干净，但不可撤回**。

### 实测记录

| 验证项 | 结果 |
|---|---|
| 能读到会话**第一条**消息 | ✅ 能，不依赖上下文 |
| 跨会话引用（「各种插件」会话） | ✅ 读到 5926 字符 |
| 无引用标记时 | ✅ 不调用工具 |
| 首次读取 4.7 MB 会话 | 197 ms |
| 缓存命中 | 0 ms |
| **裸标记触发** | ❌ **0 次**（设计缺陷） |
| **显式指令标记触发** | ✅ 调用并读到 2318 字符 |

**未验证的风险**（重要）：

1. **模型可能不调**——这次是因为提问直接指向"引用的内容"，工具是唯一手段。如果引用只是背景（"按上面说的改一下"），模型可能凭印象作答而跳过工具。
2. **多会话可能读错**——工具拿不到 sessionId，用 `ctx.agents.list()` 取**最近注册的活跃 agent** 反查。**多个对话同时活跃时可能读到错的那个**。

---

## 工具是怎么被触发的（机制说明）

不是规则引擎，是**模型自己决定的**。完整链路：

```
1. 注册    ctx.tools.register({ name, description, parameters, ... })
              ↓ 进 registry（全局或 agent scope）
2. 构建    agent 每轮调 LLM 前，把可见工具转成 tool schema
              { type:'function', function:{ name, description, parameters } }
              ↓ 随请求发给模型
3. 决定    模型原生支持 function calling。它读 description + 当前上下文，
           自行判断「要不要调、调哪个、传什么参数」
              ↓ 输出结构化的 tool_calls（不是文本）
4. 执行    agent loop 查 registry → 调 execute(args, exec)
              ↓ 结果作为 tool/result 事件回填
5. 再生成  带着工具结果再调一次模型
```

**关键认知**：`description` 就是给模型的**唯一提示**。写「当用户消息包含 `[引用消息 <id>]` 时调用它」等于告诉模型触发条件；不写，模型不会主动去找。

**所以提高调用率的手段只有三个**：描述里写清触发条件、标记做得显眼、必要时在系统提示里加强约束。

---

## 已知边界

- **草稿多一行标记**：`[引用消息 xxx]` 会出现在输入框里，发送后成为消息正文的一部分。
- **模型可能不调工具**：见上，引用可能被忽略。
- **多会话可能读错**：工具用「最近活跃 agent」反查会话，多对话并行时不保险。
- **抓取的是「当时的 DOM」**：卡片预览是点击瞬间的快照。
- **引用后不打字直接发送**：卡片不会自动收起（检测不到发送）。
- **排版丢失**：DOM 提取只取 `innerText`，代码块/表格会变成纯文本。

## 下一步（未做）

1. **截图提问** —— 需先验证 Electron 是否放开 `getDisplayMedia`
2. **修多会话错读** —— 需要把 sessionId 传进工具（可能要在 agent scope 注册，或改用 messageId 反查所属会话）
3. **提高调用率** —— 若实测发现模型经常跳过，可在标记里加一句显式指令
