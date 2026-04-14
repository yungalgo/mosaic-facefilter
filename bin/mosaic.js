#!/usr/bin/env node
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const electron = require('electron');
const appDir = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(
        'mosaic — face-mosaic an entire video file\n\n' +
        'Usage: mosaic <input> [output]\n\n' +
        'If output is omitted, writes <input-dir>/<name>-mosaic<ext>.\n'
    );
    process.exit(argv.length === 0 ? 1 : 0);
}

const input = path.resolve(argv[0]);
if (!fs.existsSync(input)) {
    process.stderr.write(`mosaic: input not found: ${input}\n`);
    process.exit(1);
}

let output;
if (argv[1]) {
    output = path.resolve(argv[1]);
} else {
    const ext = path.extname(input);
    const base = path.basename(input, ext);
    output = path.join(path.dirname(input), `${base}-mosaic${ext}`);
}

const child = spawn(electron, [appDir, '--cli', input, output], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_NO_ATTACH_CONSOLE: '1' }
});
child.on('exit', (code) => process.exit(code ?? 1));
