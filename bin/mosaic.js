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
        '                             continuation and replace the output with it.\n' +
        '  --extend-duration <secs>   Continuation length (default 5).\n' +
        '  --extend-context <secs>    Seconds of the input video used as context\n' +
        '                             (default 10, min 1, max 20).\n' +
        '  --fal-key <key>            Provide the fal.ai key inline; auto-saved to\n' +
        '                             ~/.mosaic/fal-key for future runs.\n' +
        '  -h, --help                 Show this help.\n\n' +
        'Output path defaults to <input-dir>/<name>-mosaic<ext>.\n'
    );
}

if (argv.length === 0) { printHelp(); process.exit(1); }

let input = null;
let output = null;
let extendPrompt = null;
let extendDuration = 5;
let extendContext = 10;
let falKey = null;

for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
    else if (a === '--extend') extendPrompt = argv[++i];
    else if (a === '--extend-duration') extendDuration = parseFloat(argv[++i]);
    else if (a === '--extend-context') extendContext = parseFloat(argv[++i]);
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

function loadStoredFalKey() {
    const keyPath = path.join(require('os').homedir(), '.mosaic', 'fal-key');
    try {
        const v = fs.readFileSync(keyPath, 'utf8').trim();
        return v || null;
    } catch { return null; }
}

function saveFalKey(key) {
    const dir = path.join(require('os').homedir(), '.mosaic');
    fs.mkdirSync(dir, { recursive: true });
    const keyPath = path.join(dir, 'fal-key');
    fs.writeFileSync(keyPath, key, { mode: 0o600 });
    fs.chmodSync(keyPath, 0o600);
    return keyPath;
}

const childArgs = [appDir, '--cli', input, output];
if (extendPrompt) {
    childArgs.push(
        '--extend', extendPrompt,
        '--extend-duration', String(extendDuration),
        '--extend-context', String(extendContext)
    );

    // Key resolution precedence: --fal-key, then FAL_KEY env, then ~/.mosaic/fal-key.
    // If the user passed --fal-key, persist it for future runs.
    let effectiveKey = falKey || process.env.FAL_KEY || loadStoredFalKey();
    if (falKey) {
        const p = saveFalKey(falKey);
        process.stderr.write(`mosaic: saved fal key to ${p}\n`);
    }
    if (!effectiveKey) {
        process.stderr.write(
            'mosaic: --extend requires a fal.ai key.\n' +
            '  Pass --fal-key <key> once (it will be saved to ~/.mosaic/fal-key),\n' +
            '  or set the FAL_KEY environment variable.\n'
        );
        process.exit(1);
    }

    var _falKeyForEnv = effectiveKey;
}

const env = { ...process.env, ELECTRON_NO_ATTACH_CONSOLE: '1' };
if (typeof _falKeyForEnv !== 'undefined') env.FAL_KEY = _falKeyForEnv;

const child = spawn(electron, childArgs, { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 1));
