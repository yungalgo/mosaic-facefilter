// Import MediaPipe Tasks Vision (NEW API)
import vision from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3";
const { FaceLandmarker, FilesetResolver } = vision;

const video = document.getElementById('webcam');
const canvas = document.getElementById('output');
const gl = canvas.getContext('webgl', { 
    premultipliedAlpha: false,
    antialias: false 
});

if (!gl) {
    alert('WebGL not supported');
    throw new Error('WebGL not supported');
}

// Configuration
const CANON_SIZE = 512;      // Canonical UV texture size (stays square)

// How many chunky blocks across and down the face
const TILES_U = 12;
const TILES_V = 16;

let faceLandmarker;
let webcamRunning = false;
let lastVideoTime = -1;

// WebGL resources
let programPassA, programPassB, programBlit;
let fboCanon, texCanon, fboSmall, texSmall;
let cameraTexture;
let canonicalUVs = null; // Will be loaded from canonical_468_uv.json
let TRI = null; // Will be loaded from triangulation_468.json

// Initialize FaceLandmarker
async function createFaceLandmarker() {
    
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

// Load canonical UV coordinates
async function loadCanonicalUVs() {
    const response = await fetch('canonical_468_uv.json');
    const uvArray = await response.json();
    canonicalUVs = new Float32Array(uvArray);
    if (canonicalUVs.length !== 468 * 2) {
        throw new Error(`Bad UV length: ${canonicalUVs.length}`);
    }
}

// Load triangulation indices
async function loadTriangulation() {
    const response = await fetch('triangulation_468.json');
    const triArray = await response.json();
    TRI = new Uint16Array(triArray);
}

// Initialize WebGL resources
function initWebGL() {
    
    // Set texture upload flip (fixes upside-down video)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    
    // Create shader programs
    programPassA = createProgram(vertexShaderPassA, fragmentShaderPassA);
    programPassB = createProgram(vertexShaderPassB, fragmentShaderPassB);
    programBlit = createProgram(vertexShaderBlit, fragmentShaderBlit);
    
    // Create framebuffers and textures
    ({ fbo: fboCanon, texture: texCanon } = createFramebuffer(CANON_SIZE, CANON_SIZE));
    ({ fbo: fboSmall, texture: texSmall } = createFramebuffer(TILES_U, TILES_V));
    
    // Create camera texture
    cameraTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, cameraTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    
}

// Create shader program
function createProgram(vertexSource, fragmentSource) {
    const vertexShader = compileShader(gl.VERTEX_SHADER, vertexSource);
    const fragmentShader = compileShader(gl.FRAGMENT_SHADER, fragmentSource);
    
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        return null;
    }
    
    return program;
}

// Compile shader
function compileShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        return null;
    }
    
    return shader;
}

// Create framebuffer with texture
function createFramebuffer(width, height) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    }
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    
    return { fbo, texture };
}

// Start webcam
async function startCamera() {
    
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: 640, height: 480 }
        });
        
        video.srcObject = stream;
        video.addEventListener('loadeddata', () => {
            webcamRunning = true;
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            
            initWebGL();
            predictWebcam();
        });
    } catch (err) {
        alert('Please allow camera access');
    }
}

// Main prediction loop
async function predictWebcam() {
    if (!webcamRunning) return;
    
    let startTimeMs = performance.now();
    
    // Only process if new frame
    if (lastVideoTime !== video.currentTime) {
        lastVideoTime = video.currentTime;
        
        // Detect face landmarks
        const results = faceLandmarker.detectForVideo(video, startTimeMs);
        
        // Update camera texture
        gl.bindTexture(gl.TEXTURE_2D, cameraTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
        
        // Draw video background
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clear(gl.COLOR_BUFFER_BIT);
        drawFullscreenQuad(programBlit, cameraTexture, canvas.width, canvas.height);
        
        if (results.faceLandmarks && results.faceLandmarks.length > 0) {
            const landmarks = results.faceLandmarks[0];
            
            // Render pixelated face effect
            renderPixelatedFace(landmarks);
        }
    }
    
    // Continue loop
    requestAnimationFrame(predictWebcam);
}

// Render the pixelated face effect (two-pass pipeline)
function renderPixelatedFace(landmarks) {
    // PASS A: Unwrap camera to canonical UV space
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboCanon);
    gl.viewport(0, 0, CANON_SIZE, CANON_SIZE);
    gl.clear(gl.COLOR_BUFFER_BIT);
    
    renderFaceMesh(programPassA, landmarks, TRI, cameraTexture, true);
    
    // PIXELATION: Downsample canonical to tile grid size
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboSmall);
    gl.viewport(0, 0, TILES_U, TILES_V);
    gl.clear(gl.COLOR_BUFFER_BIT);
    drawFullscreenQuad(programBlit, texCanon, TILES_U, TILES_V);
    
    // PIXELATION: Upsample back with NEAREST to get chunky pixels
    gl.bindTexture(gl.TEXTURE_2D, texSmall);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboCanon);
    gl.viewport(0, 0, CANON_SIZE, CANON_SIZE);
    gl.clear(gl.COLOR_BUFFER_BIT);
    drawFullscreenQuad(programBlit, texSmall, CANON_SIZE, CANON_SIZE);
    
    // PASS B: Rewrap canonical UV to screen space
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    
    renderFaceMesh(programPassB, landmarks, TRI, texCanon, false);
    
    gl.disable(gl.BLEND);
}

