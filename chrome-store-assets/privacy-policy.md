# 隐私政策

DevTailor 是一个本地开发工具。Chrome 扩展会和你本机运行的 DevTailor Hub 通讯。

DevTailor 不会把页面数据发送到托管的 DevTailor 服务。扩展只在你主动接管普通 http/https 页面后注入脚本；标记数据、实例选择、聊天展示会话、截图和保存的元素目标会保存在浏览器本地存储及本机 Hub 的数据目录中。

你选择运行的 AI Agent 可能会收到完成任务所需的用户消息、标记元素上下文、参考元素、截图和浏览器工具结果。请同时查看你所使用 Agent 的隐私行为。

### 参考元素采集什么

在页内工具条开启「参考元素」（快捷键 R）并点选某个页面元素后，扩展会采集并在浏览器本地保存：

- 该元素的一组**白名单计算样式**（如颜色、背景、字体、字号、间距、尺寸、边框、圆角、阴影）；
- 裁剪后的元素 HTML 结构；
- 该元素当前可见区域的截图（最长边缩到 800px 以内的 JPEG）。

### 参考元素不采集什么

- 不采集脚本、样式表、iframe 文档内容，以及 `onclick` 之类的事件属性；
- 不采集任何表单输入值：`input` 的 value、textarea 文本、selected/checked 状态、password/hidden 输入的内容、contenteditable 里的文字都会被移除或遮挡；
- 不采集超长 `data:` 串、账号密码、URL hash；页面 URL 中 token/key/secret/auth/session/code/password 等敏感查询参数的值会被替换为 `REDACTED`；
- 不在后台静默采集：只有你显式点选元素并保存时才会生成一条参考；采集列表只保存在浏览器会话存储里（最多 8 条），随浏览器会话结束而清除；
- 参考会随你在侧边栏主动发送的消息交给所选 AI Agent，除此之外不会发送到其它地方。

Credits:

- DOM Review — `https://github.com/AAnkacHH/web-review-extention` — MIT
- VisBug — `https://github.com/GoogleChromeLabs/ProjectVisBug` — Apache-2.0
- wechat-acp — `https://github.com/formulahendry/wechat-acp` — MIT
