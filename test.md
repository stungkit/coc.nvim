# coc.nvim 原生测试迁移

> 方案设计见 [`.codex/native.md`](.codex/native.md)。测试运行器把全部 TypeScript 用 esbuild 预编译到 `.cache/coc-test/build`，按历史耗时（LPT）分成批次入口，再用 `node:test` 执行并消费 TestsStream 输出报告。
> 验证统一使用 **Node 24.12.0**。

## 运行命令

所有命令在仓库根目录执行。测试文件不再带 lane 头注释：分类完全按路径（`src/__tests__/unit/` 下是 unit 测试，`VIM_TESTS` 数组里的文件是 vim 测试，其余都是 nvim 测试）。

终端下每个测试文件占一行并原地刷新：开始测试显示 `▶`，完成后更新为 `✓`/`✗` 和耗时；输出被重定向（CI）时改为逐行顺序输出。最终摘要会显示测试文件总数。
测试出错会**实时打印到 stderr**（通过 `test:stderr`/`test:stdout` 事件转发），不等整个 run 结束。

### 运行全部已迁移测试

```bash
npm run test:native                      # 等价于 node scripts/test/cli.mjs
node scripts/test/cli.mjs
npx -y node@24.12.0 scripts/test/cli.mjs # 按验证标准运行
```

### 常用选项

```bash
node scripts/test/cli.mjs --list                              # 列出所有可运行的测试文件
node scripts/test/cli.mjs --unit                              # 只运行 unit lane
node scripts/test/cli.mjs -t '<regex>'                        # 按测试名称过滤
node scripts/test/cli.mjs src/__tests__/unit/framing.test.ts  # 显式指定文件
node scripts/test/cli.mjs src/__tests__/handler/hover.test.ts # 运行单个编辑器测试文件
node scripts/test/cli.mjs -j 2                                # 批次并发数（默认 8）
node scripts/test/cli.mjs --force-exit                         # 测试结束后强制退出（排查用）
node scripts/test/cli.mjs --keep-temp                          # 保留分片临时目录
```

全量运行分两个阶段：**阶段 1 先用满 CPU 核数（默认 `os.cpus().length`）跑 unit worker pool**，**阶段 2 nvim+vim 合并成一个滚动池、并发上限 8**——某个文件一跑完立刻补下一个，直到全部测完。`--unit` 只跑 unit lane。
- **unit lane**：`src/__tests__/unit/*.test.ts`，49 个文件；父进程按 `-j`（默认 CPU 核数）建立 worker pool，每个 worker 内用 `node:test run({ isolation: 'none', concurrency: false })` 顺序执行一批文件，多个 workers 并行。`ISOLATED_UNIT_TESTS`（configurationModel、factory）各自独占 worker，避免 registry/mock 污染。
- **nvim lane**：除 unit 目录和 `VIM_TESTS` 外的全部文件，70 个，**每个测试文件一个独立环境**（独立子进程 + 独立 nvim + 独立 coc bundle，互不共享）；阶段 2 与 vim 共享滚动池，并发上限 8；单个测试超时统一 **5s**。
- **vim lane**：`VIM_TESTS` 数组（[`scripts/test/discover.mjs`](scripts/test/discover.mjs)），当前只有 `vim.test.ts` 1 个文件（单文件，实际并发 1），`VIM_NODE_RPC=1` 由运行器注入；分片级 `session.start('vim')`。

### 类型检查

```bash
npm run lint:typecheck
```

### 产物与缓存

- **测试文件全部在内存中编译**：每个 src/__tests__ TS 文件由子进程内 esbuild（`write:false`）编译并经 `registerHooks` 注入，磁盘零写入；`compile.mjs` 已删除。
- **编辑运行时 bundle 只构建一次**：父进程用 esbuild 构建并写入 `.cache/coc-test/bundle.js`（同目录 `bundle.js.map`，经 `sourceMappingURL` 链接，`sourceRoot` 指回仓库根），unit workers 和 editor 子进程按需 `require()` 这个文件，**绝不重新构建**；只继承 `--import=bundle-hooks.mjs`、但不加载测试/src 的 helper 子进程不会加载 bundle。第三方包（`package.json` 的 dependencies，28 个）全部打进 bundle 并导出为 `pkg:<spec>` key；hooks 把测试里的包导入路由到 `coc-bundle:pkg:<spec>`，与运行时共用同一份实例，不再从 node_modules 重复加载。vscode-uri / vscode-languageserver-textdocument / vscode-languageserver-types 有 import/require 双构建（ESM vs UMD），构建时用 esbuild 插件钉到同一份 require 构建，避免 `instanceof` 双类问题。
- **run() 直接使用测试文件原路径**：`run.mjs` 把真实 `.ts` 路径交给 node:test；unit 文件按批次在线程内加载，editor 文件仍是每文件一个子进程。hooks 按路径判定 lane、在加载时注入 preload/EditorSession（编辑器 lane 用外层 `describe` + `?raw` 动态 import 包装测试文件，见第五轮）。不再有虚拟 `/coc-entry` 入口，`entry-source.mjs`/`schedule.mjs` 已删除。
- 历史耗时（LPT 分片依据）：`os.tmpdir()/coc-test-native/timings.json`

## 测试文件迁移状态

- 总数：**120**（unit 目录 49 / 编辑器相关 70 / vim 1）
- 已迁移：**120**（unit 目录 49 / 编辑器 70 / vim 1；全部文件不再带 `// @coc-test` 头，lane 由路径与 `VIM_TESTS` 数组决定）
- `[x]` = 已完成迁移；`[ ]` = 待迁移
- unit 目录测试已全部移除对 `helper.ts` 的依赖：`createNode`/`createNodes`/`makeLine`/`wait`/`waitValue` 等函数抽到了 `src/__tests__/unit/testUtils.ts`，全部归为纯 unit 类

### unit（49 个，已迁移 49）

- [x] auth.test.ts
- [x] basicProvider.test.ts
- [x] bridge.test.ts
- [x] chars.test.ts
- [x] client.test.ts
- [x] configuration-util.test.ts
- [x] configurationModel.test.ts
- [x] configurations.test.ts
- [x] connection.test.ts
- [x] converter.test.ts
- [x] db.test.ts
- [x] diagnosticCollection.test.ts
- [x] dispatcher.test.ts
- [x] document-helpers.test.ts
- [x] events.test.ts
- [x] exit.test.ts
- [x] expand.test.ts
- [x] extensionInstaller.test.ts
- [x] factory.test.ts
- [x] filter.test.ts
- [x] framing.test.ts
- [x] fs.test.ts
- [x] funcs.test.ts
- [x] fuzzyMatch.test.ts
- [x] history.test.ts
- [x] index.test.ts
- [x] line.test.ts
- [x] logger.test.ts
- [x] lsp-helpers.test.ts
- [x] map.test.ts
- [x] memos.test.ts
- [x] modules-util.test.ts
- [x] notifications.test.ts
- [x] parser.test.ts
- [x] path.test.ts
- [x] queryCache.test.ts
- [x] regions.test.ts
- [x] renderer.test.ts
- [x] security.test.ts
- [x] semanticTokensBuilder.test.ts
- [x] server.test.ts
- [x] service.test.ts
- [x] mcp-session.test.ts
- [x] slowRequest.test.ts
- [x] startRace.test.ts
- [x] strWidth.test.ts
- [x] tools.test.ts
- [x] utils.test.ts
- [x] workspaceFolder.test.ts

### client（8 个，其中 7 个已迁移到 nvim lane）

- [x] api.test.ts
- [x] configuration.test.ts
- [x] diagnostics.test.ts
- [x] dynamic.test.ts
- [x] features.test.ts
- [x] fileSystemWatcher.test.ts
- [x] integration.test.ts
- [x] textSynchronization.test.ts

### 编辑器测试（71 个，逐文件改写）