// Render face mesh with specified shader program
function renderFaceMesh(program, landmarks, triIndexBuffer, texture, isPassA) {
    gl.useProgram(program);
    
    // Build vertex data directly from triangle indices
    // Each vertex: [sx, sy, u, v] (4 floats)
    const verts = new Float32Array(triIndexBuffer.length * 4);
    
    for (let t = 0; t < triIndexBuffer.length; t++) {
        const i = triIndexBuffer[t];
        const lm = landmarks[i];
        
        // Screen position in pixels
        const sx = lm.x * canvas.width;
        const sy = lm.y * canvas.height;
        
        // Canonical UV coordinates
        const u = canonicalUVs[i * 2 + 0];
        const v = canonicalUVs[i * 2 + 1];
        
        const o = t * 4;
        verts[o + 0] = sx;
        verts[o + 1] = sy;
        verts[o + 2] = u;
        verts[o + 3] = v;
    }
    
    // Create and bind vertex buffer
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
    
    // Set attributes
    const aScreenPos = gl.getAttribLocation(program, 'aScreenPos');
    const aCanonUV = gl.getAttribLocation(program, 'aCanonUV');
    
    gl.enableVertexAttribArray(aScreenPos);
    gl.enableVertexAttribArray(aCanonUV);
    
    gl.vertexAttribPointer(aScreenPos, 2, gl.FLOAT, false, 16, 0);
    gl.vertexAttribPointer(aCanonUV, 2, gl.FLOAT, false, 16, 8);
    
    // Set uniforms
    gl.uniform2f(gl.getUniformLocation(program, 'uCanvasSize'), canvas.width, canvas.height);
    
    // Set texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(gl.getUniformLocation(program, isPassA ? 'uCameraTex' : 'uPixelCanonTex'), 0);
    
    // Draw as triangles directly from the index stream
    gl.drawArrays(gl.TRIANGLES, 0, triIndexBuffer.length);
    
    // Cleanup
    gl.deleteBuffer(vbo);
}

// Draw fullscreen quad (for blit operations)
function drawFullscreenQuad(program, texture, width, height) {
    gl.useProgram(program);
    
    const vertices = new Float32Array([
        -1, -1,  0, 0,
         1, -1,  1, 0,
        -1,  1,  0, 1,
         1,  1,  1, 1
    ]);
    
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    
    const aPos = gl.getAttribLocation(program, 'aPos');
    const aUV = gl.getAttribLocation(program, 'aUV');
    
    gl.enableVertexAttribArray(aPos);
    gl.enableVertexAttribArray(aUV);
    
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
    gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 16, 8);
    
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(gl.getUniformLocation(program, 'uTex'), 0);
    
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    
    gl.deleteBuffer(vbo);
}

// PASS A: Unwrap camera to canonical UV
const vertexShaderPassA = `
attribute vec2 aCanonUV;
attribute vec2 aScreenPos;
uniform vec2 uCanvasSize;
varying vec2 vScreenUV;

void main() {
    vec2 posNDC = aCanonUV * 2.0 - 1.0;
    gl_Position = vec4(posNDC, 0.0, 1.0);
    vScreenUV = aScreenPos / uCanvasSize;
}
`;

const fragmentShaderPassA = `
precision mediump float;
uniform sampler2D uCameraTex;
varying vec2 vScreenUV;

void main() {
    // flip Y so we sample from the correct part of the video
    gl_FragColor = texture2D(uCameraTex, vec2(vScreenUV.x, 1.0 - vScreenUV.y));
}
`;

// PASS B: Rewrap canonical UV to screen
const vertexShaderPassB = `
attribute vec2 aScreenPos;
attribute vec2 aCanonUV;
uniform vec2 uCanvasSize;
varying vec2 vCanonUV;

void main() {
    vec2 posNDC = (aScreenPos / uCanvasSize) * 2.0 - 1.0;
    posNDC.y = -posNDC.y; // Geometry flip (pixel space → NDC space)
    gl_Position = vec4(posNDC, 0.0, 1.0);
    vCanonUV = aCanonUV;
}
`;

const fragmentShaderPassB = `
precision mediump float;
uniform sampler2D uPixelCanonTex;
varying vec2 vCanonUV;

void main() {
    gl_FragColor = texture2D(uPixelCanonTex, vCanonUV);
}
`;

// Blit shader (for fullscreen texture copy)
const vertexShaderBlit = `
attribute vec2 aPos;
attribute vec2 aUV;
varying vec2 vUV;

void main() {
    gl_Position = vec4(aPos, 0.0, 1.0);
    vUV = aUV;
}
`;

const fragmentShaderBlit = `
precision mediump float;
uniform sampler2D uTex;
varying vec2 vUV;

void main() {
    gl_FragColor = texture2D(uTex, vUV);
}
`;

// Initialize everything
async function init() {
    await createFaceLandmarker();
    await loadCanonicalUVs();
    await loadTriangulation();
    await startCamera();
}

init();
