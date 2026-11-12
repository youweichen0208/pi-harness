# 表格结构编辑：恢复入口、统一坐标、补回归

<!-- toc -->
- [Considered Options](#considered-options)
- [Consequences](#consequences)
<!-- /toc -->

富文本编辑器里的表格需要能改形状（增删行列）。这项能力**曾经存在**：`4014847` 发布了单元格浮栏 `fp-table-tools`，六个按钮齐全。随后 `6fc7ab1`（v1.2.0）重构格式工具栏时把浮栏整块删除，`fp-table-tools` 的样式一并消失；`editTable()` 的实现和六个 i18n 文案（`richAddRow`／`richAddColumn`／`richRemoveRow`／`richRemoveColumn`／`richRemoveTable`／`richTableTools` 中英双份）**都留在仓库里**，成了永不渲染的孤儿。同期 `docs/ui-design.md` 改写为「表格不显示操作浮栏，点击外边框选择整表」，让这扇门在文档层面也关上了——下一次重构照着文档走，就不会有人发现能力丢了。

用户报告「无法编辑表格」成立，但根因不是功能缺失，而是**一次静默的能力删除**：实现还在，只有入口没了。

我们决定：为表格建立**独立的表格目标状态**（整表／某行／某列，与文本选区解耦），把删列／删行／左列／右列／上行的入口补回来，并把坐标换算收口到一个纯函数模块 `web/src/table-geometry.ts`，同时补浏览器 E2E 断言存盘重开后的列数。

方案 α（采用）的语义分离：

- **表头格**是普通 `<th>`：单击选中整列，双击编辑列名。
- **数据行首格**是不可编辑的 gutter（`data-rich-ui` + `contenteditable=false`）：单击选中该行。
- **选中整表**保持原手势（点击外框内侧 6px，或选中后 Delete），**不为它新增触发点**。
- 右键单元格打开结构菜单，作用于当前行／列高亮，或右键所在格的逻辑行／列。
- 菜单顺序：上方插入行、下方插入行、左侧插入列、右侧插入列、删除行、删除列、删除表格，破坏性操作以分隔线隔开。

## Considered Options

-   **恢复原格内浮栏 `fp-table-tools`**：一次到位、已验证过，但直接违反当时写进 `ui-design.md` 的「不显示操作浮栏」，要么改设计要么改文档；浮栏还会遮住单元格内容——被否。
-   **表头首格兼做 gutter（整表选择）**：可省掉表头／数据行的不对称，但会把「选中整表」这个破坏性动作绑到表格最容易被点击的左上角，误触即整表选中、再按 Delete 就删表——被否。
-   **不引入 gutter，行列选择只走右键菜单**：零布局风险，但砍掉了用户明确要求的「点行首选行」——被否。
-   **各处就地 `cellIndex - 1` 换算**：改动分散在 7 处（`editTable`、状态列判定、Tab 遍历、空表判定、模板插入、序列化、焦点落点），下次任何一处被改都会静默错列——被否。

## Consequences

- 表头列数与数据列数**不相等**（数据行多一个 gutter 格）。这一不对称必须由 `table-geometry.ts` 统一换算，任何直接访问 `row.cells[i]` 或 `cell.cellIndex` 的新代码都是缺陷。
- `readRichDocument` 除现有的 `data-table-selected` 外，还必须剔除行／列高亮标记，否则编辑器状态会漏进保存的 Markdown。
- 删行保留下限（表头行不可删、至少保留一行数据）与删列下限（至少保留一列），不满足时按钮 `disabled` 并给出说明，**不再静默无反应**——静默失败是「以为坏了」的第二来源。
- 整表选中维持原手势，不因本次改动变得更易误触。
- 回归由新增浏览器 E2E 守护：加列、加行、删列、删行后存盘重开，断言 Markdown 分隔行的列数。

## 后续修正：菜单「点了没反应」

上线后用户反馈「表格仍然不能右键编辑」。实际是四条独立缺陷叠在同一个入口上，任何一条都足以让菜单看起来没打开、或打开了也不生效：

1. **表头选列从未生效**：判定写成 `!event.detail`，但按下与抬起都是 `detail === 1`，只有程序合成的点击才是 0。改为在按下时判断「是否已存在用户自己持有的选区」，并记住被高亮替换掉的 `<th>`。
2. **右键的那一下会关掉它自己打开的菜单**：编辑器根上的原生 `mousedown` 先于 React 的根派发执行并重绘高亮，文档级 `dismiss` 看到的已不是表格节点，于是 `setTableMenu(null)`。`dismiss` 改为只认「按在菜单外且不在该表的格子上」。
3. **菜单在自身按下事件里被编辑器接管**：portal 挂在 `.wiki-document-root` 内，`preventDefault` 只挡浏览器不挡 React，收起阶段获得的点击让菜单在动作执行前消失。菜单容器改为同时 `stopPropagation`。
4. **删列之后光标丢失**：结构编辑用 `insertHTML` 整表替换，落点格被 `placeCaretIn` 落在一个没有子节点的空格上，浏览器随即把光标抛回前文。落点格补 `<br>` 占位，并优先把原光标还原到未被改动的同一段文本里。

另有三处语义随之收口：

- 右键打开菜单时**把光标落到目标格**，动作按该格解析，菜单显示什么就作用什么。
- 整表框选只认外框 6px 与行首 gutter；表头按下只负责选列，两者不抢同一次按下。
- 菜单只由「按在菜单外且不在该表格子上」「滚动」「Escape」关闭；Escape 由文档级监听处理，因为菜单在 portal 里，编辑器的按键处理收不到。

回归扩到 `tests/wiki-table-edit-test.mjs`：结构编辑后接着输入必须落在目标格，Escape 必须关掉菜单，数量为 2 时一次插入两行。

菜单外形按语雀重做：四行「向上／向下／向左／向右插入」带箭头图标、数量框与单位，分隔线后是三项删除。补做时又踩到三个同源的坑——编辑器的 `onMouseLeave` 在指针移出内容区时关菜单、`onBlur` 在焦点进菜单时关菜单、数量框的按下事件冒泡到菜单容器被 `preventDefault` 吃掉导致拿不到焦点；三者都在“菜单打开期间”让位给菜单解决。`tests/wiki-table-selection-test.mjs` 在外框 `+1px` 处点选整表一条在 `HEAD` 上同样失败（与本次无关，待单独排查）。

双击改名是第五条独立缺陷，且在上述四条修复后依然存在（用户再次报告“表格仍然双击不了”）：`onMouseDown` 的表头选列对双击的**两次按下**都执行了 `preventDefault`，原生光标落点被拦掉两次；而 `onClick` 里 `event.detail === 2` 的「改名」分支只清除列高亮——整条链路没有任何一环负责把光标放回表头，注释里“caret lands in the text”的前提正是被同文件自己的按下处理取消掉的。修复与右键菜单同构（谁拦了原生光标，谁就手动放回）：释放时 `detail ≥ 2` 清除高亮、聚焦编辑器、`placeCaretIn` 式地把光标落回表头并**选中整个列名**，一次双击加输入即完成改名；只读态维持原行为（仅清高亮）。回归：双击表头后输入，断言存盘后的表头行（`tests/wiki-table-edit-test.mjs`）。

第六条是“右击不了”的真相：用户截图里列高亮已画、菜单却未开——那不是菜单坏了，而是编辑器正处于**只读态**（`WikiWorkbench` 的 `editorBusy`：会话流式回复、加载、保存、wiki 索引扫描期间整篇文档转只读，`onContextMenu` 开头即 `return`）。真正的缺陷是**反馈自相矛盾**：`onMouseDown` 的表头选列与行首 gutter 没有 readOnly 守卫，只读期间照常画列／行高亮，表面假装可交互，结构手势却全被拒——用户自然把“没菜单”读成“又坏了”。修复：只读期间按下不画任何表格目标（表头不选列、gutter 不选行），gutter 按下回落到外框手势，**整表选择保留**（那是复制手势，只读下仍有用）；流结束后全部手势恢复。只读期间右击会得到浏览器原生菜单而非表格菜单，这是预期行为。回归：`tests/wiki-table-readonly-test.mjs`（慢流 SSE fixture：流式中无菜单、无高亮绘制、gutter 转整表选择，流结束后手势恢复）。

第七条是“菜单出现在后面、不在一层”：单文件文档弹窗 `.wiki-document-dialog` 是 `showModal()` 的原生 `<dialog>`，它的 `::backdrop` 绘制在浏览器 **top layer**；而表格菜单的 portal 目标写死 `document.body`，留在普通层——于是被灰罩压住、看着在后面，且 `elementFromPoint` 命中下层单元格，**收不到任何点击**。仓库里其余六个同类浮层（slash 菜单、格式浮栏、`WikiToolbar` 两种、选区菜单、图片放大、阅读浮层）都写 `document.querySelector(".wiki-document-dialog") ?? document.body`，只有表格菜单是例外。修复：统一成同一表达式。回归：`tests/wiki-float-layer-test.mjs`（断言菜单在 dialog 内、`elementFromPoint` 命中自身，并验证插入列真正写进文件）。

第八条是「颜色不一」与「再点一次右键不关」：L 形高亮（行目标 + 列目标）本身是设计，但两处让它读成渲染错乱——**关闭菜单从不清除已画的目标**（实测关闭后仍残留 `col:4 / row:1`），且**行首 gutter 不在行高亮范围内**（保留灰底），一行里于是同时出现蓝、白、灰三种颜色。修复：所有关闭路径（Escape、滚动、表外按下、右键切换）统一走 `closeTableMenu()`，关闭即 `paintTableTarget(null, null, null)`；`tr[data-row-target] td[data-rich-gutter]` 补 `background-color: var(--accent-soft)`，让被选中的行连 gutter 一起成为连续色带（用 `background-color` 而非 `background` 简写，以保住 `background-clip: content-box` 的内缩形状）。回归：`tests/wiki-table-target-band-test.mjs`。

同一轮补上「第二次右键关闭」：此前同一目标再三右键只是重新 `setTableMenu`，菜单永不消失——而按在目标表格子上的按下事件被显式排除在 dismiss 之外（否则菜单会被自己的打开事件拆掉），所以没有任何手势能关它。现在右键落在菜单当前作用的同一「表 + 行 + 列」时改为 dismiss。回归并入 `tests/wiki-table-edit-test.mjs`。

第九条是「蓝色太多」：右键后画的是**整行色带 + 整列色带 + 表头格**，用户看到一层层蓝，要求「只高亮那一块」。语义上确实不需要那么多：菜单作用的就是该格所在的行与列，而光标已经被放进该格（`placeCaretIn`），行／列已由光标自身指明。现在右键只给该格打 `data-cell-target`（`--accent-soft`），不再画任何色带；行色带与列色带仍保留给**显式选择手势**——行首 gutter 单击选整行、表头单击选整列，那两个手势的目的本来就是「选中整行／整列」，色带是它们的正确答案。关闭菜单仍统一 `closeTableMenu()` 清空三种标记。回归：`tests/wiki-table-cell-target-test.mjs`（断言只有被右键的那一格变蓝，无表头、无行带、无列带，关闭后全部清空）。

第十条是「列3 有 2 列」：用户看到表头只有 3 个标签，数据行却有 4 列，最后一列没有表头。根因是上面 Consequences 里那条「表头列数与数据列数不相等」——`syncGutters` 刻意不给表头加 gutter（为了让表头格能单击选列、双击改名），于是**表头行比数据行少一格**。浏览器按列索引对齐，第 1 视觉列同时容纳「表头首格」和「数据行首格（gutter）」，后果有两个：gutter 被撑到表头首格的宽度（实测 110px，应 14px），且**每个表头标签都落在它命名的那一列的左边一列**（实测 `列1` 正下方是 gutter、`列2` 正下方是原 `列1` 的内容）。所以「最后一列没有表头」并不是多出来一列，而是整排表头左移了一列。

修复是把不对称补成全对称：**表头行也带一个 14px 的 gutter**，且刻意做成 `<th data-rich-gutter data-rich-ui contenteditable=false aria-hidden>`——用 `th` 是为了让 `isHeaderRow`（按首格标签判定）与表头语义不变，`data-rich-ui` 保证 `readRichDocument` 整体剔除、永不进 Markdown。随之收口三处：`isHeaderRow` 跳过首格 gutter 再看标签；`dataColumn`/`cellIndexFor` 的偏移成为**统一规则**（表头与数据行同构，`table-geometry.ts` 原先「表头无 gutter」的前提被删掉）；`decorateWikiTables` 的状态列判定改用逻辑列而非 `header.cellIndex`。表头 gutter 是纯对齐部件：不参与单击选列、双击改名、右键菜单，按下时回落到外框手势（只读态下仍可整表选择复制）。回归：`tests/wiki-table-alignment-test.mjs`（断言每个表头标签正下方就是它命名的那列、两侧 gutter 均为 14px、表头与数据行格数相等）。

第十一条是「编辑不了列名」：用户点表头（`列1/列2/列3` 就是模板写下的列名），单击只选中整列、第二次单击仍然不进去，于是那一行看着是死的。原方案（ADR 开头 α）定的是 Excel 模型：**单击选列、双击改名**；这个模型对「改列名」这种日常编辑太重——列名本来就是一个可编辑的文本格，用户第一反应是点进去改字，而单击永远进不去、且没有任何提示。

改为：**表头格单击即落光标**，与普通单元格一致，点进去直接改字；**列选择挪到表头格顶部 6px 带**（与整表外框同一套 6px 手势），右键结构菜单仍是另一条路。只读态下这条带不画任何目标，按下降到外框手势（整表选择保留给复制）。顺带收口一处：任何一次非表头的按下都会清掉已画的表格目标——结构选择是「一次性目标」，不是编辑期间要保持的模式。回归：`tests/wiki-table-header-edit-test.mjs`（单击表头落光标并改名写盘、顶部带仍选列、按下数据格清除列带）。

第十二条是「表格看起来没做好」的三处视觉缺陷，来自样式串味而非结构：① `styles.css` 后段把 `th` 背景改成 `--bg-elev`（纯白），覆盖了前面 `thead` 的 `--bg-elev2` 浅灰，表头与正文同色；② 富文本根节点同时带 `.msg-text`（聊天正文样式），于是聊天气泡表格的 `.msg-text thead th { font-size: 12px }` 压过文档表格，列名比正文更小更淡——层级倒置；③ `insertColumn` 刻意给新列留空表头（怕把「Column」写进用户 Markdown），结果新列是一个**没有列名的列**，在真实列名旁边读起来就是表格坏了。修复：`th` 恢复 `--bg-elev2` 底、显式把字号钉回与正文一致（层级交给底色与字重，不再靠「更小更淡」）；新列按 `/table` 模板的约定命名为「列 N」，取该表现有列名里的最大编号 +1，既不留空表头也不重复。回归：`tests/wiki-table-header-edit-test.mjs` 增加表头底色/字号/字重断言，`tests/wiki-table-edit-test.mjs` 增加「插入列必须带列名、表头行没有空单元格」断言。

第十三条是「左边这条灰的是什么」：行首 gutter 一直没有任何说明——`aria-hidden`、无 role、无 tooltip，唯一线索是 hover 变蓝；用户截图圈着它问「这是什么」。更糟的是它上下两段**外观完全相同、行为却不同**：表头行的占位条按下去会穿透到「整表框选」手势（因为它是 `th` 对齐占位格），数据行的条却只选中那一行。同一个视觉、两套语义，正是又一次「看起来能用、用起来不对」。

按「同一外观必须对应同一语义」收口：表头占位条改为**惰性装饰**——`cursor: default`、去掉 hover 变色、无 tooltip，按下直接 `preventDefault()` 返回，不再隐藏地选整表；数据行条成为明确控件——`cursor: pointer`、hover 变蓝、`title` 为「选择整行」（i18n `richSelectRow`，随会话语言），点击选中该行为表格目标。两条仍共用 14px 定宽与 `background-clip: content-box` 的内缩形状，`data-rich-ui` 保证不进 Markdown。回归：`tests/wiki-table-gutter-affordance-test.mjs`（断言两条的 cursor/title 不同、表头条按下无任何变化、数据条按下选中该行、提示文字与 gutter 都不落盘）。