- [x] client/api.test.ts
- [x] client/configuration.test.ts
- [x] client/diagnostics.test.ts
- [x] client/dynamic.test.ts
- [x] client/features.test.ts
- [x] client/fileSystemWatcher.test.ts
- [x] client/integration.test.ts
- [x] client/textSynchronization.test.ts
- [x] completion/basic.test.ts
- [x] completion/features.test.ts
- [x] completion/language.test.ts
- [x] core/basic.test.ts
- [x] core/documents.test.ts
- [x] core/features.test.ts
- [x] core/fileSystemWatcher.test.ts
- [x] core/files.test.ts
- [x] handler/basic.test.ts
- [x] handler/callHierarchy.test.ts
- [x] handler/codeActions.test.ts
- [x] handler/codelens.test.ts
- [x] handler/documentColors.test.ts
- [x] handler/features.test.ts
- [x] handler/format.test.ts
- [x] handler/hover.test.ts
- [x] handler/inlayHint.test.ts
- [x] handler/inline.test.ts
- [x] handler/locations.test.ts
- [x] handler/outline.test.ts
- [x] handler/refactor.test.ts
- [x] handler/rename.test.ts
- [x] handler/semanticTokens.test.ts
- [x] handler/signature.test.ts
- [x] handler/symbols.test.ts
- [x] handler/typeHierarchy.test.ts
- [x] handler/workspace.test.ts
- [x] list/features.test.ts
- [x] list/manager.test.ts
- [x] list/mappings.test.ts
- [x] list/sources.test.ts
- [x] list/ui.test.ts
- [x] list/worker.test.ts
- [x] mcp/document.test.ts
- [x] mcp/editor.test.ts
- [x] mcp/lsp.test.ts
- [x] mcp/notifications.test.ts
- [x] mcp/workspace-tools.test.ts
- [x] modules/attach.test.ts
- [x] modules/basic.test.ts
- [x] modules/cursors.test.ts
- [x] modules/diagnosticBuffer.test.ts
- [x] modules/diagnosticManager.test.ts
- [x] modules/document.test.ts
- [x] modules/extensionManager.test.ts
- [x] modules/extensionModules.test.ts
- [x] modules/extensions.test.ts
- [x] modules/fetch.test.ts
- [x] modules/floatFactory.test.ts
- [x] modules/menu.test.ts
- [x] modules/outputChannel.test.ts
- [x] modules/picker.test.ts
- [x] modules/plugin.test.ts
- [x] modules/quickpick.test.ts
- [x] modules/services.test.ts
- [x] modules/terminal.test.ts
- [x] modules/window.test.ts
- [x] modules/workspace.test.ts
- [x] snippets/manager.test.ts
- [x] snippets/session.test.ts
- [x] snippets/snippet.test.ts
- [x] tree/treeView.test.ts
- [x] vim.test.ts

## 迁移过程中遇到的问题与解决方法

按类别记录，方便后续迁移阶段（isolated/vim/nvim 会话）复用。

### 编译与资源

1. **Node 24 直接执行 TS 不可行**（保留 esbuild 的原因）
   - 现象：`node --test src/__tests__/unit/framing.test.ts` 报 `Cannot use import statement outside a module`；ESM 模式下列表省略扩展名的相对导入报 `ERR_MODULE_NOT_FOUND`；`require()` 不解析 `.ts`；`enum`/构造器参数属性需要 `--experimental-transform-types`。
   - 原因：仓库 `package.json` 是 `"type": "commonjs"`，`.ts` 被当 CommonJS 解析，而全部源码用 ESM 语法；427 个文件都是无扩展名相对导入。
   - 解决：保留 esbuild 预编译（一次约 300-500ms），不改模块语义。

2. **编译产物里的相对资源找不到**
   - 现象：`require('../../package.json')`、`data/schema.json`、`bin/*.wasm`、`src/__tests__` fixture 在 build 目录全部解析失败。
   - 原因：测试编译产物多一层 `src/`（`.cache/coc-test/build/src/...`），相对路径都偏移一级。
   - 解决：`compile.mjs` 镜像 `package.json`、`data/`、`bin/` 和 `src/**` 下所有非 TS 文件到 build 目录（文档 §5.4）。

3. **测试用 `__filename`/`__dirname` 在 build 目录语义变化**
   - 现象：`fs.test.ts` 的 `isGitIgnored(__filename)` 从“不忽略”变成“被忽略”（`.cache` 在 .gitignore 里）；`resolveRoot(__dirname, ['.git'])` 起点不同导致期望值错误。
   - 解决：改为项目根相对路径 `path.join(process.cwd(), 'src/__tests__/...')`，源码和 build 下行为一致（文档 §5.4 方案一）。

### 执行器与事件流

4. **suite 级失败假绿**
   - 现象：文件加载失败只表现为 suite 失败，不计数、退出码仍为 0。
   - 解决：`run.mjs` 统计 suite 失败；当没有叶子失败但存在 suite 失败时输出错误并 exit 1。

5. **Node 20 与新版叶子事件形状不同**
   - 现象：Node 20 叶子测试事件没有 `details.type`，suite 才有；Node 24/26 叶子带 `details.type === 'test'`。
   - 解决：切换 Node 24 后简化为 `details.type === 'test'` 判定（历史版本用“非 suite 即叶子”）。

6. **`mock.calls` 结构与 Vitest 不同**
   - 现象：`dispatcher.test.ts` 的 `socket.write.mock.calls.map(args => args[0])` 取到 undefined。
   - 原因：Node 的 `mock.calls` 是调用对象数组（`{ arguments, result, ... }`），Vitest 是参数数组。
   - 解决：用 `call.arguments[0]`；迁移含 `mock.calls` 的文件时先检查这一点。

7. **`t.mock.timers` API 差异**
   - 现象：Node 24.12 的 MockTimers 只有 `tick/enable/setTime/reset/runAll`，没有 `tickAsync/runAllAsync`。
   - 解决：`vi.advanceTimersByTimeAsync` 改同步 `tick`（回调本身同步执行即可）；fake timers 在测试结束自动恢复，`vi.useRealTimers` 的 afterEach 可删。

8. **`vi.waitFor` 不存在**
   - 现象：`exit.test.ts` 用 `await vi.waitFor(() => expect(exitCode).toBe(0))` 轮询异步状态。
   - 解决：复用 `testUtils.waitValue`（200×20ms 轮询 + `equals` 比较）；TS 上显式泛型 `waitValue<number | undefined>(() => exitCode, 0)`。

### Mock 与模块

9. **`t.mock.method` 无法 mock getter 属性**
   - 现象：`Intl.Segmenter` 是 accessor 属性，mock 报 “methodName must be a method. Received undefined”。
   - 原因：Node mock 读属性描述符的 `value`（getter 上没有）。
   - 解决：手动 `Object.defineProperty` 替换 getter，`finally` 里恢复原描述符。

10. **esbuild 生成的模块导出不可替换**
   - 现象：`t.mock.method(processes, 'runCommand')` 和 `Object.defineProperty` 都失败（`Cannot redefine property`）。
   - 原因：esbuild CJS 的 ESM 导出是 `configurable: false` 的 getter。
   - 解决：改 mock 更底层的接缝（如 `child_process.exec`），不 mock 命名导出本身。

11. **全局单例污染（registry）**
   - 现象：`configurationModel.test.ts` 单独跑 68 个全过，与其它文件同进程时 `getConfigurationProperties()` 变成 309 条。
   - 解决：新增 `@coc-test isolated` lane，isolated 文件每个独占一个批次进程（`schedule.mjs` 拆分）。

12. **`mockResolvedValueOnce`/`mockRejectedValueOnce` 序列**
   - 现象：`lsp-helpers.test.ts` 需要“第一次 reject A、第二次 reject B”的序列行为，Node mock 没有 Once 变体。
   - 解决：用调用计数实现有状态 mock：`let calls = 0; t.mock.method(obj, 'm', async () => { calls++; if (calls === 1) throw A; throw B })`。

