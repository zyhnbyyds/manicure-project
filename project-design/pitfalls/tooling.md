# 踩坑记录 · 工具链（PowerShell / 开发者工具 / 测试运行）

> **为什么单独一个文件**：这些坑**不属于任何一端**，但三端开发都会踩，
> 而且几乎每次都浪费十几分钟。放这里比硬塞进某一端更容易被找到。
> 格式固定：**现象 → 根因 → 正确做法**。

---

## 1. `[System.IO.File]` 不认 PowerShell 的 `cd`

- **现象**：`Could not find a part of the path '...\src\views\...'`，
  而**同一条命令里的 `bun run typecheck` 却正常**。
- **根因**：.NET 的 IO API 用**进程工作目录**（workspace 根），
  而 `bun`/`node` 认 shell 的当前位置。
- **正确做法**：在 `pwsh` 里用 .NET IO API 一律给**绝对路径**。
- **本会话踩了 3 次。**

---

## 2. PowerShell 的转义是**反引号**，不是反斜杠

- **现象 1**：`\$ref` → `变量引用无效。"："后没有有效的变量名称字符`。
- **现象 2**：`\'无门槛\'` → `表达式或语句中存在意外的标记`。
- **根因**：双引号里 `$` 会插值；单引号里 `'` 要写**两遍**（`''`）；
  `\$` 与 `\'` **都不是** PowerShell 的转义（它用 `` ` ``）。
- **正确做法**：
  - **含 `$` 的字符串一律用单引号**（如 `'  schema: { $ref: ''#/...'' },'`）；
  - 含引号/反引号/中文的**多行代码块**，用
    **先赋值给变量的单引号 here-string**：

    ```powershell
    $block = @'
    ...原样内容，$ 和 ` 都是字面量...
    '@
    $t = $t.Replace($anchor, $block)
    ```
- **本会话踩了 4 次**（`$ref` 两次、`\'` 一次、here-string 当参数一次）。

---

## 3. 单引号 here-string 直接当 `.Replace()` 的参数会**整段解析失败**

- **现象**：命令**没有任何输出**，只有 `[exit code: 1]`，文件一个字都没改。
- **根因**：`'@)` 这种「终止符后面还有字符」的写法不合法 → 整段脚本不执行。
- **正确做法**：先 `$x = @'...'@` 赋值，再 `$t.Replace($a, $x)`。
- **自查**：**改完文件先 `git status`**，确认「真的改了」再往下走
  （否则会基于假前提继续验证一个不存在的改动）。

---

## 4. 别拿自己加工过的输出当精确锚点

- **现象**：锚点「明明看得见」却匹配不上（`*** 锚点未匹配 ***`），
  导致同一处改了两三遍。
- **根因**：我常用 `ForEach-Object { '  ' + $_ }` 给 grep 结果**加缩进前缀**，
  于是显示出的缩进比文件里多 2 格；照着它写锚点必然偏。
- **正确做法**：
  - **构造锚点前用 `read` 工具读原文件**（而不是看 grep 输出）；
  - 或让锚点**与缩进无关**：`[regex]::Replace($t, '(?m)^(\s*)pointsToUse\?:', ...)`，
    用 `$1` 回填缩进；
  - 或**按整行过滤**（`[System.IO.File]::ReadAllLines` + 精确/正则匹配整行）。
- **本会话踩了 4 次。**

---

## 5. `automation_evaluate` 传长 JS 会被 cmd 截断

- **现象**：`Uncaught missing ) after argument list`。
- **根因**：`wechatide.cmd` 是 cmd shim，长字符串里的引号被吞。
- **正确做法**：拆两步 ——
  ① 用 `curl`/`Invoke-RestMethod` 打**真实接口**拿到数据；
  ② 用一段**极短**的 JS 回填/断言（如 `wx.setStorageSync('k','v')`）。

---

## 6. 长时间命令要吃工具超时上限 → 放后台跑

