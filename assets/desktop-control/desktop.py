"""One bounded desktop action, using JSON over stdin/stdout."""
import base64
import io
import json
import os
import subprocess
import sys
import tempfile
import time

from PIL import Image, ImageGrab

MAC = sys.platform == "darwin"
if MAC:
	import Quartz as Q
	from ApplicationServices import AXIsProcessTrusted
	from AppKit import NSRunningApplication, NSApplicationActivateIgnoringOtherApps
elif sys.platform == "win32":
	import ctypes
	import win32gui as gui
	import win32process
	try:
		ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
	except AttributeError:
		ctypes.windll.user32.SetProcessDPIAware()
else:
	raise RuntimeError("Desktop control requires macOS or Windows.")


def windows():
	if MAC:
		if not Q.CGPreflightScreenCaptureAccess():
			raise RuntimeError("Allow Screen Recording for the desktop helper in macOS System Settings.")
		rows = Q.CGWindowListCopyWindowInfo(Q.kCGWindowListOptionOnScreenOnly | Q.kCGWindowListExcludeDesktopElements, 0)
		for row in rows:
			b = row["kCGWindowBounds"]
			if row["kCGWindowLayer"] == 0 and b["Width"] > 1 and b["Height"] > 1:
				yield dict(id=row["kCGWindowNumber"], pid=row["kCGWindowOwnerPID"], title=row.get("kCGWindowName", ""), app=row.get("kCGWindowOwnerName", ""), box=[int(b[k]) for k in ("X", "Y", "Width", "Height")])
	else:
		handles = []
		gui.EnumWindows(lambda hwnd, _: handles.append(hwnd), None)
		for hwnd in handles:
			if gui.IsWindowVisible(hwnd) and not gui.IsIconic(hwnd) and gui.GetWindowText(hwnd):
				_, _, width, height = gui.GetClientRect(hwnd)
				x, y = gui.ClientToScreen(hwnd, (0, 0))
				yield dict(id=hwnd, pid=win32process.GetWindowThreadProcessId(hwnd)[1], title=gui.GetWindowText(hwnd), box=[x, y, width, height])


def target(request):
	row = next((w for w in windows() if w["id"] == request["id"]), None)
	if not row:
		raise RuntimeError("Window closed or minimized. List windows again.")
	return row


def front(row):
	if MAC:
		return next(iter(windows()), {}).get("id") == row["id"]
	return gui.GetForegroundWindow() == row["id"]


def snapshot(row):
	if MAC:
		with tempfile.TemporaryDirectory() as folder:
			path = os.path.join(folder, "window.png")
			subprocess.run(["/usr/sbin/screencapture", "-x", "-o", "-l" + str(row["id"]), path], check=True, timeout=5)
			with Image.open(path) as source:
				image = source.convert("RGB")
	else:
		image = ImageGrab.grab(window=row["id"]).convert("RGB")
	image.thumbnail((1440, 1080))
	buffer = io.BytesIO()
	image.save(buffer, format="JPEG", quality=80)
	return dict(window=row, size=list(image.size), image=base64.b64encode(buffer.getvalue()).decode("ascii"))


def run(request):
	action = request["action"]
	if action == "list":
		return [dict(id=w["id"], title=w["title"], app=w.get("app", "")) for w in windows() if w["title"]][:100]
	row = target(request)
	if action == "view":
		return snapshot(row)
	if row != request["window"]:
		raise RuntimeError("Window changed. View it again before acting.")
	if MAC and not AXIsProcessTrusted():
		raise RuntimeError("Allow Accessibility for the desktop helper in macOS System Settings.")
	from pynput import keyboard, mouse
	if not front(row):
		if MAC:
			app = NSRunningApplication.runningApplicationWithProcessIdentifier_(row["pid"])
			if app:
				app.activateWithOptions_(NSApplicationActivateIgnoringOtherApps)
		else:
			gui.SetForegroundWindow(row["id"])
		time.sleep(0.15)
	if not front(row) or target(request) != row:
		raise RuntimeError("Bring the selected window to the front, then view it again.")
	if action == "type":
		controller = keyboard.Controller()
		text = request["text"]
		for start in range(0, len(text), 16):
			if not front(row):
				raise RuntimeError("Focus changed during text entry. View the window to verify.")
			controller.type(text[start:start + 16])
		return {"done": True}
	if action not in ("click", "scroll"):
		raise ValueError("Unsupported action")
	x, y, width, height = row["box"]
	sw, sh = request["size"]
	px, py = request["x"], request["y"]
	if not (0 <= px < sw and 0 <= py < sh):
		raise ValueError("Coordinates outside snapshot")
	point = (x + int(px * width / sw), y + int(py * height / sh))
	if not MAC and gui.GetAncestor(gui.WindowFromPoint(point), 2) != row["id"]:
		raise RuntimeError("Another window covers this point.")
	if MAC:
		rows = Q.CGWindowListCopyWindowInfo(Q.kCGWindowListOptionOnScreenOnly | Q.kCGWindowListExcludeDesktopElements, 0)
		for item in rows:
			if item["kCGWindowNumber"] == row["id"]:
				break
			b = item["kCGWindowBounds"]
			if b["X"] <= point[0] < b["X"] + b["Width"] and b["Y"] <= point[1] < b["Y"] + b["Height"] and item.get("kCGWindowAlpha", 1) > 0:
				raise RuntimeError("Another window covers this point.")
		else:
			raise RuntimeError("Window is no longer visible.")
	controller = mouse.Controller()
	controller.position = point
	if action == "click":
		controller.click(mouse.Button.left)
	else:
		controller.scroll(0, request["steps"])
	return {"done": True}


if __name__ == "__main__":
	try:
		print(json.dumps(run(json.load(sys.stdin))))
	except Exception as error:
		sys.exit(str(error))