13. **辅助函数里创建 spy**
   - 现象：`modules-util.test.ts` 的 `mockElapsedTime()` 和 `workspaceFolder.test.ts` 的 `testEvent()` 在普通函数里用 `vi.spyOn`。
   - 解决：`t.mock` 依赖测试上下文，把 `t` 作为参数从测试回调传入辅助函数。

### 断言转换

14. **`deepStrictEqual` 对 null 原型对象敏感**
   - 现象：`toValuesTree`/`toJSONObject` 返回 `Object.create(null)` 对象，`assert.deepStrictEqual` 失败而 Vitest `toEqual` 通过。
   - 解决：这两处改用 `assert.deepEqual`（忽略原型），并加注释。

15. **`assert.*` 断言签名会收窄类型**
   - 现象：`let annotated: any = ...; assert.deepStrictEqual(annotated, {...}); annotated.title` 报类型错误。
   - 原因：@types/node 的 `deepStrictEqual` 带 `asserts actual is T`；`assert.ok(win instanceof ExtData)` 同理会把 `win` 收窄成 `ExtData`，导致后续 `decode(win.data)` 参数类型报错。
   - 解决：属性断言放在 deepStrictEqual 之前；被收窄的变量用 `as Uint8Array` 等显式断言。

16. **Vitest 专属 matcher 无法机械转换**
   - `expect.arrayContaining` / `objectContaining` / `toMatchObject`：codemod 只处理 `expect(x).matcher(...)`，值用法需手写（includes 循环 / 属性断言）。
   - `toHaveBeenCalledWith`：改用 `mock.calls[0].arguments` 断言。
   - `toHaveLength`/`toBeLessThan`/`toBeGreaterThanOrEqual`：已加入 codemod（`assert.strictEqual(x.length, n)` / `assert.ok(x < n)` / `assert.ok(x >= n)`）。
   - `it(name, fn, timeout)`：Vitest 第三参是 timeout，node:test 需要 `it(name, { timeout }, fn)`（codemod 按缩进识别，避免误伤 `setTimeout(..., 30)`）。

17. **Vitest/globals 类型与 node:test 冲突**
   - 现象：迁移文件在 `tsc -p tsconfig.json`（types 含 `vitest/globals`）下报 TS2559。
   - 解决：规范调用形态后不再冲突；后续计划用 `tsconfig.test.json`（types 只有 node）做测试类型检查。

18. **hook 回调参数类型**
   - 现象：`beforeEach(t => ...)` 中 `t` 被推断为 `TestContext | SuiteContext`，`t.mock` 报错。
   - 解决：hook 回调参数显式 `any`（node:test 的 HookFn 参数是联合类型）。

### 测试语义

19. **Vitest 迁移后行为与环境的差异**
   - `service.test.ts` 的 `status.tools` 是字符串数组（allowedTools 列表），不是工具对象数组，`map(t => t.name)` 全为 undefined。
   - 排查手法：对可疑断言先用独立探针脚本打印实际值，再改断言。

20. **Vitest 兼容期处理**
   - 已迁移文件对 Vitest 不可见（报 “no tests”），`vitest.config.ts` 的 include 改为 `rg --files-without-match -e 'await helper\.setup|@coc-test'` 自动排除带 `@coc-test` 头的文件（后续按用户指示不再维护 Vitest 侧）。

21. **tokenizer 不识别正则字面量**
   - 现象：`extensionInstaller.test.ts` 里两处 `expect(fn()).rejects.toThrow(/doesn't exists/)` 未被转换且无警告。
   - 原因：转换器把正则 `/doesn't exists/` 中的单引号当成字符串开头，一路吞掉后面的代码。
   - 解决：给 `scanBalanced`/`convertExpects` 增加正则识别启发式（前一个非空白字符是 `(`/`,`/`=`/`[` 等值位置时 `/` 开头视为正则字面量）。

22. **`node:assert/strict` 的 `deepEqual` 也是 strict**
   - 现象：`factory.test.ts` 用 `assert.deepEqual` 比较 VM 沙箱对象仍报 “same structure but not reference-equal”。
   - 原因：`node:assert/strict` 的 `deepEqual` 是 `deepStrictEqual` 的别名；只有 legacy `assert` 的 `deepEqual` 才忽略原型。
   - 解决：沙箱返回的跨 realm 对象先展开成普通对象再 `deepStrictEqual`，或改用 legacy assert。

23. **`it(name, fn, timeout)` 转换对 `async t =>` 失效**
   - 现象：vi 转换注入 `t` 后，`convertTimeoutArgs` 只匹配 `async () => {`，`async t => {` 不匹配，且重写会丢掉回调前缀、漏掉闭合括号。
   - 解决：正则改为捕获整个回调前缀（`async t`/`t`/`() `），闭合行输出 `})`；损坏的测试手动修复。

24. **`toMatch`/`toThrow` 字符串参数需转义**
   - 现象：`signature.test.ts` 的 `expect(line).toMatch('foo(a, b)')` 转成 `assert.match(line, new RegExp('foo(a, b)'))` 后失败——括号变成正则捕获组，匹配不到字面 `foo(a, b)`。
   - 原因：Vitest 对字符串参数先转义再建正则（字面子串语义），codemod 直接 `new RegExp(string)` 没转义。
   - 解决：codemod 的 `toMatch`/`toThrow`（含 `.not`/`.rejects` 变体）对字符串参数做 `escapeRegExpArg`；已转错的断言改为字面量正则。

25. **mock 返回 `null` 触发“reading 'then'”异步泄漏**
   - 现象：`handler/features.test.ts` 的 `should open url`/`should restart` 用 `t.mock.method(nvim, 'call'/'command', () => { ...; return null })`，断言全过但分片结束时报 `Test hook "before" ... generated asynchronous activity ... Cannot read properties of null (reading 'then')`，suite 失败、退出码非 0。
   - 原因：`nvim.call`/`nvim.command` 的调用方里存在不 `await` 而是直接 `.then` 的挂起链（如后台任务），mock 返回裸 `null` 时读到 `null.then` 抛错；Vitest 不追踪此类活动所以看不到。
   - 解决：mock 这类 Promise 方法时返回 `Promise.resolve(null)`（保持 Promise 语义）。

26. **esbuild 常量折叠破坏“字符串不存在”类断言**
   - 现象：`handler/features.test.ts` 的 `should show empty result when no result found` 期望 rg 搜不到 `'should found ' + ' no result'`，但 nvim 的 cwd 是 `build/src/__tests__`，esbuild 把拼接折叠成字面量 `"should found  no result"`，rg 直接命中编译后的测试文件本身，输出 `Files: 1 Matches: 1`。
   - 解决：模式改用变量拼接（`let keyword = 'no result'; ['should found ' + keyword]`），编译产物不再包含完整字面量。

27. **`import type A, { B }` 混合形式 esbuild 报错**
   - 现象：`handler/refactor.test.ts` 的 `import type RefactorBuffer, { FileItemDef } from '...'` 编译报 `Expected "from" but found ","`。
   - 解决：拆成两条 `import type` 语句（默认与命名分开）。

28. **列表窗口的 `winfixbuf` 跨测试残留导致 E1513**
   - 现象：`list/manager.test.ts` 按文件顺序运行时，前一个列表测试的窗口把 `winfixbuf` 留在目标窗口，后续 `--number-select`/`doAction` 跳转报 `E1513: Cannot switch buffer. 'winfixbuf' is enabled`（或静默失败、line 停在 1），单独跑单个测试却通过。
   - 排查：拦截 `nvim.call('coc#util#jump', ...)` 看参数与错误；`getwinvar(0,'&winfixbuf')` 确认跳转时当前窗口仍带 winfixbuf。
   - 解决：文件级 `afterEach` 在 reset 前加 `await nvim.command('windo setl winfixbuf&')` 清掉所有窗口的 winfixbuf；同时 `manager.cancel(true)` 等待列表窗口真正关闭。

