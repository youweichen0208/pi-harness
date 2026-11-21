"""Local stdio bridge. Only the server owns the Jupyter connection."""
import json
import os
import sys
from queue import Empty, Queue
from threading import Thread

target = sys.argv[1]
if target:
    sys.path.insert(0, target)
import ipykernel
from jupyter_client import KernelManager

km = KernelManager(kernel_name="python3")
# Launch the selected interpreter even when the user's python3 kernelspec differs.
km.kernel_spec.argv = [sys.executable, "-B", "-m", "ipykernel_launcher", "-f", "{connection_file}"]
km.start_kernel(independent=False, env={**os.environ, "PYTHONPATH": target, "MPLBACKEND": "module://matplotlib_inline.backend_inline"})
client = km.client()
client.start_channels()
def send(value):
    payload = json.dumps(value)
    if len(payload) > 8 * 1024 * 1024:
        raise RuntimeError("Cell output exceeds 8 MiB")
    print(payload, flush=True)
try:
    client.wait_for_ready(timeout=25)
    pending = Queue()
    def listen():
        for line in sys.stdin:
            cmd = json.loads(line)
            if cmd.get("interrupt"):
                km.interrupt_kernel()
            else:
                pending.put(cmd)
        km.interrupt_kernel()
        pending.put(None)
    Thread(target=listen, daemon=True).start()
    while True:
        request = pending.get()
        if request is None:
            break
        msg_id = client.execute(request["code"], allow_stdin=False)
        while True:
            try:
                msg = client.get_iopub_msg(timeout=1)
            except Empty:
                if not km.is_alive():
                    raise RuntimeError("Kernel exited")
                continue
            if msg["parent_header"].get("msg_id") != msg_id:
                continue
            kind, content = msg["msg_type"], msg["content"]
            if kind == "status" and content["execution_state"] == "idle":
                send({"done": True})
                break
            if kind == "execute_input":
                send({"count": content["execution_count"]})
            if kind in ("stream", "error", "display_data", "execute_result", "clear_output"):
                send({"output": {"output_type": kind, **content}})
finally:
    client.stop_channels()
    km.shutdown_kernel(now=True)
