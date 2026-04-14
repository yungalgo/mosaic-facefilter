#!/usr/bin/env node
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const electron = require('electron');
const appDir = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);

function printHelp() {
    process.stdout.write(
        'mosaic — face-mosaic an entire video file\n\n' +
        'Usage: mosaic <input> [output] [flags]\n\n' +
        'Flags:\n' +
        '  --extend "<prompt>"        After mosaicking, use fal.ai LTX to generate a\n' +
        '                             continuation clip and append it to the output.\n' +
        '  --extend-duration <secs>   Length of the generated continuation (default 5).\n' +
        '  --fal-key <key>            Provide the fal.ai key inline (otherwise read from\n' +
        '                             the FAL_KEY env var).\n' +
        '  -h, --help                 Show this help.\n\n' +
        'Output path defaults to <input-dir>/<name>-mosaic<ext>.\n'
    );
}

if (argv.length === 0) { printHelp(); process.exit(1); }

let input = null;
let output = null;
let extendPrompt = null;
let extendDuration = 5;
let falKey = null;

for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
    else if (a === '--extend') extendPrompt = argv[++i];
    else if (a === '--extend-duration') extendDuration = parseFloat(argv[++i]);
    else if (a === '--fal-key') falKey = argv[++i];
    else if (!input) input = a;
    else if (!output) output = a;
    else { process.stderr.write(`mosaic: unexpected argument: ${a}\n`); process.exit(1); }
}

if (!input) { process.stderr.write('mosaic: input path required\n'); process.exit(1); }
input = path.resolve(input);
if (!fs.existsSync(input)) {
    process.stderr.write(`mosaic: input not found: ${input}\n`);
    process.exit(1);
}

if (!output) {
    const ext = path.extname(input);
    const base = path.basename(input, ext);
    output = path.join(path.dirname(input), `${base}-mosaic${ext}`);
} else {
    output = path.resolve(output);
}

if (extendPrompt !== null && !extendPrompt) {
    process.stderr.write('mosaic: --extend requires a prompt string\n');
    process.exit(1);
}

const childArgs = [appDir, '--cli', input, output];
if (extendPrompt) {
    childArgs.push('--extend', extendPrompt, '--extend-duration', String(extendDuration));
    if (!falKey && !process.env.FAL_KEY) {
        process.stderr.write('mosaic: --extend requires FAL_KEY env var or --fal-key\n');
        process.exit(1);
    }
}

const env = { ...process.env, ELECTRON_NO_ATTACH_CONSOLE: '1' };
if (falKey) env.FAL_KEY = falKey;

const child = spawn(electron, childArgs, { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 1));