29. **并行分片共享 dataHome 导致文件竞态（ENOENT / Mru 丢失）**
   - 现象：`should load lists source` 偶发 `ENOENT: .../unit/lists`，且多分片并行时 Mru 文件互相覆盖。
   - 原因：`run.mjs` 对所有分片固定 `COC_TEST_SHARD_ID='unit'`，多个 nvim 子进程共享同一个 dataHome；某个子进程退出时的 `fs.rmSync(dataHome)` 会把还在运行的其他分片的文件删掉。
   - 解决：`preload.cjs` 用 `SHARD_ID-pid` 作为每个子进程独立 dataHome。

30. **列表光标移动是异步的，紧跟其后的断言要等光标到位**
   - 现象：`list/ui.test.ts` 的 `should toggle selection` 在全量顺序下偶发 `2 !== 0`（期望 0）。
   - 原因：`listInput('j')` 是 fire-and-forget，第二个 `toggleSelection()` 在光标移动完成前读取旧行，把已经选中的行再 toggle 一次导致选中数变 2。
   - 解决：`listInput('j')` 后加 `await session.waitFor('line', ['.'], 4)` 等光标落到目标行再 toggle。

## 阶段三可行性分析：esbuild 整体 bundle + nvim/vim attach

> 结论：**可行**。核心链路已端到端验证（bundle → attach → plugin.init → 单例身份一致），但有 4 个必须解决的工程问题。

### 已验证的实证（Node 24.12.0）

1. **全量 bundle 可构建**：生成入口 `export * from 全部 302 个 src 模块`，esbuild `bundle + packages: external + cjs + node24`，124ms / 1.8MB。
2. **懒加载导出面**：入口用 `Object.defineProperty(exports, key, { get: () => require(module) })`，esbuild 会把 require 内联成惰性调用——`require(bundle)` 本身不执行任何 coc.nvim 模块；访问 `bundle.workspace` 时才触发该模块加载（此时才产生 2 个 `fs.watch`）。
3. **nvim attach 端到端**：`bundle.attach({ proc })`（spawn `nvim -u vimrc --embed`）→ `uiAttach` → `coc#rpc#set_channel` → `plugin.init('')` → `plugin.isReady === true`，且 **`plugin.workspace === bundle.workspace.default`（单例身份一致，这是 bundle 方案的核心收益）**。
4. **扩展动态 require 不受影响**：`src/util/factory.ts` 的扩展沙箱 `require(变量)` 被 esbuild 自动 external 化，运行时行为不变。

### 必须解决的 4 个问题

1. **导出面映射规则**：`export *` 不导出 default；151 个模块有 default 导出，且 basename 重名 27 处（`index`×20、`buffer`、`commands` 等），default 与命名导出还可能同名冲突（如 `workspace` 类 vs 单例）。需要生成规则：key = 相对路径派生的唯一名，default 直接映射为该 key（`bundle.workspace` = 单例实例），命名导出保留在模块命名空间下。
2. **模块加载副作用**：`new Workspace()` 顶层构造会 `fs.watch` 配置路径（2 个 FSEventWrap），访问 workspace 后分片进程不会自行退出。策略：(a) 提供 bundle 级 `dispose`/重置接口；(b) 编辑器分片允许显式退出；(c) 或运行时在 worker 里隔离。与文档 §18“默认不 forceExit”冲突，需定夺。
3. **`__dirname`/`__filename` 失效**：src 里有 6 个文件 7 处（`constants.pluginRoot`、`strwidth/fuzzyMatch` 的 wasm、`extension/manager`、`handler/workspace`、`completion/native/*`）。bundle 里全部变成 bundle 所在目录。需要 runner 暴露 `COC_TEST_ROOT`（源码根），这些位置改为相对源码根解析（文档 §5.4 方案）。
4. **71 个测试文件的 import 重写**：实测 71 个文件共 165 个不同 src 导入路径（workspace×54、util×43、events×34、window×30、languages×30、commands×25 等），需 codemod 批量改为 bundle 引用；测试仍依赖 `helper.ts`（建议把 helper 也打进 bundle，保证 attach/Plugin/workspace 身份一致）。

### 推荐实现路径（与文档 §9 结合）

1. 生成懒加载 bundle（`.cache/coc-test/bundle.js`），入口生成脚本复用现有 `scripts/test` 体系。
2. 把 `helper.ts` 重构为 `EditorSession`（文档 §9.1）并打进 bundle；测试通过 bundle 获取 `attach`/`Plugin`/`workspace`/`helper`。
3. codemod 改写 71 个文件的 src 导入为 bundle 引用（按导出面映射规则）。
4. 编辑器分片复用：每分片一个 nvim（或 vim 串行），`before/after` 管理生命周期，先跑通 1 个文件再扩展。

### 待用户决策

### 已确定的方案（2026-08-11 决策）

1. **导出面**：导出名使用模块完整路径（如 `src/workspace`、`src/util/fs`），保证唯一；测试 import 时按完整路径取模块（默认导出在模块命名空间的 `default` 上）。
2. **运行时常驻**：编辑器测试不依赖进程退出——每个“编辑器运行时”进程（vim/nvim + coc 运行时）连续测试多个文件；实际按需启动多个运行时并行跑不同测试集合。`fs.watch` 常驻句柄可接受，不需要等待退出。
3. **`__dirname` 修复**：bundle 内失效的位置改为基于 `COC_TEST_ROOT`（源码根）解析。
4. **helper.ts 废弃**：不再打入 bundle，重新实现编辑器会话加载逻辑（`EditorSession`，文档 §9 方向）。
5. **不 forceExit**：分片结束通过正常 dispose（找到挂载点清理 watcher/socket/plugin）退出。

### 已落地的实现（本轮）

1. **bundle 生成器**：[`scripts/test/bundle.mjs`](scripts/test/bundle.mjs) 生成 302 个 src 模块的懒加载全路径导出（`src/workspace`、`src/util/fs` 等唯一 key），esbuild 124-164ms / 1.8MB；`compile.mjs` 会把 bundle 复制到 build 根（`build/bundle.js`），测试文件用与仓库根同深度的相对路径引用。
2. **COC_TEST_ROOT**：`src/util/constants.ts` 的 `pluginRoot` 在 `COC_TEST_ROOT` 存在时直接用该值；`run.mjs` 设置 `COC_TEST_ROOT = buildDir`（bin/data/package.json 已镜像到的位置），修复 bundle 内 `__dirname` 失效导致的 wasm 路径错误。
3. **import 语法验证**：TS 支持字符串字面量 import 标识符（`import { 'src/workspace' as workspace } from '../../../bundle.js'`），esbuild 正确转译为 `import_bundle["src/workspace"]`；`import = require` 因 tsconfig `module: es2022` 不可用（TS1202）。
4. **验证结果**：`plugin.workspace === bundle['src/workspace'].default`；`require(bundle)` 本身无副作用（仅 2 个待定位的 PipeWrap），访问 workspace 才触发 `fs.watch`；完整 unit 套件 955 passed 无回归。

### EditorSession（替代 helper，阶段三第 ① 步）

