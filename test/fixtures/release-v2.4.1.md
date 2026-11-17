**Install with one command:**

```
npx backdraw@latest setup
```

Setup installs Backdraw into `%USERPROFILE%\.backdraw`, registers your browsers, adds Backdraw to the MCP clients you pick, and then waits while you load the extension. Loading the extension is the only step left to you.

New in 2.4.1: ChatGPT's message box stays clean. Backdraw no longer leaves its prompt behind as a draft after a job.

### Fixed

- After a job, the bridge clears its own prompt from ChatGPT's message box. ChatGPT keeps the
  unsent text of a new chat as a draft that is shared between pages and survives reloads, so the
  prompt stayed there. The cleanup checks the job's start page and the ChatGPT home page, clears
  only text the job wrote, and logs every exit. It skips a tab you are looking at. (#24)
- The bridge's own minimized window now closes after a job. When no Chrome window was open, its
  only tab was always active and was never closed. (#25)

### Docs

- The README shows the animated GIF and sprite features up front, with an example sprite GIF made
  with `animate_sheet` from a ChatGPT sprite sheet. The npm description and keywords mention
  animated GIFs and sprites. (#23, #25)

### Update
- **Quick install:** run `npx backdraw@latest setup` again (reload Backdraw at `chrome://extensions` if setup asks), then restart your MCP client.
- **Manual install:** run `git pull`, then `node install.js`, and reload the extension.

Full list: [CHANGELOG.md](https://github.com/devtalh/backdraw/blob/v2.4.1/CHANGELOG.md)

Not affiliated with OpenAI or Anthropic. Automating the ChatGPT web page may conflict with OpenAI's terms. Use Backdraw for personal use, with your own account, at your own risk.
