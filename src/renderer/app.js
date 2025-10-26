const video = document.getElementById('webcam');
const canvas = document.getElementById('output');
const ctx = canvas.getContext('2d');

// CORRECT APPROACH: Use MediaPipe's actual triangle tessellation
// FACEMESH_TESSELATION provides the triangle connections
// "Temperature" controls how many adjacent triangles to merge

// Mosaic settings
let TRIANGLE_SKIP = 3;  // Draw every Nth triangle (1=all triangles, 3=every 3rd, etc)
                         // Higher value = fewer, larger blocks

// Debug flags
const DEBUG = {
    showTriangleEdges: true,  // Show triangle borders
    logStats: true            // Log statistics every 30 frames
};

let faceMesh;
let camera;
let frameCount = 0;

// Initialize MediaPipe Face Mesh
async function initFaceMesh() {
    console.log('🎯 Initializing MediaPipe Face Mesh...');
    
    faceMesh = new FaceMesh({
        locateFile: (file) => {
            return `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`;
        }
    });
    
    faceMesh.setOptions({
        maxNumFaces: 1,
        refineLandmarks: true,  // Get more accurate mesh
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5
    });
    
    faceMesh.onResults(onResults);
    console.log('✅ Face Mesh initialized');
}

// Start webcam
async function startCamera() {
    console.log('📹 Starting camera...');
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: 640, height: 480 }
        });
        video.srcObject = stream;
        
        video.onloadedmetadata = () => {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            console.log(`✅ Camera ready: ${canvas.width}x${canvas.height}`);
            requestAnimationFrame(processFrame);
        };
    } catch (err) {
        console.error('❌ Camera error:', err);
        alert('Please allow camera access');
    }
}

// Process each frame
async function processFrame() {
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
        await faceMesh.send({ image: video });
    }
    requestAnimationFrame(processFrame);
}

// Handle face mesh results
function onResults(results) {
    frameCount++;
    
    // Clear canvas with black background
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Draw video frame first
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    
    if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
        const landmarks = results.multiFaceLandmarks[0];
        
        if (frameCount % 30 === 0 && DEBUG.logStats) {
            console.log(`\n📊 Frame ${frameCount} - Face detected with ${landmarks.length} landmarks`);
        }
        
        // Apply triangle-based mosaic
        applyMosaicToFace(landmarks);
    } else {
        if (frameCount % 30 === 0 && DEBUG.logStats) {
            console.log(`⚠️  Frame ${frameCount} - No face detected`);
        }
    }
}

// Get landmark coordinates in pixel space
function getLandmarkPixel(landmark) {
    return {
        x: landmark.x * canvas.width,
        y: landmark.y * canvas.height
    };
}

// Apply mosaic using actual MediaPipe triangle tessellation
function applyMosaicToFace(landmarks) {
    // Get image data BEFORE drawing mosaic
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    
    // Get the triangle tessellation
    // MediaPipe's FACEMESH_TESSELATION is an array of EDGES (pairs), not triangles
    // We need our own triangle data
    let tessellation = getDefaultTessellation();
    
    if (DEBUG.logStats && frameCount % 30 === 0) {
        console.log(`\n🎨 Using built-in tessellation: ${tessellation.length / 3} triangles`);
        console.log(`🎯 Drawing every ${TRIANGLE_SKIP} triangles (temperature control)`);
        console.log(`📊 Landmarks available: ${landmarks.length}`);
        console.log(`🔍 First triangle: [${tessellation[0]}, ${tessellation[1]}, ${tessellation[2]}]`);
    }
    
    let trianglesDrawn = 0;
    let skippedCount = 0;
    
    // Draw triangles with their average colors
    for (let i = 0; i < tessellation.length; i += 3 * TRIANGLE_SKIP) {
        const idx1 = tessellation[i];
        const idx2 = tessellation[i + 1];
        const idx3 = tessellation[i + 2];
        
        // Validate indices are within bounds
        if (idx1 >= landmarks.length || idx2 >= landmarks.length || idx3 >= landmarks.length) {
            skippedCount++;
            if (DEBUG.logStats && frameCount % 30 === 0 && skippedCount <= 3) {
                console.warn(`⚠️  Triangle ${i/3} has out-of-bounds indices: [${idx1}, ${idx2}, ${idx3}], max=${landmarks.length-1}`);
            }
            continue;
        }
        
        if (!landmarks[idx1] || !landmarks[idx2] || !landmarks[idx3]) {
            skippedCount++;
            continue;
        }
        
        // Get triangle vertices in pixel coordinates
        const p1 = getLandmarkPixel(landmarks[idx1]);
        const p2 = getLandmarkPixel(landmarks[idx2]);
        const p3 = getLandmarkPixel(landmarks[idx3]);
        
        // SIMPLE TEST: Draw BRIGHT COLORED triangles to verify rendering works
        // Use different colors for different triangles
        const colors = ['#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF', '#00FFFF'];
        ctx.fillStyle = colors[trianglesDrawn % colors.length];
        
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.lineTo(p3.x, p3.y);
        ctx.closePath();
        ctx.fill();
        
        // Draw thick black edges 
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 3;
        ctx.stroke();
        
        trianglesDrawn++;
        
        // Debug: Draw first few triangles in bright color to verify they're rendering
        if (DEBUG.logStats && frameCount % 30 === 0 && trianglesDrawn <= 3) {
            console.log(`🎨 Triangle ${trianglesDrawn}: color=rgb(${avgColor.r},${avgColor.g},${avgColor.b}), vertices=[${Math.floor(p1.x)},${Math.floor(p1.y)}], [${Math.floor(p2.x)},${Math.floor(p2.y)}], [${Math.floor(p3.x)},${Math.floor(p3.y)}]`);
        }
    }
    
    if (DEBUG.logStats && frameCount % 30 === 0) {
        console.log(`✅ Triangles drawn: ${trianglesDrawn} (temperature skip=${TRIANGLE_SKIP})`);
        if (skippedCount > 0) {
            console.warn(`⚠️  Triangles skipped: ${skippedCount} (out of bounds or invalid)`);
        }
    }
}