- 新增 [`scripts/test/editor-session.mjs`](scripts/test/editor-session.mjs)（原 `src/__tests__/editorSession.ts`，随独立环境方案迁入 scripts 并打进 bundle）：从 `globalThis.__cocBundle` 惰性取 `src/attach`/`src/events`，实现 `start(nvim|vim)` / `reset()` / `stop()` 及 helper 的完整工具面（edit/createDocument/waitValue/waitFor/doAction 等）。以后新编辑器测试不再用 helper.ts。
- **nvim 会话已验证**（Node 24.12.0）：start 约 228ms → ready；`session.workspace === bundle['src/workspace'].default`（单例身份一致）；createDocument/setline/getline/reset 全通过；`stop()` 后 FSEvent 0 残留、无残留 nvim 进程（`plugin.dispose → workspace.dispose` 是清理挂载点）。
- **vim 会话待修**：本环境（vim 9.1）下 RPC 首调用即 `ERROR`/EPIPE——用 vitest + 现有 helper 复现同样失败，属既有环境问题而非 EditorSession 引入；需要单独排查 vim JSON channel 握手（`autoload/coc/rpc.vim` 测试模式跳过 init 握手）。
- **路径修复记录**：编译树里的 vimrc 副本 `s:root`（`<sfile>:h:h:h`）会解析到 build 目录，必须用源码树 vimrc（`COC_TEST_ROOT` 上溯三级）。

### nvim 运行时池（阶段三第 ② 步）

> 已被“每文件独立环境”方案取代（见下文“决策更新”）。以下保留历史记录。

- 新增 `setSession`/`getSession` 与 `editorSuite`（`describe` + 每测试 `afterEach(reset)`）——现为 `scripts/test/editor-session.mjs` 的导出，经 preload.cjs 暴露为全局。
- [discover.mjs](scripts/test/discover.mjs) 识别 `// @coc-test nvim`；[entry-source.mjs](scripts/test/entry-source.mjs) 的 nvim 入口在分片级 `before(session.start('nvim'))` / `after(session.stop())` 管理单个常驻编辑器，文件级 `describe` 顺序执行；[cli.mjs](scripts/test/cli.mjs) 增加 `--nvim`（默认 4 个运行时，nvim 单测超时 15s / 分片 15min）；分片复用 LPT 耗时调度与实时 reporter。
- **已验证**（Node 24.12.0）：`node scripts/test/cli.mjs --nvim -j 2` 下 2 个运行时并行、各启动 1 个 nvim（运行中 pgrep 计数=2），3 个探针文件 7 passed，结束后 nvim 0 残留；timings.json 记录 nvim 文件耗时供 LPT 使用。
- 探针文件：`src/__tests__/nvimProbe.test.ts` / `nvimProbe2.test.ts` / `nvimProbe3.test.ts`（可作 nvim lane 冒烟测试保留）。
- vim（setupVim）按指示搁置；本环境既有 vim channel 问题待排查。

### 编辑器测试逐文件改写（阶段三第 ③ 步，进行中）

**首个文件已完成**：[`src/__tests__/handler/hover.test.ts`](src/__tests__/handler/hover.test.ts)，连续 3 次全过（25 passed，含 3 个探针），无残留 nvim，tsc 0 错误。

**改写配方（历史记录，codemod-unit.mjs 已删除）**

1. 先跑 `codemod-unit.mjs`（vitest→node:test、expect→assert、钩子改名），再把头部改成 `// @coc-test nvim`（第三轮重构后头部已全部移除，lane 按路径分类）。
2. `import helper, { createTmpFile } from '../helper'` → `import { createTmpFile } from '../editorSession'` + `import { editorSuite, getSession } from '../editorSuite'`。
3. **src 导入保持原始写法不变**（`import workspace from '../../workspace'`）。运行器通过 `registerHooks`（`scripts/test/bundle-hooks.mjs`）把测试文件的相对 src 导入解析到 `globalThis.__cocBundle`（editor-runtime bundle）里的对应模块，不再改写测试里的 import。已迁移文件曾用 `const X = bundle['src/...'].default` 改写，已由 `revert-imports.mjs` 批量恢复。
4. `session` 在 `before` 钩子里赋值（`session = getSession()`），**不能在模块顶层**——node:test 中子 suite 的 describe 回调先于父级 before 执行，顶层取 session 会报 “editor session not started”。
5. 删除 `helper.setup()`（运行时已启动会话）和 `helper.shutdown()`（运行时统一 dispose，不执行 shutdown）。
6. `helper.X` → `session.X`；顶层 `describe('X', ...)` → `editorSuite('X', ...)`（嵌套 describe 保留并 import `describe`）。
7. 用作类型注解的 bundle 值（如 `HoverHandler`）用 `import type XType from '../../...'` 从源码路径导入（esbuild 擦除，无运行时开销），避免与本地常量重名。

### registerHooks 导入路由（2026-08-11 设计调整）

- **动机**：不再改写测试文件的 import。bundle 绑定到 `globalThis.__cocBundle`（`scripts/test/preload.cjs`），`scripts/test/bundle-hooks.mjs` 用 `node:module` 的 `registerHooks`（Node ≥ 22.9，已验证 24.12.0）拦截 CJS `require` 的相对 src 导入：
  - `resolve`：把测试文件里的 `../../workspace`、`../../util` 等相对路径解析到 `build/` 下对应文件，再映射成 bundle key（`src/workspace`、`src/util/index`；`src/__tests__` 下的测试内相对导入不拦截）。
  - `load`：对 `coc-bundle:<key>` 返回 `module.exports = globalThis.__cocBundle[<key>]`，让所有消费方拿到同一个 bundle 单例。
- 注入方式：`run.mjs` 在 nvim lane 给 `NODE_OPTIONS` 追加 `--import=<bundle-hooks.mjs>`，node:test 每个子进程都会先加载 hooks（unit lane 不注入，避免改变 unit 语义）。
- **收益**：插件/workspace/window 等单例身份全局一致，`list/mappings.test.ts` 的 `should toggle selection` 等此前在全量顺序下偶发的身份类 flaky 也消失。
- 回退脚本：`scripts/test/revert-imports.mjs`（一次性迁移工具，删除 bundle const 块、恢复原始 import、去掉与恢复导入重名的 `import type`）。

### 虚拟分片入口（不再拼接入口文件）

- **动机**：任何 lane 都不再把入口代码拼接成 `.cache/coc-test/entries/*.cjs` 落盘；入口源码是 JS 模板变量，由 `registerHooks` 在加载时注入。
- 实现：
  - [`scripts/test/entry-source.mjs`](scripts/test/entry-source.mjs)：纯函数 `generateEntrySource(batch, lane)` 生成 ESM 入口源码（`createRequire` + 同步 `require` 编译产物 + 分片级 before/after 与文件级 reset），并附带内联 sourcemap。
  - [`scripts/test/bundle-hooks.mjs`](scripts/test/bundle-hooks.mjs)：`resolve`/`load` 拦截 `file:///coc-entry/<lane>-<index>`，从 `COC_TEST_ENTRIES` 环境变量（run.mjs 序列化的批次清单）取 batch 并返回入口源码（`format: 'module'`）。
  - `run.mjs`：三个 lane 都 `run({ files: ['/coc-entry/<lane>-0', ...] })`，并注入 `COC_TEST_LANE`（unit/editor）；unit 子进程的 hooks 只注入入口、跳过 src→bundle 路由，保持编译产物直载语义。
  - `entries.mjs` 已删除（不再生成物理入口文件）。

### sourcemap 修复（编译产物需要 sourceMappingURL 注释）

- 现象：测试失败堆栈只显示 `build/.../test.js` 行号，不映射回 `.ts`；`module.findSourceMap` 返回 undefined。
- 原因：esbuild `sourcemap: 'external'` 只生成 `.js.map`，不在产物里写 `//# sourceMappingURL=` 注释，Node 的 `--enable-source-maps` 找不到 map。
- 解决：
  - `compile.mjs` 改用 `sourcemap: 'linked'`（写注释 + 外部 map），测试失败堆栈回到原始 `.ts`。
  - `bundle.mjs` 同样 `linked`，`compile.mjs` 把 `bundle.js.map` 一并复制到 build 根，bundle 内错误也能映射回 `src/`。
  - 内联 map 只对 ESM 模块生效（CJS hook 模块不读内联注释），所以虚拟入口是 ESM。

## 决策更新（2026-08-11）：非 unit 测试改为“每文件独立环境”