- **现象**：全量测试跑到 `[timed out after 600000ms]`，`if` 分支根本没执行，提交也没发生。
- **正确做法**：可能超过 10 分钟的命令用 `run_in_background: true`，
  再用 `job_output`（可 `wait: true`）收结果。
- **顺带**：本项目的集成测试**已经**从 ~530 秒优化到 ~18 秒（见 `server.md` 第 6 条），
  正常情况下不需要后台跑。

---

## 7. 页面渲染异常时，**先量尺寸再怀疑「渲染抖动」**

- **现象**：截图里图标撑满全屏；连看两次截图，两次一样，
  差点判断成「间歇性渲染抖动」。
- **正确做法**：用
  `automation_element_action --action size --selector '.menu__icon'`
  **量元素实际尺寸**（声明 40rpx 却量到 320×240 → 定性为「样式没生效」），
  再用 `git checkout -- <file>` 回退文件对照。
- **结论**：**截图会骗人，尺寸不会。**

---

## 8. 用 `automation_evaluate` 调试时的两个「假阴性」

### 8.1 返回值里带转义引号 → 解析会被截断

- **现象**：JS 里 `return JSON.stringify({...})`，外层用
  `"result":\s*"([^"]*)"` 解析，只拿到 `{\`，看起来像「读不到/失败」。
- **根因**：结果字符串里的 `\"` 会提前结束我的正则。
- **正确做法**：让注入的 JS **返回纯标量**，别返回 JSON：
  `return 'items=' + n + ' | err=' + (e || 'none');`

### 8.2 只改 storage 不改内存 → 测不出「过期/失效」路径

- **现象**：`wx.setStorageSync('manicure:token', 'garbage')` 之后重进页面，
  应用**仍然用着旧的有效 token**（请求全都正常），401 路径根本没被走到。
- **根因**：`utils/token.ts` 有**模块级内存缓存**，`reLaunch` / 重进页面
  **不会重置模块状态**。
- **正确做法**：改完 storage 必须 **`simulator_refresh`** 重置 JS 上下文；
  并注意 **storage 本身不会被 refresh 清掉**（用探针 key 验证过）——
  这正是「自愈」能被观察到的前提。

---

## 9. 微信支付 Skill：CLI 只索引**接口文档**，概念类问题要查本地知识库

- **现象**：按技能要求先跑
  `wechatpay-dev-cli knowledge search "<用户原话>"`，
  问概念类问题（如「微信支付有沙箱吗」）会返回
  `{ "hit": false, "hints": [], "keywords": [] }` —— **看起来像「知识库没有」**。
- **根因**：CLI 的知识索引覆盖的是**接口文档**（搜 `JSAPI下单` 能命中
  `{api_version: v3, mch_type: 普通商户, product: jsapi支付}`），
  **不含 FAQ / 概念类内容**。
- **正确做法**：概念类问题走技能内置的「文档检索与问答」流程 ——
  在 `<技能目录>/assets/微信支付官网文档/`（**3985 篇**）上 `Grep` 探路再精读，
  并用 front matter 里的 `url` 溯源。
- **附带两条环境事实**：
  1. 该知识库是 `scripts/wechatpay-resource-sync.py` 下载的（**31.6 MB**），
     属可再生缓存，**已加入 `.gitignore`**，不要提交；
  2. 同步脚本还会**改写 `references/` 下的文档**（厂商更新，值得提交）
     以及三个脚本的**行尾**（纯噪音 —— `git diff --numstat` 为空但状态是 `M`，
     用 `git checkout -- <路径>` 回退即可）。

---

## 10. 开发者工具 CLI：URL 里的 `&` 会被 cmd 当命令分隔符

- **现象**：`automation_navigate --url '/pages/x/index?a=1&b=2&c=3'` 之后，
  页面只收到了**第一个参数**（`a=1`），其余全丢；用 `^&` 转义在
  PowerShell → cmd 这一层**不可靠**（时好时坏）。
