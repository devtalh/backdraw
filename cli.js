'use strict';
// Command line access to the bridge, for setup and troubleshooting.
const path = require('path');
const bridge = require('./shared');
const { parseArgs } = require('./lib/args');
const { FINAL } = require('./lib/results');
const { MAX_REFS } = require('./lib/limits');
const { findCollection } = require('./lib/collections');

const USAGE = `Usage: node cli.js <command>
  status                          Bridge status (Chrome connected, selected project, queue)
  projects                        List ChatGPT projects
  select <name | link>            Select the project where images are generated
  generate "<prompt>" [--ref IMAGE]... [--url CHAT_LINK] [--aspect W:H] [--transparent] [--reattach] [--out FOLDER] [--raw] [--wait 300]
           [--collection NAME [--file FILE]...]
                                  Generate an image; --ref attaches a reference/image to edit (up to ${MAX_REFS} in all);
                                  --collection adds a reference collection's newest images (--file picks them);
                                  --aspect 16:9 sets the shape (1:4 to 4:1), --transparent asks for a see-through background
  collect <chat link> [--aspect W:H] [--out FOLDER]   Download the latest images of an existing chat (sends nothing), cropped to W:H
  job <id> [--wait 60]            Show a job's status
  cancel <id>                     Cancel a job
  collections                     List the reference collections (Chrome: right-click an image, "Add to Backdraw")
  collection <name>               Show one collection and its images
  outdir <folder>                 Change the central images folder
  debug on|off                    Verbose logging (logs/host.log)
  diagnose [link] [--selector CSS] [--max N] [--worker]   Page diagnostics
  reload                          Reload the Chrome extension`;

const FLAGS = { booleans: ['raw', 'reattach', 'worker', 'transparent'], lists: ['ref', 'file'] };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const print = v => console.log(JSON.stringify(v, null, 2));

async function follow(jobId, waitSec) {
  const deadline = Date.now() + waitSec * 1000;
  let job = await bridge.call('job', { jobId });
  let last = '';
  for (;;) {
    const note = `${job.status} | ${job.step} | ${job.message || ''}`;
    if (note !== last) { console.error(`[${new Date().toLocaleTimeString()}] ${note}`); last = note; }
    if (FINAL.has(job.status) || Date.now() > deadline) return bridge.copyResults(job);
    await sleep(1500);
    job = await bridge.call('job', { jobId });
  }
}

// argv: the words after "node cli.js" (or "backdraw").
async function run(argv) {
  const [cmd, ...rest] = argv;
  const { pos, flags } = parseArgs(rest, FLAGS);
  const copyTo = typeof flags.out === 'string' ? path.resolve(flags.out) : undefined;
  if (flags.aspect === true) throw new Error('--aspect needs a ratio, e.g. --aspect 16:9.');
  switch (cmd) {
    case 'status': return print(await bridge.call('status'));
    case 'projects': return print(await bridge.call('list_projects', {}, 130000));
    case 'select': {
      const v = pos.join(' ');
      if (!v) throw new Error('A project name or link is required.');
      return print(await bridge.call('select_project', /^https?:\/\//i.test(v) ? { url: v } : { name: v }, 130000));
    }
    case 'generate': {
      const prompt = pos.join(' ');
      if (!prompt) throw new Error('A prompt is required.');
      const job = await bridge.call('generate', {
        prompt, copyTo, references: bridge.readReferences(flags.ref ? [].concat(flags.ref) : []),
        startUrl: typeof flags.url === 'string' ? flags.url : undefined, sendAsIs: !!flags.raw, autoReattach: !!flags.reattach,
        aspect: flags.aspect, transparent: !!flags.transparent,
        referenceCollection: typeof flags.collection === 'string' ? flags.collection : undefined, referenceFiles: flags.file ? [].concat(flags.file) : undefined,
      }, 60000);
      console.error(`Job: ${job.id}`);
      return print(await follow(job.id, Number(flags.wait) || 600));
    }
    case 'collect': {
      if (!pos[0]) throw new Error('A chat link is required.');
      const job = await bridge.call('generate', { mode: 'collect', startUrl: pos[0], copyTo, aspect: flags.aspect });
      console.error(`Job: ${job.id}`);
      return print(await follow(job.id, Number(flags.wait) || 300));
    }
    case 'job': return print(await follow(pos[0], Number(flags.wait) || 0));
    case 'cancel': return print(await bridge.call('cancel', { jobId: pos[0] }));
    case 'collections': return print(await bridge.call('list_collections', { summary: true }));
    case 'collection': {
      const name = pos.join(' ');
      if (!name) throw new Error('A collection name is required.');
      const list = await bridge.call('list_collections');
      const { collection, error, ties } = findCollection(list, name);
      if (error === 'AMBIGUOUS') throw new Error(`"${name}" matches several collections: ${ties.map(c => c.name).join(', ')}`);
      if (error) throw new Error(`No collection matches "${name}". Available: ${list.map(c => c.name).join(', ') || '(none)'}`);
      return print(collection);
    }
    case 'outdir': return print(await bridge.call('set_config', { outputDir: path.resolve(pos[0]) }));
    case 'debug': return print(await bridge.call('set_config', { debug: pos[0] === 'on' }));
    case 'diagnose':
      return print(await bridge.call('diagnose', {
        url: pos[0], selector: flags.selector, max: flags.max ? Number(flags.max) : undefined, target: flags.worker ? 'worker' : undefined,
      }, 190000));
    case 'reload': return print(await bridge.call('reload_extension'));
    default:
      console.log(USAGE);
  }
}

if (require.main === module) run(process.argv.slice(2)).catch(e => { console.error(`Error: ${e.message}`); process.exitCode = 1; });

module.exports = { USAGE, COMMANDS: ['status', 'projects', 'select', 'generate', 'collect', 'job', 'cancel', 'collections', 'collection', 'outdir', 'debug', 'diagnose', 'reload'], run };