> 覆盖上文“运行时常驻：一个编辑器运行时连续测试多个文件”的早期决策。共享同一个 vim/coc bundle 跑完所有文件，跨文件副作用不可控（见问题 31-36），改为：

1. **每个非 unit 测试文件 = 一个独立环境**：独立子进程、独立 nvim、独立 coc bundle 单例。`cli.mjs` 的 nvim lane 默认把每个文件拆成单独 batch 并行执行；文件内测试仍共享运行时，由最外层 wrapper 在每个 case 的自定义 cleanup 完成后统一执行一次 `reset()`。
2. **测试基建打进 bundle 并作为全局变量**：
   - [`scripts/test/editor-session.mjs`](scripts/test/editor-session.mjs)：`EditorSession`（start/reset/stop + 完整工具面）、`editorSuite`、`getSession`/`setSession`、`createTmpFile`，作为额外模块以 key `test/editorSession` 打进 `bundle.js`（`bundle.mjs` 的 `EXTRA_MODULES`）。
   - [`scripts/test/preload.cjs`](scripts/test/preload.cjs)：绑定 `globalThis.__cocBundle` 后把上述函数暴露为 `globalThis.EditorSession`/`editorSuite`/`getSession`/`createTmpFile`。
   - 测试文件不再 import `src/__tests__/editorSuite|editorSession|sessionRegistry`（文件已删除）；类型由 [`src/__tests__/global.d.ts`](src/__tests__/global.d.ts) 提供（`declare global`），`npx tsc -p tsconfig.json --noEmit` 0 错误。
   - [`scripts/test/entry-source.mjs`](scripts/test/entry-source.mjs)：每个 batch 一个测试文件，入口 `before` 里 `session.start('nvim')` + `setSession`，`after` 里 `session.stop()`。
3. **单测超时统一 5s**；测试出错实时打印到 stderr（`run.mjs` 转发 `test:stderr`/`test:stdout`）。
4. **实测基线（Node 24.12.0）**：
   - nvim lane：`44 files, 1486 passed, 0 failed, ~31s`（默认并发 4）。
   - unit lane：`49 files, 954 passed, 0 failed, ~5s`。

## 迁移过程中遇到的问题与解决方法（续：nvim lane 共享环境期）

以下问题在“共享一个运行时跑全部文件”期间暴露，**均被每文件独立环境方案根除**，保留记录供后续参考。

31. **测试 `:cd` 经 DirChanged 污染 `Documents._cwd`，改变后续文件 workspace folder 解析**
   - 现象：refactor 的 `search` 测试 `cd <handler 目录>` 后，workspace.test.ts 的 `openLocalConfig` 把 folder 解析到 handler 目录（fallback cwd），`.vim` 不存在 → `showPrompt` 挂死（3 个测试 15s 超时）。
   - 排查：探针显示 `workspace.workspaceFolders=[handler]`、`documentsManager._cwd=handler`；`resolveRoot()`（documents.ts → workspaceFolder.ts）在 rootPatterns 为空时 fallback 到 `_cwd` 并 `addWorkspaceFolder`。
   - 解决（共享环境期）：reset() 还原 nvim cwd + 把 `documentsManager._cwd` 钉回 `process.cwd()`；独立环境后不再需要，已删除。

32. **窗口/标签页跨文件残留**
   - 现象：`core/features.test.ts` 的 `should have active editor` 期望 1 个窗口，实际 5 个；`tabpageid` 测试 `visibleTextEditors.length` 到不了 3。
   - 原因：`%bwipeout!` 只清 buffer 不清窗口/标签页布局，editors 单例保留旧窗口。
   - 解决（共享环境期）：reset() 加 `only!`/`tabonly!` 折叠到单窗口单标签页 + `editors.checkEditors()` 对账；独立环境后这些仍保留（同文件内跨测试仍需要）。

33. **editors 单例 tabIds/编辑器对账滞后**
   - 现象：reset 后 `tabIds` 残留旧 id，新 tab 的 `BufEnter` 通知未达（documents 未创建 → `getDocument(352)` undefined → editor 不创建）。
   - 解决：reset 里显式 `workspace.editors.checkEditors()`；共享环境期还依赖 `only!`/`tabonly!` 的 TabClosed 通知链，时序脆弱。

34. **测试 mock `nvim.call` 会污染 reset 的收尾**
   - 现象：`completion/features`、`handler/features` 的 `t.mock.method(nvim, 'call', () => undefined/null)` 让 reset 里 `nvim.call('getcwd')`/`fnameescape` 拿到 undefined → `:cd undefined`（E344），整文件失败。
   - 解决（共享环境期）：reset 用 `nvim.request('nvim_call_function', ...)` 绕过 `call` mock；独立环境后 cwd 还原已删除。

35. **被中止测试遗留 prompt 占住 Dialogs mutex**
   - 现象：测试超时中止时 `coc#dialog#prompt_confirm` 仍卡在 `getchar()`，RPC promise 永不 resolve，`Dialogs.mutex` 被永久占用，后续所有 dialog 排队挂死。
   - 解决：reset() 先 `nvim.input('<esc>')` 喂键让 getchar 退出，再 `dialogs.mutex.reset()` 兜底。