- **根因**：`wechatide.cmd` 是批处理，参数最终由 cmd.exe 解析；`&` 是 cmd 的命令分隔符。
- **正确做法**：**绕开命令行**——用百分比编码的 URL，在 JS 里解码：
  ```
  automation_evaluate --fn-source "function(){ wx.reLaunch({ url: decodeURIComponent('%2Fpages%2Fx%2Findex%3Fa%3D1%26b%3D2') }); return 'go'; }"
  ```
  编码串里没有 `&`/`?`，命令行安全。
- **代价**：这个坑让我连续误判了两轮（以为是页面没重渲染），**发现前一直以为是代码问题**。

## 11. 验证「登录态相关」改动前，先确认本地 token 的**来源**

- **现象**：页面一直停在未绑定/401，代码看起来完全正确。
- **根因**：开发者工具本地存的 token 可能是**更早某次登录**签发的
  （本项目就出现过：token 是 `WX_MINIAPP_FAKE=true` 时代的 `fake-openid-…`、
  对应的 app 用户在库里 `customer_id` 为空）。**改后端绑定不会刷新已签发的 token。**
- **正确做法**：动手验证登录态之前先解码 token 的 payload 确认 `sub`/`openid`：
  ```
  automation_evaluate --fn-source "function(){ var p=String(wx.getStorageSync('manicure:token')).split('.')[1]; return p; }"
  ```
  再用 `SELECT id, openid, customer_id FROM app_wx_user` 对齐；必要时
  `wx.removeStorageSync('manicure:token')` + `simulator_refresh` 让它重新静默登录。

## 12. PowerShell `-replace` 是**全量替换**，拿它做「变异验证」会连带改坏别处

- **现象**：为验证单测能不能抓住 bug，用 `-replace` 把修复语句改回错误写法，跑测试确实红了；
  改回来之后**测试还是红**，而且失败的是另一条断言 —— 文件里另一处同形状的语句也被改了。
- **根因**：`-replace`（以及 `-creplace`）默认替换**所有**匹配项，不是第一处。
  我当时的目标串 `url: toDisplayImageUrl(url),\n    status` 在同一个文件里正好出现两次。
- **正确做法**：
  1. 变异验证优先用 `edit` 工具改单点，别用正则批量替换；
  2. 非要脚本替换时，先 `(Select-String -Pattern ... | Measure-Object).Count` 数一下命中几处，
     或把上下文写长到唯一；
  3. 变异后**必须** `git diff` 看清改了哪几行再还原，别凭记忆。
- **来源**：实测（本次修「上传的图显示不出来」时自己踩的，白跑了一轮全量测试）。

---

## 13. pwsh 控制台默认 GBK，git / gh 的中文输出全是乱码 —— 别据此以为「数据写坏了」

- **现象**：`git log --oneline` 显示 `fix(app): 鎴戠殑棰勭害...`，
  `gh release view` 显示 `name: 1.0.0 鈥?棣栦釜姝ｅ紡鐗堟湰`。看起来像提交信息 / Release 标题被写坏了。
- **根因**：PowerShell 控制台（含工具内置终端）默认代码页 936（GBK），而 git / gh 吐的是 UTF-8 字节
  → 按 GBK 解码就成了花屏。**乱码只发生在「显示」这一步，不在「写入」那一步。**
- **正确做法**：开一次
  `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`，之后 git / gh / node 的中文都正常；
  写文件用 `Set-Content -Encoding utf8`（pwsh 7 写出的是无 BOM UTF-8，git 与 gh 都认）。
- **判别依据**：`鈥` / `鎴` / `锛` 这种「一个字符位挤着两个符号」的形态是
  **UTF-8 被当成 GBK 读**的典型特征；真损坏会显示成 `?` 或 `&#xxx;`。
- **怎么发现的**：发布 1.0.0 时 `gh release create` 的标题在终端是乱码，以为 notes 写坏了；
  切到 UTF-8 再 `gh release view v1.0.0 --json body` 读回，3533 字符中文正文完全正常 —— 虚惊一场。