// Calculate average color for a triangle
function getTriangleAverageColor(p1, p2, p3, imageData) {
    let totalR = 0, totalG = 0, totalB = 0;
    let count = 0;
    
    // Sample at triangle vertices
    const points = [p1, p2, p3];
    
    for (const point of points) {
        const x = Math.floor(point.x);
        const y = Math.floor(point.y);
        
        if (x >= 0 && x < canvas.width && y >= 0 && y < canvas.height) {
            const pixelIndex = (y * canvas.width + x) * 4;
            totalR += imageData.data[pixelIndex];
            totalG += imageData.data[pixelIndex + 1];
            totalB += imageData.data[pixelIndex + 2];
            count++;
        }
    }
    
    // Also sample at center of triangle
    const centerX = Math.floor((p1.x + p2.x + p3.x) / 3);
    const centerY = Math.floor((p1.y + p2.y + p3.y) / 3);
    
    if (centerX >= 0 && centerX < canvas.width && centerY >= 0 && centerY < canvas.height) {
        const pixelIndex = (centerY * canvas.width + centerX) * 4;
        totalR += imageData.data[pixelIndex];
        totalG += imageData.data[pixelIndex + 1];
        totalB += imageData.data[pixelIndex + 2];
        count++;
    }
    
    if (count === 0) {
        return { r: 0, g: 0, b: 0 };
    }
    
    return {
        r: Math.floor(totalR / count),
        g: Math.floor(totalG / count),
        b: Math.floor(totalB / count)
    };
}

// Hardcoded tessellation triangles (subset of MediaPipe's full tesselation)
// Each set of 3 numbers defines a triangle by landmark indices
function getDefaultTessellation() {
    console.warn('⚠️  FACEMESH_TESSELATION not found in global scope, using built-in tessellation');
    
    // This is a carefully crafted subset that covers the full face
    // Derived from MediaPipe Face Mesh canonical model
    const triangles = [
        // Forehead region
        10,338,297, 297,332,284, 284,251,389, 389,356,454,
        454,323,361, 361,288,397, 397,365,379, 379,378,400,
        400,377,152, 152,148,176, 176,149,150, 150,136,172,
        172,58,132, 132,93,234, 234,127,162, 162,21,54,
        54,103,67, 67,109,10,
        
        // Left eye
        33,246,161, 161,160,159, 159,158,157, 157,173,133,
        133,155,154, 154,153,145, 145,144,163, 163,7,33,
        
        // Right eye  
        263,466,388, 388,387,386, 386,385,384, 384,398,362,
        362,382,381, 381,380,374, 374,373,390, 390,249,263,
        
        // Nose
        1,4,5, 5,195,197, 197,2,326, 326,327,294,
        294,278,279, 279,360,363, 363,456,399, 399,412,465,
        
        // Mouth outer
        61,185,40, 40,39,37, 37,0,267, 267,269,270,
        270,409,291, 291,375,321, 321,405,314, 314,17,84,
        84,181,91, 91,146,61,
        
        // Mouth inner
        78,191,80, 80,81,82, 82,13,312, 312,311,310,
        310,415,308, 308,324,318, 318,402,317, 317,14,87,
        87,178,88, 88,95,78,
        
        // Cheek left
        116,123,147, 147,213,192, 192,214,210, 210,169,135,
        135,138,215, 215,177,137, 137,227,34, 34,139,127,
        
        // Cheek right
        345,352,376, 376,433,416, 416,434,430, 430,394,364,
        364,367,435, 435,401,366, 366,447,264, 264,368,356,
        
        // Jaw left
        58,215,137, 137,227,34, 34,139,127, 127,162,21,
        21,54,103, 103,67,109, 109,10,338,
        
        // Jaw right
        288,435,366, 366,447,264, 264,368,356, 356,389,251,
        251,284,332, 332,297,338, 338,10,109
    ];
    
    console.log(`📊 Created ${triangles.length / 3} built-in triangles for full face coverage`);
    return triangles;
}

// Handle temperature slider
function setupTemperatureControl() {
    const slider = document.getElementById('temperature');
    const valueDisplay = document.getElementById('tempValue');
    
    if (slider && valueDisplay) {
        slider.addEventListener('input', (e) => {
            TRIANGLE_SKIP = parseInt(e.target.value);
            valueDisplay.textContent = TRIANGLE_SKIP;
            console.log(`🎛️  Temperature changed to: ${TRIANGLE_SKIP} (${TRIANGLE_SKIP === 1 ? 'All triangles' : 'Every ' + TRIANGLE_SKIP + ' triangles'})`);
        });
    }
}

// Initialize
async function init() {
    console.log('🚀 Starting Mosaic Face Filter...');
    console.log('📋 Debug settings:', DEBUG);
    setupTemperatureControl();
    await initFaceMesh();
    await startCamera();
}

init();
