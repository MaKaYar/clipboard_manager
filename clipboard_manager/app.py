from __future__ import annotations

import json
import os
import queue
import threading
import time
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from clipboard_manager.clipboard import get_clipboard_image, get_clipboard_signature
from clipboard_manager.config import (
    APP_NAME,
    HISTORY_FILE,
    LOG_POLL_MS,
    MAX_FOLDER_HISTORY,
    MIN_WINDOW_SIZE,
    POLL_INTERVAL_SEC,
    WINDOW_GEOMETRY,
)


class ClipboardImageSaverApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title(APP_NAME)
        self.geometry(WINDOW_GEOMETRY)
        self.minsize(*MIN_WINDOW_SIZE)

        # State
        self.history_file = HISTORY_FILE
        self.save_folder = tk.StringVar(value="")
        self.folder_history = self._load_folder_history()
        self.is_running = False
        self.worker_thread: threading.Thread | None = None
        self.stop_event = threading.Event()
        self.last_image_bytes = None
        self.log_queue: queue.Queue[tuple[str, str]] = queue.Queue()
        self.clipboard_lock = threading.Lock()

        self._build_ui()
        self._poll_log_queue()

    def _load_folder_history(self) -> list[str]:
        if not self.history_file.exists():
            return []
        try:
            with self.history_file.open("r", encoding="utf-8") as file:
                data = json.load(file)
                if isinstance(data, list):
                    return data
        except (json.JSONDecodeError, OSError):
            pass
        return []

    def _save_folder_history(self):
        self.history_file.parent.mkdir(parents=True, exist_ok=True)
        with self.history_file.open("w", encoding="utf-8") as file:
            json.dump(self.folder_history, file)

    def choose_folder(self):
        folder = filedialog.askdirectory(title="Select a folder for saving images")
        if folder:
            self.save_folder.set(folder)
            self._log(f"Folder chosen: {folder}")
            if folder not in self.folder_history:
                self.folder_history.insert(0, folder)
                if len(self.folder_history) > MAX_FOLDER_HISTORY:
                    self.folder_history.pop()
                self._save_folder_history()

    def _build_ui(self):
        main = ttk.Frame(self, padding=12)
        main.pack(fill="both", expand=True)

        # Folder row
        folder_frame = ttk.LabelFrame(main, text="Save folder", padding=10)
        folder_frame.pack(fill="x")

        self.folder_entry = ttk.Entry(folder_frame, textvariable=self.save_folder)
        self.folder_entry.pack(side="left", fill="x", expand=True)

        ttk.Button(folder_frame, text="Browse…", command=self.choose_folder).pack(side="left", padx=(8, 0))
        ttk.Button(folder_frame, text="History", command=self.show_folder_history).pack(side="left", padx=(8, 0))

        # Controls row
        ctrl = ttk.Frame(main, padding=(0, 10, 0, 0))
        ctrl.pack(fill="x")

        self.start_btn = ttk.Button(ctrl, text="Start", command=self.start)
        self.start_btn.pack(side="left")

        self.stop_btn = ttk.Button(ctrl, text="Stop", command=self.stop, state="disabled")
        self.stop_btn.pack(side="left", padx=(8, 0))

        ttk.Button(ctrl, text="Open folder", command=self.open_folder).pack(side="left", padx=(16, 0))

        # Status
        self.status_var = tk.StringVar(value="Ready. Choose a folder and press Start.")
        status = ttk.Label(main, textvariable=self.status_var)
        status.pack(fill="x", pady=(8, 6))

        # Log
        log_frame = ttk.LabelFrame(main, text="Log", padding=10)
        log_frame.pack(fill="both", expand=True)

        self.log_text = tk.Text(log_frame, height=10, wrap="word")
        self.log_text.pack(fill="both", expand=True)
        self.log_text.configure(state="disabled")

        note = ttk.Label(
            main,
            text="Saves images that appear in the clipboard (screenshots, copied pictures).",
        )
        note.pack(fill="x", pady=(8, 0))

    def open_folder(self):
        folder = self.save_folder.get().strip()
        if not folder:
            messagebox.showinfo("No folder", "Select a folder first.")
            return
        if not os.path.isdir(folder):
            messagebox.showerror("Error", "Folder does not exist.")
            return
        os.startfile(folder)

    def start(self):
        folder = self.save_folder.get().strip()
        if not folder:
            messagebox.showwarning("Folder required", "Choose a folder to save images.")
            return

        try:
            os.makedirs(folder, exist_ok=True)
        except Exception as exc:
            messagebox.showerror("Error", f"Could not create/open folder:\n{exc}")
            return

        if self.is_running:
            return

        self.is_running = True
        self.stop_event.clear()
        self.last_image_bytes = get_clipboard_signature(self._log, self.clipboard_lock)

        self.start_btn.configure(state="disabled")
        self.stop_btn.configure(state="normal")
        self.folder_entry.configure(state="disabled")

        self.status_var.set("Running: watching clipboard…")
        self._log("=== START ===")

        self.worker_thread = threading.Thread(target=self._worker_loop, daemon=True)
        self.worker_thread.start()

    def stop(self):
        if not self.is_running:
            return

        self.stop_event.set()
        self.is_running = False

        self.start_btn.configure(state="normal")
        self.stop_btn.configure(state="disabled")
        self.folder_entry.configure(state="normal")

        self.status_var.set("Stopped.")
        self._log("=== STOP ===")

    def _worker_loop(self):
        folder = self.save_folder.get().strip()

        while not self.stop_event.is_set():
            img = get_clipboard_image(self._log, self.clipboard_lock)
            if img is not None:
                try:
                    current_bytes = img.tobytes()
                    if current_bytes != self.last_image_bytes:
                        self.last_image_bytes = current_bytes
                        filename = self._make_filename()
                        path = os.path.join(folder, filename)
                        img.save(path, "PNG")
                        self._log(f"Saved: {path}")
                        self._set_status(f"Saved: {filename}")
                except Exception as exc:
                    self._log(f"Save error: {exc}")
                    self._set_status("Save error (see log).")

            time.sleep(POLL_INTERVAL_SEC)

    def _make_filename(self) -> str:
        folder = self.save_folder.get().strip()
        existing_files = [f for f in os.listdir(folder) if f.startswith("img_") and f.endswith(".png")]
        if existing_files:
            numbers = [int(f.split("_")[1].split(".")[0]) for f in existing_files if f.split("_")[1].split(".")[0].isdigit()]
            next_number = max(numbers) + 1 if numbers else 1
        else:
            next_number = 1
        return f"img_{next_number}.png"

    def _log(self, msg: str):
        print(msg)
        self.log_queue.put(("log", msg))

    def _set_status(self, msg: str):
        print(msg)
        self.log_queue.put(("status", msg))

    def _poll_log_queue(self):
        try:
            while True:
                kind, msg = self.log_queue.get_nowait()
                if kind == "log":
                    self.log_text.configure(state="normal")
                    self.log_text.insert("end", msg + "\n")
                    self.log_text.see("end")
                    self.log_text.configure(state="disabled")
                elif kind == "status":
                    if self.is_running:
                        self.status_var.set(msg)
        except queue.Empty:
            pass

        self.after(LOG_POLL_MS, self._poll_log_queue)

    def on_close(self):
        self.stop_event.set()
        self.destroy()

    def show_folder_history(self):
        history_window = tk.Toplevel(self)
        history_window.title("Folder history")
        history_window.geometry("400x300")

        for folder in self.folder_history:
            ttk.Button(
                history_window,
                text=folder,
                command=lambda f=folder: self._select_folder_from_history(f, history_window),
            ).pack(fill="x", pady=2)

    def _select_folder_from_history(self, folder: str, history_window: tk.Toplevel | None = None):
        self.save_folder.set(folder)
        self._log(f"Folder selected from history: {folder}")
        if history_window is not None:
            history_window.destroy()