36. **session 崩溃后 transport disconnected 级联**
   - 现象：某个测试把 nvim 通道打崩后，其后所有文件（list/sources、mcp/*、handler/*）全部报 `transport disconnected` 或“did not finish before its parent”，一次全量 267 failed。
   - 解决：独立环境隔离后单个文件崩溃不再影响其他文件。

37. **`tabe` 不触发 BufEnter 导致文档未创建（共享环境特有时序）**
   - 现象：core/features 的 tab 测试在特定前置文件后，第二个 `tabe` 的 buffer 无 document，editor 不创建。
   - 排查：`createDocument` 调用记录显示只创建了旧 buffer；BufEnter 自动命令存在但通知未达。
   - 解决：属于共享环境下事件时序/状态污染，独立环境后未复现。

## 全部文件迁移完成（2026-08-11 第二轮）

剩余 27 个文件（client/integration、mcp/workspace-tools、modules/*、snippets/*、tree/treeView、vim.test.ts）全部迁移到 nvim/vim lane。本轮新增的工程问题和修复：

38. **suite 级 `before`/`after` hook 没有 `t.mock`**
   - 现象：workspace-tools.test.ts 的 `before` 里 `t.mock.method` 报 `Cannot read properties of undefined (reading 'method')`（根级 hook 有 mock，嵌套 describe 内的 hook 没有）。
   - 解决：用 `node:test` 模块级 `mock`（`import { mock } from 'node:test'`），在 `after` 里 `mock.restoreAll()`。
39. **bundle 的 ESM 导出不可 mock（冻结绑定）**
   - 现象：`t.mock.method(processes, 'runCommand', ...)` 报 `Cannot redefine property: runCommand`。
   - 解决：mock 更底层接缝 `child_process.exec`（`t.mock.method(cp, 'exec', (_cmd, _opts, cb) => cb(null, Buffer.from(root + '\n'), Buffer.alloc(0)))`），沿用问题 #10 的策略。
40. **codemod 对 `expect(actual, message).matcher(...)` 转换错误**
   - 现象：`expect(member in runtimeEnum, 'msg').toBe(true)` 被转成 `assert.strictEqual(member in runtimeEnum, 'msg', true)`，message 被当成 expected。
   - 解决：手动改成 `assert.ok(member in runtimeEnum, 'msg')`；`expect(row, 'msg').toBeGreaterThanOrEqual(0)` 同理改 `assert.ok(row >= 0, 'msg')`。新文件迁移后需全文搜索 `, \`...\`, true)` 之类的残留。
41. **`EditorSession.reset()` 补齐三个单例/窗口状态清理**
   - `cursors`：跨测试残留会话（Vim 复用 bufnr 后 `sessionsMap` 命中旧 session）→ reset 里调 `this.plugin.cursors.reset()`（实例挂在 plugin 上，`window.cursors` 是它的 getter，不是 bundle 模块默认导出）。
   - `diagnostic/manager`：reset 必须放在 `%bwipeout!` 之后、末尾 `await this.workspace.document` 之前——文件级 afterEach 若在 session reset 之后才 `manager.reset()`，会把 reset 末尾新建文档的 BufferSync item 清掉，导致后续测试 `buffers.getItem` 为空。
   - `winfixwidth`：`windo setl winfixbuf&` 扩展为 `winfixbuf& winfixwidth&`（treeView 窗口的窗口局部选项泄漏）。
42. **treeView cleanup 必须先于统一 reset**
   - 现象：`should emit visibility change event` 在顺序运行时 `close` 不触发 WinClosed——`treeView.dispose()` 用 notify 执行 `bwipeout!`，而 reset 的 `%bwipeout!` 跳过 unlisted buffer，残留树窗口（带 `w:cocViewId`）被下一个测试的 `coc#ui#create_tree` 复用（winid 不变、`:close` 对最后一个窗口 E444 静默失败）。
   - 解决：该文件的 `afterEach` 只负责 dispose；wrapper 的 `afterEach(reset)` 在测试文件 hooks 之后注册，因此统一 reset 必然最后执行。
43. **`expect(fn).toHaveBeenCalledWith([...])` 手写断言时多包一层数组**
   - 现象：Vitest 的 `toHaveBeenCalledWith([x])` 语义是“单参数等于 `[x]`”，`mock.calls[0].arguments` 本身是参数数组，需 `deepStrictEqual(calls[0].arguments, [[x]])`。
44. **vim lane 落地**
   - 本环境 vim 9.1 的 RPC 通道已可用（此前记录的 EPIPE 已消失）：`EditorSession.start('vim')` 探针通过。
   - `discover.mjs` 增加 `VIM_TESTS` 数组（当前仅 `vim.test.ts`）；`entry-source.mjs` 对 vim lane 用 `session.start('vim')`；`run.mjs` 注入 `VIM_NODE_RPC=1`；`bundle-hooks.mjs` 的 entry URL 正则支持 `vim`。
   - vim.test.ts 迁移后 128 passed；当前与 nvim lane 一样由 wrapper 做 per-test reset。
45. **`// @coc-test unit` 头残留**
   - codemod 的 `insertHeader` 会给没有头的文件加 `// @coc-test unit`，与手写 `// @coc-test nvim` 叠成两行，discover 取第一行把文件分到 unit lane。迁移后检查文件头只有一行目标头。

## 运行器重构（2026-08-11 第三轮）：去掉 lane 头与 --nvim/--vim

- 删除全部 120 个测试文件开头的 `// @coc-test ...` 注释。
- `discover.mjs` 改为纯路径分类：`src/__tests__/unit/` -> unit lane；`VIM_TESTS` 数组（`src/__tests__/vim.test.ts`）-> vim lane；其余 -> nvim lane。`ISOLATED_UNIT_TESTS`（configurationModel、factory）继续各自独占进程。
- `cli.mjs` 移除 `--nvim`/`--vim` 选项：默认 `node scripts/test/cli.mjs` 依次运行 unit、nvim、vim 三个 lane；`--unit` 只跑 unit lane；`--list` 列出全部可运行文件。
- `cli.mjs` 采用**两阶段滚动调度**：阶段 1 unit 用满 CPU 核数先跑完；阶段 2 nvim+vim 合并为单个 `runUnit` 调用（共享 reporter 与合并后的 `COC_TEST_ENTRIES` manifest，hooks 从入口 URL 推导 lane），并发上限 8，node:test 在文件完成后立即补入下一个；nvim/vim 批次按历史耗时**最长优先**。`-j` 同时覆盖两阶段并发。
- `entry-source.mjs` 改为字符串模板生成入口；`entries.mjs`、`codemod-unit.mjs` 已删除。
- **测试文件全内存编译**：src/__tests__ 由子进程内 esbuild `write:false` 编译并经 `registerHooks` 注入；`compile.mjs`、`buildDir` 已删除。**编辑运行时 bundle 由父进程构建一次并写入 `.cache/coc-test/bundle.js`（+ `bundle.js.map`）**，子进程直接 `require()`，绝不重复构建；`package.json` dependencies（28 个）打进 bundle 并导出 `pkg:<spec>`，hooks 把测试的包导入路由到 `coc-bundle:pkg:<spec>` 共用同一实例。磁盘上只有 bundle 文件与运行期状态（数据目录、`timings.json`）。
- 新增 3 个位置/时序修复：fs.test.ts 的向上遍历改用 `process.cwd()`；workspace `findUp` 与 features `workspaceFolderCheckCwd` 的编辑路径锚定到仓库根（nvim cwd 已不在仓库内）；`recreate editor on document reload` 改为等待 editor 追踪到重建后的 document（消除竞态 flake）。

### 第四轮：bundle 落盘 + 单例身份修复（2026-08-11）

- **bundle 只构建一次**：父进程 esbuild 构建 `.cache/coc-test/bundle.js`（`write:true` + `sourcemap: 'linked'`，`sourceRoot` 指回仓库根，`sourcesContent: false` 控制体积），子进程经 preload/hooks `require()` 该文件。曾尝试 SharedArrayBuffer（Node 子进程不共享，实测是复制语义）与 worker_threads（用户否决：全局对象干扰），最终按用户要求回到磁盘文件方案。
- **collectPackages 不再用 esbuild**：直接读 `package.json` 的 `dependencies` 生成 `pkg:<spec>` 导出（不再用 metafile/正则扫描，避免把字符串字面量里的 `require('dep')` 当包）。
- **双构建包钉死**：vscode-uri / vscode-languageserver-textdocument / vscode-languageserver-types 的 exports 有 import/require 两个构建（ESM vs UMD），入口 `require()` 与 src 的 ESM import 会打进两份 URI 类导致 `instanceof` 失败；bundle.mjs 加 esbuild 插件把这三个包（含子路径）全局钉到 require 构建。`mainFields: ['module','main']` 与生产构建一致（jsonc-parser 的 UMD 参数化 require 不能静态内联）。
- **CJS 函数导出兜底**：`which` 这类整个导出是函数的包没有 `default` key，`coc-bundle:` wrapper 的 `export default` 加 `__cocNs.default !== undefined ? __cocNs.default : __cocNs` 兜底。
- 全量验证（本机 Node 26）：unit 954 / nvim 2453 / vim 128 全绿，总耗时 **~43s**（含父进程一次 bundle 构建 ~300ms）。

### 第五轮：run() 直接传测试原路径 + ESM 编译（2026-08-11）

- **`entryFiles` 用测试文件原路径**：`run.mjs` 的 `runUnit(files, ...)` 直接把 `src/__tests__/.../*.test.ts` 交给 node:test，删掉虚拟 `/coc-entry/<lane>-<index>` 入口与批次 manifest（`entry-source.mjs`、`schedule.mjs` 删除）；`cli.mjs` 只按历史耗时排序文件列表，`-j`/滚动池语义不变。
- **测试编译为 ESM、去掉 prologue**：`compileTest` 不再注入 `createRequire`/`__filename`/`__dirname` 头（TDZ/行号偏移隐患）；测试里 256 处 `__dirname`/`__filename` 全部替换为 `import.meta.dirname`/`import.meta.filename`（Node ≥20.11 原生支持，`?raw` URL 下同样正确）。只有 3 个真正直接调用 `require()` 的文件（unit/factory、unit/modules-util、handler/workspace）由 `REQUIRES_DIRECT` 单独注入一行 `createRequire`。
- **编辑器 lane 的 session 包装**：node:test 同一层的顶层 `before` 是并发执行的（会与测试文件自己的 `before(getSession())` 竞争），所以 hooks 在加载编辑器测试文件时返回一个外层 `describe`：先 `before(session.start)`，再用 outer `beforeEach` 从第二个 case 开始执行 `session.reset()`，最后 `after(session.stop)`。测试文件用 `?raw` URL 获得独立模块身份（直接 import 原 URL 会命中缓存返回 wrapper 自身）。测试文件自己的 `afterEach` 仍先完成资源 cleanup；reset 放到下一个 case 之前，既保证隔离，也省掉文件最后一个 case 后无意义的 reset。
- **preload 在测试文件 load hook 内执行**：保证 `global.__TEST__`/env 先于任何 src 模块初始化（否则 `getConditionValue` 走生产分支，events debounce 变 100ms 导致 flake）；spawn 的 helper 子进程（如 bin/coc-mcp.js）不加载测试文件，不会受影响。
- 全量验证（本机 Node 26）：unit 954 / nvim 2453 / vim 128 全绿，总耗时 **~43s**。

### 第六轮：unit isolation:none worker pool（2026-08-12）

- unit 不再为每个文件创建 Node 子进程。父进程构建一次 bundle 后，把普通 unit 文件分配到固定 worker pool；每个 worker 安装自己的 `registerHooks`，再用 `run({ isolation: 'none', concurrency: false })` 顺序执行一批文件。
- workers 之间并行，`-j` 控制最大线程数；configurationModel、factory 因修改 registry/mock，继续各自独占 worker。
- 不在 CLI 主线程直接运行 unit：实测同线程 `isolation:none` 会让不同文件的 suites 共享并发根，fake timers/mock 互相影响并产生 3 个失败；worker 隔离 loader hooks、global、模块缓存，同时避免逐文件进程启动成本。
- worker 临时目录加入 `threadId`，同一 PID 下的并行 workers 不会共享或互删运行状态。
- Node 24.12.0 验证：49 files / 954 passed / 0 failed；12 workers 下 unit lane 冷启动约 **4.7s**、热运行约 **3.4s**（原进程模式约 6.1–6.5s）。

### 第七轮：editor reset / teardown profile（2026-08-12）

- profile 基线（Node 24.12.0，`-j 8`）：editor lane **35.2s**。累计 CPU 时间中 bundle require 约 26.1s、reset 约 31.9s、session start 约 15.5s、stop 约 5.6s；最慢文件仍是 client integration / dynamic、list sources 和 text synchronization。
- 32 个文件同时使用 `editorSuite` 自动 reset 和文件级 `afterEach(session.reset())`，部分 case 实际清理两次（`list/sources` 记录 104 次 reset）。reset 现统一到最外层 wrapper，`editorSuite` 只保留分组语义，文件级 hook 只做自身资源 cleanup。
- MCP document/editor/notifications/LSP、terminal、attach 等测试不再依赖前一个 case 留下的 document、diagnostics、subscription 或 terminal；相关 fixture 改为 `beforeEach` 显式建立。大文件 fixture 用幂等 helper 创建，避免依赖执行顺序又避免重复写入。
- 文件 teardown 不再等待 editor RPC `quit()`：先用 `terminate()` 快速结束该文件独占的 editor 进程，再等待 `services.stopAll()` 回收语言服务，防止残留子进程。
- 第一轮优化曾得到 editor lane **34.0s**、全量约 **39.0s** 的单次全绿结果；后续重复运行受并发争抢/机器负载影响可回到 38–43s，因此该数字只作为单次样本，不作为稳定提升结论。

### 第八轮：首轮轮询与调度优化（2026-08-12）

- `waitValue()` / `waitFor()` 的第一次轮询先等待一个 `setImmediate`，若立即命中则再让出一轮确认，避免为已就绪状态固定支付 20ms；未命中仍保持原有 20ms 轮询，不形成 busy loop。
- 修复被快速首轮检查暴露的测试时序假设：CodeLens 明确等待初次 debounced fetch；TreeView 容忍 selection 事件前的未定义状态；document reload 直接等待 workspace document 与 active editor 收敛到同一新实例；LanguageClient fixture 等当前 TextDocument 真正进入 synced openDocuments；list task 等 worker 进入 loading 后再验证 stop mapping；refactor 测试直接修改目标 buffer，并显式同步源/目标 Document，不依赖当前窗口或事件恰好已送达。
- 文件历史耗时改用 node:test 的 file-level `test:complete` 总耗时，leaf case 累加只作兼容兜底；LPT 因而包含 editor 启动、hooks、reset 和 teardown，不再低估生命周期开销重的文件。
- hooks 延迟加载 bundle：editor 测试和实际请求 `coc-bundle:`/外部 package 时才 `require()`；继承 hooks 的 helper 子进程不再无条件承担 bundle 初始化。
- 尝试把 reset 的 mode 检查压成一次 `<esc><cr>` 会使 snippets 在高负载下偶尔继承 insert mode，已撤回；reset 继续显式处理 normal/insert/阻塞 prompt 状态。
- 并发 9 的完整样本约 **42.6s**，且所有同时运行的 editor 文件都变慢；默认继续保持 `-j 8`。
- 全量绿色样本（Node 24.12.0，`-j 8`）：unit 954 / nvim 2453 / vim 128，editor lane **33.6s**，全量 **37.5s**。最后的 Document 同步修正另以 8 个最重文件并发压力验证（439 cases，10.5s）通过；重复样本仍会受机器负载影响，关注同机多次范围而不是单次绝对值。

### 性能基线（Node 24.12.0，12 核；阶段 2 并发由 -j 控制）

| 并发（-j） | 总耗时 | 备注 |
| --- | --- | --- |
| -j 6 | ~46s | reset 优化前，全绿 |
| -j 8（阶段 2 默认） | ~38s | 首轮轮询与调度优化后，全绿 |
| -j 9 | ~43s | 重复 profile 中 CPU/RPC 争抢加重，无收益 |
| -j 10 | ~42s | reset 优化前，偶发超时 flake |

- 关键优化：unit 先用满 CPU 核数（不与编辑器会话抢资源）、阶段 2 滚动补位 + 最长优先（减少收尾空档）、阶段 2 并发 8（当前机器的实测甜点；9 已出现整体变慢）。
- 每文件 nvim 会话生命周期约 285ms（start 229ms / stop 56ms）；70 个独立会话的测试本体是主要耗时。

### 启动延迟 profile（Node 24.12.0）

`node scripts/test/cli.mjs` 到第一个测试可见的耗时构成：

| 阶段 | 耗时 |
| --- | --- | --- |
| discoverTests | ~30ms | ~30ms |
| 父进程编译 | 无（全部在子进程内内存编译） |
| unit 首子进程启动（12 并发争抢，含子进程内 bundle 内存构建） | ~1.0-2.0s |

- 首事件延迟随 unit 并发线性上升（并发 1/4/8/12 ≈ 0.55s/0.65s/1.1s/1.45s）；unit 用满 CPU 核数时总耗时最短，但第一个测试出现较晚——这是两阶段的取舍。
46. **TypeScript 断言收窄/类型修正（沿用问题 #15）**
   - `assert.match(String(x), ...)` / `assert.ok(Number(x) > n)`：`nvim.call/getVar` 返回 `VimValue`/`unknown`，`assert.*` 不会自动收窄；`new Promise<void>(...)` 补泛型。

### 全量验证（Node 24.12.0）

- unit lane：`49 files, 954 passed, 0 failed, ~4s`。
- nvim lane：`70 files, 2453 passed, 0 failed, ~34s`（并发 8）。
- vim lane：`1 file, 128 passed, 0 failed, ~6-7s`（与 nvim 并行）。
- 全量 `node scripts/test/cli.mjs` 总耗时约 **39s**。
- 第四轮后本机（Node 26）：**~43s**（unit 4.3s / nvim 38.4s / vim 3.4s 并行）。
- `npm run lint:typecheck` 0 错误。
