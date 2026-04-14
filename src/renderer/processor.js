// Offline CLI processor: frame-by-frame face-mosaic of a video file.
// Reuses the same shader pipeline as app.js (minus camera/segmentation/scramble).

import vision from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3";
const { FaceLandmarker, FilesetResolver } = vision;

const canvas = document.getElementById('output');
const video  = document.getElementById('webcam');
const gl = canvas.getContext('webgl', { premultipliedAlpha: false, antialias: false, depth: true });
if (!gl) { window.mosaicCli.error('WebGL not supported'); throw new Error('no webgl'); }

const CANON_SIZE = 512;
const TILES_U = 12;
const TILES_V = 14;
const FACE_SCALE_Y_DOWN = 1.1;

// ---------------- Shaders (copied from app.js) ----------------
const vertexShaderPassA = `
attribute vec2 aCanonUV;
attribute vec3 aScreenPos;
uniform vec2 uCanvasSize;
varying vec2 vScreenUV;
void main() {
    vec2 posNDC = aCanonUV * 2.0 - 1.0;
    gl_Position = vec4(posNDC, 0.0, 1.0);
    vScreenUV = aScreenPos.xy / uCanvasSize;
}`;
const fragmentShaderPassA = `
precision mediump float;
uniform sampler2D uCameraTex;
varying vec2 vScreenUV;
void main() {
    gl_FragColor = texture2D(uCameraTex, vec2(vScreenUV.x, 1.0 - vScreenUV.y));
}`;
const vertexShaderPassB = `
attribute vec3 aScreenPos;
attribute vec2 aCanonUV;
uniform vec2 uCanvasSize;
varying vec2 vCanonUV;
void main() {
    vec2 posNDC_xy = (aScreenPos.xy / uCanvasSize) * 2.0 - 1.0;
    posNDC_xy.y = -posNDC_xy.y;
    gl_Position = vec4(posNDC_xy, aScreenPos.z, 1.0);
    vCanonUV = aCanonUV;
}`;
const fragmentShaderPassB = `
precision mediump float;
uniform sampler2D uPixelCanonTex;
varying vec2 vCanonUV;
void main() { gl_FragColor = texture2D(uPixelCanonTex, vCanonUV); }`;
const vertexShaderBlit = `
attribute vec2 aPos;
attribute vec2 aUV;
varying vec2 vUV;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); vUV = aUV; }`;
const fragmentShaderBlit = `
precision mediump float;
uniform sampler2D uTex;
varying vec2 vUV;
void main() { gl_FragColor = texture2D(uTex, vUV); }`;

// ---------------- GL helpers ----------------
function compileShader(type, source) {
    const s = gl.createShader(type);
    gl.shaderSource(s, source); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error('shader compile: ' + gl.getShaderInfoLog(s));
    }
    return s;
}
function createProgram(vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compileShader(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compileShader(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        throw new Error('program link: ' + gl.getProgramInfoLog(p));
    }
    return p;
}
function createFramebuffer(w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, texture: tex };
}

let programPassA, programPassB, programBlit;
let fboCanon, texCanon, fboSmall, texSmall;
let cameraTexture, quadVBO;
let canonicalUVs = null;
let TRI = null;
let faceLandmarker;

function initWebGL() {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    programPassA = createProgram(vertexShaderPassA, fragmentShaderPassA);
    programPassB = createProgram(vertexShaderPassB, fragmentShaderPassB);
    programBlit  = createProgram(vertexShaderBlit,  fragmentShaderBlit);
    ({ fbo: fboCanon, texture: texCanon } = createFramebuffer(CANON_SIZE, CANON_SIZE));
    ({ fbo: fboSmall, texture: texSmall } = createFramebuffer(TILES_U, TILES_V));
    quadVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadVBO);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1,-1, 0,0,   1,-1, 1,0,   -1,1, 0,1,   1,1, 1,1
    ]), gl.STATIC_DRAW);
    cameraTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, cameraTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
}

function drawFullscreenQuad(program, texture) {
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadVBO);
    const aPos = gl.getAttribLocation(program, 'aPos');
    const aUV  = gl.getAttribLocation(program, 'aUV');
    gl.enableVertexAttribArray(aPos);
    gl.enableVertexAttribArray(aUV);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
    gl.vertexAttribPointer(aUV,  2, gl.FLOAT, false, 16, 8);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(gl.getUniformLocation(program, 'uTex'), 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function renderFaceMesh(program, landmarks, triIdx, texture, isPassA) {
    gl.useProgram(program);
    const W = canvas.width, H = canvas.height;
    let cx = 0, cy = 0;
    for (let i = 0; i < 468; i++) { cx += landmarks[i].x; cy += landmarks[i].y; }
    cx = (cx / 468) * W; cy = (cy / 468) * H;
    let zmin = 1e9, zmax = -1e9;
    for (let i = 0; i < 468; i++) {
        const z = landmarks[i].z;
        if (z < zmin) zmin = z;
        if (z > zmax) zmax = z;
    }
    const zEps = 1e-6;
    const VERTS = new Float32Array(triIdx.length * 5);
    for (let t = 0; t < triIdx.length; t++) {
        const i = triIdx[t];
        const lm = landmarks[i];
        let sx = lm.x * W;
        let sy = lm.y * H;
        if (sy > cy) sy = cy + (sy - cy) * FACE_SCALE_Y_DOWN;
        const znorm = (lm.z - zmax) / ((zmin - zmax) + zEps);
        const szNDC = -1.0 + 2.0 * (1.0 - znorm);
        const u = canonicalUVs[i * 2 + 0];
        const v = canonicalUVs[i * 2 + 1];
        const o = t * 5;
        VERTS[o] = sx; VERTS[o+1] = sy; VERTS[o+2] = szNDC;
        VERTS[o+3] = u; VERTS[o+4] = v;
    }
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, VERTS, gl.DYNAMIC_DRAW);
    const aScreenPos = gl.getAttribLocation(program, 'aScreenPos');
    const aCanonUV   = gl.getAttribLocation(program, 'aCanonUV');
    gl.enableVertexAttribArray(aScreenPos);
    gl.enableVertexAttribArray(aCanonUV);
    gl.vertexAttribPointer(aScreenPos, 3, gl.FLOAT, false, 20, 0);
    gl.vertexAttribPointer(aCanonUV,   2, gl.FLOAT, false, 20, 12);
    gl.uniform2f(gl.getUniformLocation(program, 'uCanvasSize'), W, H);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(gl.getUniformLocation(program, isPassA ? 'uCameraTex' : 'uPixelCanonTex'), 0);
    gl.drawArrays(gl.TRIANGLES, 0, triIdx.length);
    gl.deleteBuffer(vbo);
}

