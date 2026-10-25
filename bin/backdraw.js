#!/usr/bin/env node
'use strict';
// The `backdraw` command (npm package bin): setup, doctor, uninstall, and every cli.js command.
//   npx backdraw@latest setup
const readline = require('readline');
const { parseArgs } = require('../lib/args');
const cli = require('../cli');

const VERSION = require('../package.json').version;

const HELP = `Backdraw ${VERSION}: let Claude generate images with your own ChatGPT account in a background Chrome tab.

Usage: backdraw <command>
  setup [--yes] [--clients=a,b] [--browser=chrome|edge|brave|chromium] [--no-wait]
                                  Install or update, register the browsers and MCP clients, load the extension
                                  clients: claude-code, claude-desktop, codex, cursor, vscode, gemini
  doctor [--fix]                  Check the install; --fix repairs registrations
  uninstall [--dry-run]           Remove the registrations (your images and settings stay)
  --version                       Print the version
${cli.USAGE.split('\n').slice(1).join('\n')}`;

// A question on the terminal, or no asking at all without one (setup then takes the found clients).
function asker() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  return question => new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on('SIGINT', () => { rl.close(); process.exit(130); });
    rl.question(question, answer => { rl.close(); resolve(answer); });
  });
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const { flags } = parseArgs(rest, { booleans: ['yes', 'fix', 'dry-run', 'no-wait'] });
  switch (cmd) {
    case '-v': case '--version': case 'version':
      return console.log(VERSION);
    case 'setup':
      return require('../setup').setup({ yes: !!flags.yes, clients: flags.clients, browser: flags.browser, wait: !flags['no-wait'] }, { ask: flags.yes ? undefined : asker() });
    case 'doctor': {
      const checks = await require('../doctor').doctor({ fix: !!flags.fix });
      if (checks.some(c => c.status === 'fail')) process.exitCode = 1;
      return undefined;
    }
    case 'uninstall':
      return require('../install').uninstall({ dryRun: !!flags['dry-run'] });
    case undefined: case '-h': case '--help': case 'help':
      return console.log(HELP);
    default:
      if (cli.COMMANDS.includes(cmd)) return cli.run(argv);
      console.log(HELP);
      throw new Error(`Unknown command "${cmd}".`);
  }
}

main(process.argv.slice(2)).catch(e => { console.error(`Error: ${e.message}`); process.exitCode = 1; });
