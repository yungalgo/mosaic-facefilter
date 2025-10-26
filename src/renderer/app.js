// Import MediaPipe Tasks Vision (NEW API)
import vision from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3";
const { FaceLandmarker, FilesetResolver, DrawingUtils } = vision;

const video = document.getElementById('webcam');
const canvas = document.getElementById('output');
const ctx = canvas.getContext('2d');

let faceLandmarker;
let webcamRunning = false;
let lastVideoTime = -1;

// Initialize FaceLandmarker
async function createFaceLandmarker() {
    console.log('🚀 Initializing MediaPipe FaceLandmarker...');
    
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
    
    console.log('✅ FaceLandmarker ready!');
}

// Start webcam
async function startCamera() {
    console.log('📹 Starting camera...');
    
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: 640, height: 480 }
        });
        
        video.srcObject = stream;
        video.addEventListener('loadeddata', () => {
            webcamRunning = true;
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            console.log(`✅ Camera ready: ${canvas.width}x${canvas.height}`);
            predictWebcam();
        });
    } catch (err) {
        console.error('❌ Camera error:', err);
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
        
        // Clear and draw video
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        
        if (results.faceLandmarks && results.faceLandmarks.length > 0) {
            const landmarks = results.faceLandmarks[0];
            
            // Draw mosaic effect
            drawMosaicEffect(landmarks);
        }
    }
    
    // Continue loop
    requestAnimationFrame(predictWebcam);
}

// Draw mosaic effect using face mesh triangles
function drawMosaicEffect(landmarks) {
    // Get image data for color sampling
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    
    // Get tessellation triangles
    const tessellation = FaceLandmarker.FACE_LANDMARKS_TESSELATION;
    
    let trianglesDrawn = 0;
    
    // Draw triangles (skip every 3 connections for performance and better look)
    for (let i = 0; i < tessellation.length; i += 3) {
        // We need to form triangles from the edges
        // Every 3 connections form a rough triangle
        if (i + 2 >= tessellation.length) break;
        
        const conn1 = tessellation[i];
        const conn2 = tessellation[i + 1];
        const conn3 = tessellation[i + 2];
        
        // Get landmark points
        const p1 = landmarks[conn1.start];
        const p2 = landmarks[conn1.end];
        const p3 = landmarks[conn2.end];
        
        if (!p1 || !p2 || !p3) continue;
        
        // Convert normalized coordinates to canvas pixels
        const x1 = p1.x * canvas.width;
        const y1 = p1.y * canvas.height;
        const x2 = p2.x * canvas.width;
        const y2 = p2.y * canvas.height;
        const x3 = p3.x * canvas.width;
        const y3 = p3.y * canvas.height;
        
        // Calculate average color for this triangle
        const avgColor = getTriangleColor(x1, y1, x2, y2, x3, y3, imageData);
        
        // Draw filled triangle
        ctx.fillStyle = `rgb(${avgColor.r}, ${avgColor.g}, ${avgColor.b})`;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.lineTo(x3, y3);
        ctx.closePath();
        ctx.fill();
        
        // Thin borders for debugging
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.2)';
        ctx.lineWidth = 0.5;
        ctx.stroke();
        
        trianglesDrawn++;
    }
    
    console.log(`✅ Drew ${trianglesDrawn} mosaic blocks`);
}

// Get average color for a triangle
function getTriangleColor(x1, y1, x2, y2, x3, y3, imageData) {
    const centerX = Math.floor((x1 + x2 + x3) / 3);
    const centerY = Math.floor((y1 + y2 + y3) / 3);
    
    if (centerX < 0 || centerX >= canvas.width || centerY < 0 || centerY >= canvas.height) {
        return { r: 0, g: 0, b: 0 };
    }
    
    const pixelIndex = (centerY * canvas.width + centerX) * 4;
    return {
        r: imageData.data[pixelIndex],
        g: imageData.data[pixelIndex + 1],
        b: imageData.data[pixelIndex + 2]
    };
}

// Initialize everything
async function init() {
    console.log('🚀 Starting Mosaic Face Filter...');
    await createFaceLandmarker();
    await startCamera();
}

init();
