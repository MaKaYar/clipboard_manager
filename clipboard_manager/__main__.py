from clipboard_manager.app import ClipboardImageSaverApp


def main():
    app = ClipboardImageSaverApp()
    app.protocol("WM_DELETE_WINDOW", app.on_close)
    app.mainloop()


if __name__ == "__main__":
    main()

