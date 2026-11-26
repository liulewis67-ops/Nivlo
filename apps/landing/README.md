# StarDeskBox宣传落地页

静态页面，与桌面应用独立。没有构建步骤或第三方请求。

安装仓库依赖后，从仓库根目录运行：

```powershell
node apps/desktop/ui/node_modules/vite/bin/vite.js apps/landing --host 127.0.0.1 --port 4173 --strictPort
```

打开 http://127.0.0.1:4173/ 。可通过顶部按钮切换语言，也可以用 `?lang=zh` 或 `?lang=en` 分享指定语言的链接。

页面默认跟随系统深浅色设置。点击右上角的太阳或月亮可切换外观，选择会保存在当前浏览器。鼠标滚轮带有阻尼；触屏、键盘和滚动条保留原生行为。系统启用「减少动态效果」时会关闭阻尼和位移动画。

「捕获」演示是一段拖放场景：演示区进入视野后，虚拟光标会把示例链接拖进悬浮窗，再由访客把文件拖进去。卡片支持鼠标、触屏和触控笔拖动，拖到别处松开会弹回，按 Esc 取消；也可以聚焦卡片后按 Enter，让卡片自己飞进去。访客还能从电脑上把真实的文件、链接或文字拖到演示区，页面只读取文件名或一段简短文字，不会上传。全部收下后可以重新演示。

页面包含 Windows 0.1.3 下载入口及交互演示。示例数据只用于展示；演示不会调用桌面应用，也不会写入真实任务。下载入口直接指向 GitHub Release 的安装包文件，无需先打开发布页面；社交预览图使用 GitHub Pages 的绝对 URL。

推送到 `main` 会触发 `.github/workflows/pages.yml`，部署本目录到 <https://liulewis67-ops.github.io/StarDeskBox/>。首次需在仓库 Settings → Pages 中将 Source 设为 GitHub Actions；也可手动运行部署工作流。应在 Release 安装包发布成功后对外宣传下载地址。
