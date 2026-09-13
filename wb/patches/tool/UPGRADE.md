# Upgrading TickTrade Intelligence Core to 3.6.1

Your knowledge, imports, snapshots and runtime records all live in the `data` folder. The upgrade
replaces only the program files and keeps `data` as it is.

1. Quit the running app (close its Terminal window or press Control-C in it).
2. Unzip `TickTrade-Intelligence-Core-3.6.1.zip`. It contains one folder, `TickTrade Intelligence Core`.
3. Move your existing `data` folder from the old app folder into the new one
   (drag `old folder/data` → `TickTrade Intelligence Core/data`).
   Optional: also move `.venv` if you created one.
4. Open the new folder and double-click `Start TickTrade.command`.
   If macOS says the file cannot be opened because it is from an unidentified developer,
   right-click it, choose **Open**, then **Open** again. This is needed once.
5. The Terminal prints the address (normally `http://127.0.0.1:8766`; a higher number if that port is
   busy). Open it in your browser. The version in the bottom-left corner should read v3.6.1.
6. Ollama must be running for the chat to answer; Docker Desktop must be running to start the app
   inside the tool. Both stop when the Mac shuts down and need to be started again.

If something fails, open `data/logs/errors.log`: every unexpected error is written there with the
details needed to fix it. Send that file with your report.