function renderPixelatedFace(landmarks) {
    // Pass A: unwrap to canonical
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboCanon);
    gl.viewport(0, 0, CANON_SIZE, CANON_SIZE);
    gl.clear(gl.COLOR_BUFFER_BIT);
    renderFaceMesh(programPassA, landmarks, TRI, cameraTexture, true);

    // Downsample to tile grid
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboSmall);
    gl.viewport(0, 0, TILES_U, TILES_V);
    gl.clear(gl.COLOR_BUFFER_BIT);
    drawFullscreenQuad(programBlit, texCanon);

    // Upsample with NEAREST for chunky pixels
    gl.bindTexture(gl.TEXTURE_2D, texSmall);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboCanon);
    gl.viewport(0, 0, CANON_SIZE, CANON_SIZE);
    gl.clear(gl.COLOR_BUFFER_BIT);
    drawFullscreenQuad(programBlit, texSmall);

    // Pass B: rewrap onto screen over video background
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    renderFaceMesh(programPassB, landmarks, TRI, texCanon, false);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
}

// ---------------- Asset loaders ----------------
async function loadAssets() {
    const [uvRes, triRes] = await Promise.all([
        fetch('canonical_468_uv.json'),
        fetch('triangulation_468.json')
    ]);
    canonicalUVs = new Float32Array(await uvRes.json());
    TRI = new Uint16Array(await triRes.json());
}

async function createLandmarker() {
    const filesetResolver = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm"
    );
    faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
        baseOptions: {
            modelAssetPath: `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
            delegate: "GPU"
        },
        runningMode: "VIDEO",
        numFaces: 1
    });
}

// ---------------- Frame processing ----------------
async function processFrame(frameIdx) {
    // Monotonic ms timestamp for mediapipe
    const tsMs = frameIdx * (1000 / 30); // arbitrary monotonic scale
    const results = faceLandmarker.detectForVideo(video, tsMs);

    gl.bindTexture(gl.TEXTURE_2D, cameraTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    drawFullscreenQuad(programBlit, cameraTexture);

    if (results.faceLandmarks && results.faceLandmarks.length > 0) {
        renderPixelatedFace(results.faceLandmarks[0]);
    }

    const buf = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    // Await main-side backpressure before returning — lets ffmpeg encoder
    // pace us so we don't pile frames in memory.
    await window.mosaicCli.sendFrame(buf);
}

// Frame acquisition: play → rVFC fires for the next presented frame → pause
// the video → process → play again. Pausing between frames guarantees no
// frames are skipped even when per-frame processing exceeds the video's
// natural inter-frame interval (e.g. mediapipe + readPixels on 4K).
function runPlaybackLoop() {
    return new Promise((resolve, reject) => {
        let frameIdx = 0;
        let ended = false;
        let finished = false;

        const finish = () => {
            if (finished) return;
            finished = true;
            resolve(frameIdx);
        };

        video.muted = true;
        video.playbackRate = 1.0;

        let busy = false;
        video.addEventListener('ended', () => {
            ended = true;
            if (!busy) finish();
        }, { once: true });
        video.addEventListener('error', () =>
            reject(new Error('playback error: ' + (video.error && video.error.message))),
            { once: true });

        const atEnd = () => ended || video.currentTime >= video.duration - 1e-3;

        const onFrame = async (_now, metadata) => {
            busy = true;
            video.pause();
            try {
                await processFrame(frameIdx++);
            } catch (e) {
                reject(e);
                return;
            }
            busy = false;
            if (atEnd()) { finish(); return; }
            video.requestVideoFrameCallback(onFrame);
            try {
                await video.play();
            } catch (e) {
                if (atEnd()) finish();
                else reject(e);
            }
        };

        video.requestVideoFrameCallback(onFrame);
        video.play().catch(reject);
    });
}

async function run({ inputPath, width, height }) {
    try {
        canvas.width = width;
        canvas.height = height;
        initWebGL();
        await loadAssets();
        await createLandmarker();

        video.src = 'file://' + inputPath;
        await new Promise((resolve, reject) => {
            video.addEventListener('loadeddata', resolve, { once: true });
            video.addEventListener('error', () =>
                reject(new Error('video load failed: ' + (video.error && video.error.message))),
                { once: true });
        });

        if (typeof video.requestVideoFrameCallback !== 'function') {
            throw new Error('requestVideoFrameCallback not available in this Chromium');
        }

        await runPlaybackLoop();
        window.mosaicCli.done();
    } catch (e) {
        window.mosaicCli.error(e && e.stack || e);
    }
}

window.mosaicCli.onStart(run);
window.mosaicCli.ready();
