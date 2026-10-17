# 桌面版安装/卸载前检测正在运行的 pi（issue #104）。
#
# 背景：Windows 下点窗口 × 只是隐藏到托盘，pi.exe 和它 fork 出来的 Node server
# 子进程仍在运行。旧版进程锁着安装目录里的文件时，NSIS 重装会在写
# Uninstall pi.exe 这一步弹「不能打开要写入的文件」中止/重试/忽略。
# electron-builder 默认会把这个文件（build/installer.nsh）同时插入
# 安装器和卸载器，两个入口都做同样的检测。
#
# 检测用系统自带的 tasklist + find（nsProcess 插件不在 electron-builder
# 自带的 NSIS 里，不引第三方依赖）。taskkill /T 顺带把 pi.exe 的子进程树
# （Node server、PTY 里的 bash）一起结束，避免孤儿进程继续锁文件。

!macro PI_CHECK_RUNNING
	piRunningCheck:
		nsExec::ExecToStack 'cmd /c tasklist /FI "IMAGENAME eq pi.exe" /NH | find /I "pi.exe"'
		Pop $R0
		StrCmp $R0 "0" 0 piNotRunning
		MessageBox MB_YESNOCANCEL|MB_ICONEXCLAMATION "检测到 pi 正在运行，请先完全退出（托盘图标右键 → 退出）后再继续。$\r$\n$\r$\n是 - 自动结束 pi 进程并继续$\r$\n否 - 我已手动退出，重新检测$\r$\n取消 - 中止" IDYES piKill IDNO piRunningCheck
		Abort
	piKill:
		nsExec::ExecToLog 'taskkill /F /T /IM pi.exe'
		Sleep 1500
		Goto piRunningCheck
	piNotRunning:
!macroend

!macro customInit
	!insertmacro PI_CHECK_RUNNING
!macroend

!macro customUnInit
	!insertmacro PI_CHECK_RUNNING
!macroend
