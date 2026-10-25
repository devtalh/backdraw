---
description: Finish the one-time Backdraw setup (native host and the Chrome extension)
disable-model-invocation: true
---

The Backdraw plugin gives Claude the image tools, but the browser side needs a one-time setup on
this Windows PC: the native messaging host and the Backdraw Chrome extension.

Tell the user to run this in their own terminal (PowerShell or cmd), not from this session:

    npx backdraw@latest setup --clients=none

`--clients=none` leaves the MCP clients alone, because the plugin already provides the server.
Setup copies Backdraw to %USERPROFILE%\.backdraw, registers the host for the installed browsers,
opens the extension folder and chrome://extensions, and waits until the user has clicked
"Load unpacked" and picked that folder. It prints "✓ Ready" when the extension is connected.

Then the user clicks the Backdraw icon in Chrome and picks a ChatGPT Project. If something does not
work, `npx backdraw@latest doctor` checks every piece and says how to fix it.

Do not run these commands yourself, and wait for the user to say they are done.
